import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { encounter, patientAnamnesis } from "@odentia/db/schema/clinical"
import { clinicalFormAddendum, clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { markAllergiesReviewed } from "./allergies.js"
import { issuePersonalLink } from "./booking-links.js"
import {
  addFormAddendum,
  createFormResponse,
  createFormTemplate,
  finalizeFormResponse,
  listFormAddenda,
  listFormResponses,
  publishFormTemplate,
  updateFormResponseDraft,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addDeclaredHealth,
  allergiesSaidNoByPatient,
  getPatientHealth,
  markHealthDenied,
  savePatientHealth,
} from "./clinical.js"
import { ServiceError } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { getTimeline } from "./patient-history.js"
import { createPatient, patientPersonId } from "./patients.js"
import { submitQuestionnaireFromLink } from "./portal-questionnaire.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { submitPersonalLinkData } from "./su-enlace.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Lo que dijo el paciente se ve igual, no se toca y no desaparece (mesa del 13 nov):
 * lo que envió no lo edita el equipo (ni el servicio ni la base), se corrige aparte
 * antes o después de revisarlo, «Marcar como revisado» dice lo que pasó de verdad y
 * queda con quién y en qué atención; el embarazo se guarda con su fecha y su «No» no
 * se lee como «niega».
 */
setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

async function person(f: Fixture, given: string, surname: string) {
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: `${given} ${surname}`,
      givenNames: given,
      familyName: surname,
      phone: "+51987111222",
    }),
  )
  const personId = await f.run((tx) => patientPersonId(tx, ORG, created.id))
  if (!personId) throw new Error("Sin persona propia")
  return { patientId: created.id, personId }
}

/** Deja en uso un cuestionario del paciente; el anterior deja de ser el que le llega. */
async function questionnaire(f: Fixture, title: string, fields: Array<Record<string, unknown>>): Promise<void> {
  await ownerDb.execute(
    sql`update clinical_form_template set status = 'archivado' where organization_id = ${ORG} and status = 'publicado' and respondent = 'portal'`,
  )
  await f.run(async (tx) => {
    const draft = await createFormTemplate(tx, ORG, f.actor, {
      title,
      respondent: "portal",
      schema: { sections: [{ id: "antes", title: "Antes de tu cita", fields }] },
    })
    await publishFormTemplate(tx, ORG, f.actor, draft.id)
  })
}

/** La persona envía el cuestionario desde su enlace y devuelve la respuesta guardada. */
async function sent(f: Fixture, who: { patientId: string; personId: string }, answers: Record<string, unknown>) {
  await f.run((tx) =>
    submitQuestionnaireFromLink(tx, { orgId: ORG, patientId: who.patientId, contactId: who.personId }, answers),
  )
  const [row] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: who.patientId }))
  if (!row) throw new Error("Sin respuesta")
  return row
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ServiceError) return error.code
    throw error
  }
  return "OK"
}

const stored = async (id: string) =>
  (await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, id)))[0]!

const WHY = [
  { id: "motivo", label: "¿Por qué vienes a la consulta?", type: "texto_largo", required: true },
  { id: "anticoagulantes", label: "¿Tomas anticoagulantes o aspirina a diario?", type: "booleano" },
]

it("lo que envió el paciente no se edita: lo rechaza el servicio y lo rechaza la base", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Ríos")
  await questionnaire(f, "Cuestionario de salud", WHY)
  const response = await sent(f, marta, { motivo: "Me duele la muela de abajo", anticoagulantes: true })
  expect(response).toMatchObject({ source: "portal", status: "borrador", submittedVia: "enlace" })
  expect(response.submittedAt).toBeTruthy()

  // El servicio: guardar encima de lo que ella envió no es una edición de borrador.
  expect(
    await codeOf(
      f.run((tx) =>
        updateFormResponseDraft(tx, ORG, f.actor, response.id, {
          answers: { motivo: "Me duele la muela de abajo", anticoagulantes: false },
        }),
      ),
    ),
  ).toBe("DECLARED_READ_ONLY")
  // La base, aunque el servicio no mirara: con el rol de la aplicación y con el dueño.
  await expect(
    f.run((tx) =>
      tx
        .update(clinicalFormResponse)
        .set({ answers: { motivo: "Otra cosa", anticoagulantes: false } })
        .where(eq(clinicalFormResponse.id, response.id)),
    ),
  ).rejects.toThrow()
  await expect(
    ownerDb
      .update(clinicalFormResponse)
      .set({ submittedAt: new Date(), respondentContactId: null })
      .where(eq(clinicalFormResponse.id, response.id)),
  ).rejects.toThrow()
  expect((await stored(response.id)).answers).toEqual({ motivo: "Me duele la muela de abajo", anticoagulantes: true })
})

it("un borrador del paciente a medias tampoco lo edita el equipo, y no se finaliza lo que aún no envió", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Salas")
  await questionnaire(f, "Cuestionario a medias", WHY)
  const [template] = await ownerDb
    .select()
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.organizationId, ORG), eq(clinicalFormTemplate.status, "publicado"), eq(clinicalFormTemplate.respondent, "portal")))
  // El avance que guarda el portal mientras la persona sigue respondiendo: sin enviar.
  const [draft] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: ORG,
      templateId: template!.id,
      templateVersion: template!.version,
      templateTitle: template!.title,
      templateSnapshot: template!.schema as Record<string, unknown>,
      patientId: marta.patientId,
      status: "borrador",
      answers: { motivo: "Me du" },
      source: "portal",
      respondentContactId: marta.personId,
    })
    .returning()
  expect(
    await codeOf(
      f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, draft!.id, { answers: { motivo: "Dolor de muela" } })),
    ),
  ).toBe("DECLARED_READ_ONLY")
  expect(await codeOf(f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, draft!.id)))).toBe("NOT_SUBMITTED")
  expect(await codeOf(f.run((tx) => addFormAddendum(tx, ORG, f.actor, draft!.id, "No aplica")))).not.toBe("OK")
  expect(await stored(draft!.id)).toMatchObject({ status: "borrador", answers: { motivo: "Me du" } })
})

it("la corrección se agrega antes y después de revisar, queda aparte con quién y cuándo, y lo que dijo no cambia", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Vega")
  await questionnaire(f, "Cuestionario con corrección", WHY)
  const response = await sent(f, marta, { motivo: "Dolor al masticar", anticoagulantes: true })

  // Con la paciente delante, antes de darlo por revisado.
  const before = await f.run((tx) =>
    addFormAddendum(tx, ORG, f.actor, response.id, "Dice que ya no toma warfarina desde octubre: ahora apixabán 5 mg."),
  )
  expect(before).toMatchObject({ responseId: response.id, createdBy: f.actor })
  expect(before.createdAt).toBeInstanceOf(Date)
  expect(await stored(response.id)).toMatchObject({
    status: "borrador",
    answers: { motivo: "Dolor al masticar", anticoagulantes: true },
  })

  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, response.id))
  await f.run((tx) => addFormAddendum(tx, ORG, f.actor, response.id, "Confirmado con su cardióloga."))
  const addenda = await f.run((tx) => listFormAddenda(tx, ORG, response.id))
  expect(addenda.map((row) => row.text)).toEqual([
    "Dice que ya no toma warfarina desde octubre: ahora apixabán 5 mg.",
    "Confirmado con su cardióloga.",
  ])
  expect((await stored(response.id)).answers).toEqual({ motivo: "Dolor al masticar", anticoagulantes: true })
  // Las correcciones solo se agregan: la aplicación no las cambia.
  await expect(
    f.run((tx) => tx.update(clinicalFormAddendum).set({ text: "Otra" }).where(eq(clinicalFormAddendum.id, before.id))),
  ).rejects.toThrow()

  // Un borrador del equipo sigue como antes: se edita, y la adenda es para lo finalizado.
  const [staffTemplate] = await f.run(async (tx) => {
    const draft = await createFormTemplate(tx, ORG, f.actor, {
      title: "Evaluación del equipo con corrección",
      schema: { sections: [{ id: "eval", title: "Evaluación", fields: [{ id: "hallazgo", label: "Hallazgo", type: "texto" }] }] },
    })
    return [await publishFormTemplate(tx, ORG, f.actor, draft.id)]
  })
  const own = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: staffTemplate!.id, patientId: marta.patientId, answers: { hallazgo: "Caries" } }),
  )
  await f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, own.id, { answers: { hallazgo: "Caries profunda" } }))
  expect(await codeOf(f.run((tx) => addFormAddendum(tx, ORG, f.actor, own.id, "Nota")))).not.toBe("OK")
})

it("«Marcar como revisado» dice lo que pasó de verdad, guarda quién lo revisó y lo deja ligado a la atención", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Luna")
  const [attention] = await ownerDb
    .insert(encounter)
    .values({ organizationId: ORG, patientId: marta.patientId, professionalUserId: f.actor, reason: "Dolor" })
    .returning()

  // Sin pregunta de alergia en la plantilla, nada pasa a Antecedentes: se dice así.
  await questionnaire(f, "Cuestionario sin alergias", WHY)
  const plain = await sent(f, marta, { motivo: "Dolor de muela", anticoagulantes: true })
  const reviewed = await f.run((tx) =>
    finalizeFormResponse(tx, ORG, f.actor, plain.id, { encounterId: attention!.id }),
  )
  expect(reviewed).toMatchObject({
    status: "finalizado",
    finalizedBy: f.actor,
    encounterId: attention!.id,
    passedAllergies: [],
  })
  expect((await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))).allergies).toHaveLength(0)
  // Sigue en la lista de esa atención, con quién y cuándo.
  const inAttention = await f.run((tx) =>
    listFormResponses(tx, ORG, { patientId: marta.patientId, encounterId: attention!.id }),
  )
  expect(inAttention).toHaveLength(1)
  expect(inAttention[0]).toMatchObject({ id: plain.id, finalizedBy: f.actor, submittedVia: "enlace" })
  expect(inAttention[0]!.finalizedAt).toBeInstanceOf(Date)
  expect(inAttention[0]!.respondent).toMatchObject({ name: "Marta Luna", relationship: "self" })

  // Con una pregunta de alergia, lo que escribió pasa y el servicio dice qué pasó.
  const rosa = await person(f, "Rosa", "Luna")
  await questionnaire(f, "Cuestionario con alergias", [
    ...WHY,
    { id: "alergias", label: "¿A qué eres alérgica?", type: "texto_largo", definition: "AllergyIntolerance.code" },
  ])
  const withAllergy = await sent(f, rosa, { motivo: "Control", alergias: "Penicilina: ronchas\nNinguna" })
  const passed = await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, withAllergy.id))
  expect(passed.passedAllergies).toEqual(["Penicilina"])
  // Revisado fuera de una atención: no se inventa una, y la Historia lo trae con quién lo revisó.
  expect(passed.encounterId).toBeNull()
  const history = await f.run((tx) => getTimeline(tx, ORG, rosa.patientId, { types: ["form"] }))
  expect(history.data).toHaveLength(1)
  expect(history.data[0]).toMatchObject({
    type: "form",
    title: "Se completó el formulario: Cuestionario con alergias",
    detail: "Lo respondió la persona y lo revisó Clínico",
  })
  expect((await f.run((tx) => getPatientHealth(tx, ORG, rosa.patientId))).allergies.map((row) => row.substance)).toEqual([
    "Penicilina",
  ])
})

it("lo que la persona envió desde su enlace es su declaración original, y su «No» no es un «niega» del equipo", async () => {
  const f = await clinicalFixture()
  const thiago = await person(f, "Thiago", "Paz")
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: thiago.personId, patientId: thiago.patientId }, { secretsKey: KEY }),
  )
  const said = {
    allergies: { state: "none" as const, items: [] },
    conditions: { state: "none" as const, items: [] },
    medications: { state: "recorded" as const, items: [{ name: "Salbutamol" }] },
  }
  await f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1990-06-01" }, health: said }))

  const health = await f.run((tx) => getPatientHealth(tx, ORG, thiago.patientId))
  // «Ver declaración original»: lo que envió, como llegó, con cuándo y quién.
  expect(health.linkDeclaration).toMatchObject({ via: "enlace", respondent: "patient", health: said })
  expect(health.linkDeclaration?.at).toBeInstanceOf(Date)
  // Una sola marca: lo dijo la persona y nadie lo revisó, con su fecha.
  expect(health.reviewPending).toBe(true)
  expect(health.declared.at).toBeInstanceOf(Date)
  expect(health.declared.medications).toEqual(health.medications.map((row) => row.id))
  // El «No» lo dijo la persona: no es «niega · se le preguntó».
  expect(health.reviewStatus).toMatchObject({ allergies: "none", conditions: "none" })
  expect(health.declared.saidNo).toEqual({ allergies: true, conditions: true, medications: false })
  // Recepción ve solo la alergia: también para ella es «dijo que no», no «niega».
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, thiago.patientId))).toBe(true)

  // Cuando el equipo lo pregunta y lo revisa, pasa a ser su «niega».
  await f.run((tx) => markAllergiesReviewed(tx, ORG, f.actor, thiago.patientId))
  const afterAllergies = await f.run((tx) => getPatientHealth(tx, ORG, thiago.patientId))
  expect(afterAllergies.declared.saidNo.allergies).toBe(false)
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, thiago.patientId))).toBe(false)
  await f.run((tx) =>
    savePatientHealth(tx, ORG, f.actor, thiago.patientId, {
      expectedRevision: afterAllergies.revision,
      reviewStatus: { allergies: "none", conditions: "none", medications: "recorded" },
      conditions: [],
      medications: afterAllergies.medications.map((row) => ({ id: row.id, name: row.name })),
    }),
  )
  const reviewed = await f.run((tx) => getPatientHealth(tx, ORG, thiago.patientId))
  expect(reviewed.reviewPending).toBe(false)
  expect(reviewed.declared).toMatchObject({
    medications: [],
    saidNo: { allergies: false, conditions: false, medications: false },
  })
  // La declaración original no cambia aunque el equipo corrija lo vigente.
  expect(reviewed.linkDeclaration?.health).toEqual(said)

  // «Niega enfermedades» que anota el clínico en la atención nunca fue un «dijo que no».
  const lia = await person(f, "Lía", "Paz")
  await f.run((tx) => markHealthDenied(tx, ORG, f.actor, lia.patientId, ["conditions"]))
  const denied = await f.run((tx) => getPatientHealth(tx, ORG, lia.patientId))
  expect(denied.reviewStatus.conditions).toBe("none")
  expect(denied.declared.saidNo.conditions).toBe(false)
  expect(denied.linkDeclaration).toBeNull()
})

it("el embarazo declarado se guarda con el día en que se dijo, dice la semana de hoy y la fecha no cambia al editar otro dato", async () => {
  const f = await clinicalFixture()
  const lucero = await person(f, "Lucero", "Vega")
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucero.personId, patientId: lucero.patientId }, { secretsKey: KEY }),
  )
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1995-03-10" },
      health: {
        allergies: { state: "recorded", items: [{ substance: "Látex", severity: "desconocida" }] },
        personal: { embarazo: true, semanasEmbarazo: 30 },
      },
    }),
  )
  const today = await f.run((tx) => clinicToday(tx, ORG))
  const health = await f.run((tx) => getPatientHealth(tx, ORG, lucero.patientId))
  // La misma forma que ya guardaba latidIA: sí o no, el día en que se dijo y las semanas de ese día.
  expect(health.latestAnamnesis?.answers).toEqual({
    embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 30 } },
  })
  expect(health.pregnancy).toEqual({ state: "vigente", saidOn: today, weeksSaid: 30, weeksToday: 30 })
  expect(health.declared.pregnancy).toBe(true)
  expect(health.declared.allergies).toEqual(health.allergies.map((row) => row.id))

  // Lo dijo hace cuatro semanas (la que ya tenía ficha y se registró otra vez en línea): hoy son 34.
  const luz = await person(f, "Luz", "Vega")
  const monthAgo = new Date(Date.now() - 28 * 86_400_000)
  const saidOn = await f.run((tx) => clinicToday(tx, ORG, monthAgo))
  await f.run((tx) =>
    addDeclaredHealth(tx, ORG, f.actor, luz.patientId, { personal: { embarazo: true, semanasEmbarazo: 30 } }, {
      entity: "registration_hold",
      entityId: luz.patientId,
      at: monthAgo,
    }),
  )
  const later = await f.run((tx) => getPatientHealth(tx, ORG, luz.patientId))
  expect(later.pregnancy).toEqual({ state: "vigente", saidOn, weeksSaid: 30, weeksToday: 34 })

  // El equipo anota otra cosa de la entrevista: la fecha del embarazo sigue siendo la del día en que se dijo.
  await f.run((tx) =>
    savePatientHealth(tx, ORG, f.actor, luz.patientId, {
      expectedRevision: later.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
      conditions: [],
      medications: [],
      anamnesis: {
        expectedVersion: later.latestAnamnesis!.version,
        answers: {
          ...(later.latestAnamnesis!.answers as Record<string, unknown>),
          antecedentesPersonales: { cirugias: "Apendicectomía" },
        },
      },
    }),
  )
  const edited = await f.run((tx) => getPatientHealth(tx, ORG, luz.patientId))
  expect(edited.latestAnamnesis?.version).toBe(later.latestAnamnesis!.version + 1)
  expect(edited.latestAnamnesis?.answers).toEqual({
    antecedentesPersonales: { cirugias: "Apendicectomía" },
    embarazoLactancia: { embarazo: { estado: "si", fecha: saidOn, semanas: 30 } },
  })
  expect(edited.pregnancy).toEqual({ state: "vigente", saidOn, weeksSaid: 30, weeksToday: 34 })
  // Revisado por el equipo: ya no es «lo dijo ella, sin revisar», pero el embarazo sigue arriba.
  expect(later.declared.pregnancy).toBe(true)
  expect(edited.declared.pregnancy).toBe(false)

  // Sin la fecha no se guarda: no habría semana de hoy que decir.
  await expect(
    f.run((tx) =>
      savePatientHealth(tx, ORG, f.actor, luz.patientId, {
        expectedRevision: edited.revision,
        reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
        conditions: [],
        medications: [],
        anamnesis: {
          expectedVersion: edited.latestAnamnesis!.version,
          answers: { embarazoLactancia: { embarazo: { estado: "si", semanas: 31 } } },
        },
      }),
    ),
  ).rejects.toThrow(/fecha/)

  // Lo guardado antes, sin fecha: se sigue leyendo y pide confirmar.
  const ana = await person(f, "Ana", "Vega")
  await ownerDb.insert(patientAnamnesis).values({
    organizationId: ORG,
    patientId: ana.patientId,
    version: 1,
    answers: { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12 } },
    createdBy: f.actor,
  })
  const before = await f.run((tx) => getPatientHealth(tx, ORG, ana.patientId))
  expect(before.pregnancy).toEqual({ state: "por_confirmar", saidOn: null, weeksSaid: 12, weeksToday: null })
  const [kept] = await ownerDb
    .select()
    .from(patientAnamnesis)
    .where(eq(patientAnamnesis.patientId, ana.patientId))
    .orderBy(desc(patientAnamnesis.version))
  expect(kept?.answers).toEqual({ antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12 } })
})

it("lo finalizado antes de este cambio recibe quién lo finalizó y por dónde llegó, desde la auditoría", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Rojas")
  await questionnaire(f, "Cuestionario de antes", WHY)
  const response = await sent(f, marta, { motivo: "Control", anticoagulantes: false })
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, response.id))
  // Como estaban las filas antes: sin las dos columnas, con su rastro en la auditoría.
  const guard = sql.raw("ALTER TABLE public.clinical_form_response DISABLE TRIGGER clinical_form_response_immutable")
  await ownerDb.execute(guard)
  await ownerDb
    .update(clinicalFormResponse)
    .set({ finalizedBy: null, submittedVia: null })
    .where(eq(clinicalFormResponse.id, response.id))
  await ownerDb.execute(sql.raw("ALTER TABLE public.clinical_form_response ENABLE TRIGGER clinical_form_response_immutable"))
  expect(await stored(response.id)).toMatchObject({ finalizedBy: null, submittedVia: null })

  // El relleno de la migración, tal como está escrito en ella.
  const migration = readFileSync(
    fileURLToPath(new URL("../../db/drizzle/0112_lo_que_dijo_el_paciente_reglas.sql", import.meta.url)),
    "utf8",
  )
  const statements = migration.split("--> statement-breakpoint").map((part) => part.trim())
  const from = statements.findIndex((part) => part.includes("DISABLE TRIGGER clinical_form_response_immutable"))
  const to = statements.findIndex((part) => part.includes("ENABLE TRIGGER clinical_form_response_immutable"))
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  for (const statement of statements.slice(from, to + 1)) await ownerDb.execute(sql.raw(statement))

  expect(await stored(response.id)).toMatchObject({ finalizedBy: f.actor, submittedVia: "enlace", status: "finalizado" })
  // Y lo finalizado vuelve a quedar cerrado.
  await expect(
    ownerDb.update(clinicalFormResponse).set({ finalizedBy: null }).where(eq(clinicalFormResponse.id, response.id)),
  ).rejects.toThrow()
})
