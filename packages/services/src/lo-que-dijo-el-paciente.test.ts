import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { encounter, patientAnamnesis } from "@odentia/db/schema/clinical"
import { clinicalFormAddendum, clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { markAllergiesReviewed } from "./allergies.js"
import { issuePersonalLink } from "./booking-links.js"
import {
  addFormAddendum,
  createFormResponse,
  createFormTemplate,
  discardFormResponse,
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
import { createPatient, patientPersonId, setPatientContact } from "./patients.js"
import { submitQuestionnaireFromLink } from "./portal-questionnaire.js"
import { grantResponsibility } from "./responsibilities.js"
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

/**
 * El código de Postgres con que la base rechaza algo: `25001` es el disparador que cuida lo que
 * envió el paciente y lo finalizado; `42501`, que la aplicación no tiene permiso para esa escritura.
 */
async function pgCodeOf(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    for (let cause: unknown = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
      const code = (cause as { code?: unknown }).code
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code
    }
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
  expect(
    await pgCodeOf(
      f.run((tx) =>
        tx
          .update(clinicalFormResponse)
          .set({ answers: { motivo: "Otra cosa", anticoagulantes: false } })
          .where(eq(clinicalFormResponse.id, response.id)),
      ),
    ),
  ).toBe("25001")
  expect(
    await pgCodeOf(
      ownerDb
        .update(clinicalFormResponse)
        .set({ submittedAt: new Date(), respondentContactId: null })
        .where(eq(clinicalFormResponse.id, response.id)),
    ),
  ).toBe("25001")
  // Lo que hace el equipo al revisarlo sí pasa: la base cuida las respuestas, no traba la revisión.
  expect(
    await pgCodeOf(
      ownerDb.update(clinicalFormResponse).set({ updatedAt: new Date() }).where(eq(clinicalFormResponse.id, response.id)),
    ),
  ).toBe("OK")
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

  // Nada queda sin salida: lo que dejó a medias, o lo que envió repetido, se descarta con su motivo
  // (el servicio y la base lo permiten), y lo que dijo queda como estaba.
  await f.run((tx) => discardFormResponse(tx, ORG, f.actor, draft!.id, "Lo dejó a medias y ya vino a la consulta"))
  expect(await stored(draft!.id)).toMatchObject({ status: "descartado", discardedBy: f.actor, answers: { motivo: "Me du" } })
  const repeated = await sent(f, marta, { motivo: "Dolor de muela", anticoagulantes: false })
  expect(await codeOf(f.run((tx) => discardFormResponse(tx, ORG, f.actor, repeated.id, "")))).not.toBe("OK")
  await f.run((tx) => discardFormResponse(tx, ORG, f.actor, repeated.id, "Lo envió dos veces"))
  expect(await stored(repeated.id)).toMatchObject({
    status: "descartado",
    discardReason: "Lo envió dos veces",
    answers: { motivo: "Dolor de muela", anticoagulantes: false },
  })
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
  expect(
    await pgCodeOf(
      f.run((tx) => tx.update(clinicalFormAddendum).set({ text: "Otra" }).where(eq(clinicalFormAddendum.id, before.id))),
    ),
  ).toBe("42501")

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
  expect(inAttention[0]!.respondent).toEqual({ kind: "patient", name: "Marta Luna", relation: null })
  expect(inAttention[0]!.editedByTeamAt).toBeNull()

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
  expect(health.declarations).toHaveLength(1)
  expect(health.declarations[0]).toMatchObject({ via: "enlace", by: { kind: "patient" }, health: said })
  expect(health.declarations[0]!.at).toBeInstanceOf(Date)
  // Una sola marca: lo dijo la persona y nadie lo revisó, con su fecha.
  expect(health.reviewPending).toBe(true)
  expect(health.declared).toHaveLength(1)
  expect(health.declared[0]).toMatchObject({
    by: { kind: "patient", name: null, relation: null },
    medications: health.medications.map((row) => row.id),
    // El «No» lo dijo la persona: no es «niega · se le preguntó».
    saidNo: { allergies: true, conditions: true, medications: false },
  })
  expect(health.declared[0]!.at?.getTime()).toBe(health.declarations[0]!.at.getTime())
  expect(health.reviewStatus).toMatchObject({ allergies: "none", conditions: "none" })
  // Recepción ve solo la alergia: también para ella es «dijo que no», no «niega», y de quién.
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, thiago.patientId))).toMatchObject({
    by: { kind: "patient" },
  })

  // Cuando el equipo lo pregunta y lo revisa, pasa a ser su «niega».
  await f.run((tx) => markAllergiesReviewed(tx, ORG, f.actor, thiago.patientId))
  const afterAllergies = await f.run((tx) => getPatientHealth(tx, ORG, thiago.patientId))
  expect(afterAllergies.declared[0]?.saidNo).toEqual({ allergies: false, conditions: true, medications: false })
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, thiago.patientId))).toBeNull()
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
  expect(reviewed.declared).toEqual([])
  // La declaración original no cambia aunque el equipo corrija lo vigente.
  expect(reviewed.declarations[0]?.health).toEqual(said)

  // «Niega enfermedades» que anota el clínico en la atención nunca fue un «dijo que no».
  const lia = await person(f, "Lía", "Paz")
  await f.run((tx) => markHealthDenied(tx, ORG, f.actor, lia.patientId, ["conditions"]))
  const denied = await f.run((tx) => getPatientHealth(tx, ORG, lia.patientId))
  expect(denied.reviewStatus.conditions).toBe("none")
  expect(denied.declared).toEqual([])
  expect(denied.declarations).toEqual([])
})

it("la marca nombra a quien lo dijo, no a quien figura como representante ni al preferido", async () => {
  const f = await clinicalFixture()
  // Una paciente de 19 años cuya madre sigue como su representante: lo envía ella.
  const camila = await person(f, "Camila", "Soto")
  const [suMadre] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Elsa Soto" })
    .returning({ id: contact.id })
  await f.run((tx) =>
    setPatientContact(tx, ORG, f.actor, camila.patientId, {
      contactId: suMadre!.id,
      relationship: "guardian",
      kinship: "MTH",
      isPreferred: true,
    }),
  )
  const own = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: camila.personId, patientId: camila.patientId }, { secretsKey: KEY }),
  )
  const nineteen = `${new Date().getUTCFullYear() - 19}-01-15`
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, own.token, {
      data: { birthDate: nineteen },
      health: { medications: { state: "recorded", items: [{ name: "Isotretinoína" }] } },
    }),
  )
  const hers = await f.run((tx) => getPatientHealth(tx, ORG, camila.patientId))
  expect(hers.declared).toHaveLength(1)
  expect(hers.declared[0]?.by).toEqual({ kind: "patient", name: null, relation: null })

  // Un niño con padre (el preferido) y madre: lo llenó la madre desde su enlace.
  const nino = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Thiago Paz",
      givenNames: "Thiago",
      familyName: "Paz",
      birthDate: `${new Date().getUTCFullYear() - 6}-03-02`,
    }),
  )
  const [padre, madre] = await ownerDb
    .insert(contact)
    .values([
      { organizationId: ORG, displayName: "Luis Paz", phone: "+51987111301" },
      { organizationId: ORG, displayName: "Carla Paz Soto", phone: "+51987111302" },
    ])
    .returning({ id: contact.id })
  for (const [who, kinship, isPreferred] of [
    [padre!, "FTH", true],
    [madre!, "MTH", false],
  ] as const) {
    await f.run((tx) =>
      setPatientContact(tx, ORG, f.actor, nino.id, { contactId: who.id, relationship: "guardian", kinship, isPreferred }),
    )
    await f.run((tx) =>
      grantResponsibility(tx, ORG, f.actor, nino.id, { contactId: who.id, kind: "representante_legal", startsAt: "2020-01-01" }),
    )
  }
  const mothers = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: madre!.id, patientId: nino.id }, { secretsKey: KEY }),
  )
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, mothers.token, {
      data: {},
      health: {
        allergies: { state: "none", items: [] },
        conditions: { state: "recorded", items: [{ name: "Asma" }] },
      },
    }),
  )
  const his = await f.run((tx) => getPatientHealth(tx, ORG, nino.id))
  expect(his.declared).toHaveLength(1)
  expect(his.declared[0]).toMatchObject({
    by: { kind: "representative", name: "Carla Paz Soto", relation: "madre" },
    conditions: his.conditions.map((row) => row.id),
    saidNo: { allergies: true },
  })
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, nino.id))).toMatchObject({
    by: { kind: "representative", name: "Carla Paz Soto", relation: "madre" },
  })
  // Lo que se sabía ese día queda escrito: no cambia si después se corrige su vínculo.
  await f.run((tx) =>
    setPatientContact(tx, ORG, f.actor, nino.id, { contactId: madre!.id, relationship: "family", isPreferred: false }),
  )
  expect((await f.run((tx) => getPatientHealth(tx, ORG, nino.id))).declared[0]?.by).toEqual({
    kind: "representative",
    name: "Carla Paz Soto",
    relation: "madre",
  })
})

it("cada cosa conserva el día en que se dijo: las alergias de un cuestionario son del día en que lo envió, no del día en que se revisó", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Campos")
  // El 13 envió el cuestionario con su alergia (hace una semana); hoy completa su salud en su enlace.
  await questionnaire(f, "Cuestionario con su alergia", [
    ...WHY,
    { id: "alergias", label: "¿A qué eres alérgica?", type: "texto_largo", definition: "AllergyIntolerance.code" },
  ])
  const [template] = await ownerDb
    .select()
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.organizationId, ORG), eq(clinicalFormTemplate.status, "publicado"), eq(clinicalFormTemplate.respondent, "portal")))
  const sentAt = new Date(Date.now() - 7 * 86_400_000)
  const [response] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: ORG,
      templateId: template!.id,
      templateVersion: template!.version,
      templateTitle: template!.title,
      templateSnapshot: template!.schema as Record<string, unknown>,
      patientId: marta.patientId,
      status: "borrador",
      answers: { motivo: "Control", alergias: "Penicilina" },
      source: "portal",
      respondentContactId: marta.personId,
      submittedAt: sentAt,
      submittedVia: "enlace",
      createdAt: sentAt,
    })
    .returning()
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: marta.personId, patientId: marta.patientId }, { secretsKey: KEY }),
  )
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1960-06-01" },
      health: { medications: { state: "recorded", items: [{ name: "Warfarina" }] } },
    }),
  )
  // La doctora lo marca como revisado hoy: la alergia entra hoy, pero ella la dijo el 13.
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, response!.id))
  const health = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  expect(health.allergies.map((row) => row.substance)).toEqual(["Penicilina"])
  // Dos fechas, dos grupos: lo de hace una semana no sale como dicho hoy, ni lo de hoy como de entonces.
  expect(health.declared).toHaveLength(2)
  const [first, second] = health.declared
  expect(first).toMatchObject({ by: { kind: "patient" }, allergies: [health.allergies[0]!.id], medications: [] })
  expect(first!.at?.getTime()).toBe(sentAt.getTime())
  expect(second).toMatchObject({ by: { kind: "patient" }, allergies: [], medications: [health.medications[0]!.id] })
  expect(Date.now() - (second!.at?.getTime() ?? 0)).toBeLessThan(60_000)
  // El detalle del cuestionario nombra a la misma persona que la marca.
  const [listed] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: marta.patientId }))
  expect(listed?.respondent).toMatchObject({ kind: first!.by.kind, name: "Marta Campos" })
})

it("lo que el equipo cambió antes de este cambio no se presenta como intacto", async () => {
  const f = await clinicalFixture()
  const marta = await person(f, "Marta", "Quiroz")
  const otra = await person(f, "Rosa", "Quiroz")
  await questionnaire(f, "Cuestionario ya editado", WHY)
  const touched = await sent(f, marta, { motivo: "Dolor", anticoagulantes: true })
  const intact = await sent(f, otra, { motivo: "Control", anticoagulantes: false })
  // Como quedó en la auditoría cuando aún se podía editar: un guardado del equipo después del envío.
  const editedAt = new Date(touched.submittedAt!.getTime() + 120_000)
  await ownerDb.insert(auditEvent).values({
    organizationId: ORG,
    actorUserId: f.actor,
    action: "form_response.update",
    entity: "clinical_form_response",
    entityId: touched.id,
    metadata: {},
    createdAt: editedAt,
  })
  const [after] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: marta.patientId }))
  expect(after?.editedByTeamAt?.getTime()).toBe(editedAt.getTime())
  const [clean] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: otra.patientId }))
  expect(clean).toMatchObject({ id: intact.id, editedByTeamAt: null })
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
  expect(health.declared).toHaveLength(1)
  expect(health.declared[0]).toMatchObject({
    by: { kind: "patient" },
    pregnancy: true,
    allergies: health.allergies.map((row) => row.id),
  })

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
  expect(later.declared.some((group) => group.pregnancy)).toBe(true)
  expect(edited.declared).toEqual([])

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

  // Lo guardado antes, sin fecha: toma la del día en que se anotó ese «sí» (su primera versión con él) y
  // no pierde la alerta; las versiones guardadas no se reescriben.
  const ana = await person(f, "Ana", "Vega")
  const noted = new Date(Date.now() - 14 * 86_400_000)
  const notedOn = await f.run((tx) => clinicToday(tx, ORG, noted))
  await ownerDb.insert(patientAnamnesis).values([
    {
      organizationId: ORG,
      patientId: ana.patientId,
      version: 1,
      answers: { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12 } },
      createdBy: f.actor,
      createdAt: noted,
    },
    {
      // Después alguien anotó otra cosa: el «sí» y sus semanas siguen siendo los de la primera.
      organizationId: ORG,
      patientId: ana.patientId,
      version: 2,
      answers: { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12, cirugias: "Apendicectomía" } },
      createdBy: f.actor,
      createdAt: new Date(Date.now() - 86_400_000),
    },
  ])
  const before = await f.run((tx) => getPatientHealth(tx, ORG, ana.patientId))
  expect(before.pregnancy).toEqual({ state: "vigente", saidOn: notedOn, weeksSaid: 12, weeksToday: 14 })
  const kept = await ownerDb
    .select({ answers: patientAnamnesis.answers })
    .from(patientAnamnesis)
    .where(eq(patientAnamnesis.patientId, ana.patientId))
    .orderBy(desc(patientAnamnesis.version))
  expect(kept.map((row) => row.answers)).toEqual([
    { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12, cirugias: "Apendicectomía" } },
    { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 12 } },
  ])
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
  expect(
    await pgCodeOf(
      ownerDb.update(clinicalFormResponse).set({ finalizedBy: null }).where(eq(clinicalFormResponse.id, response.id)),
    ),
  ).toBe("25001")
})
