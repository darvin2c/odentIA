/**
 * Formularios de la clínica (mesa del 13 nov): dejar de usar uno y volver a
 * usarlo, que uno nuevo no nazca como versión de otro, los bordes del servidor
 * al responder y que nada de esto trabe la atención: el formulario empezado
 * antes de firmar se termina después, y el cierre lo avisa sin frenar.
 */
import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  archiveFormTemplate,
  createFormResponse,
  createFormTemplate,
  discardFormResponse,
  finalizeFormResponse,
  listFormResponses,
  listFormTemplates,
  publishFormTemplate,
  reuseFormTemplate,
  updateFormResponseDraft,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createEncounter, finalizeEncounter, getEncounterClosing, voidEncounter } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
import { listClinicFormTemplates, previewPatientQuestionnaire } from "./portal-questionnaire.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { listWorkspaceAudit } from "./workspace.js"

setupTestDb()

const ORG = "org_a"

const schema = {
  sections: [
    {
      id: "evaluacion",
      title: "Evaluación",
      fields: [
        { id: "fecha", label: "Fecha de evaluación", type: "fecha" },
        { id: "intensidad", label: "Intensidad", type: "numero", min: 0, max: 10 },
        { id: "dolor", label: "Dolor", type: "escala", min: 0, max: 10 },
        { id: "hallazgos", label: "Hallazgos", type: "texto_largo" },
        { id: "pieza", label: "Pieza", type: "pieza" },
      ],
    },
  ],
}

/** Una plantilla ya en uso, con su título. */
async function inUse(f: Awaited<ReturnType<typeof clinicalFixture>>, title: string, respondent?: "staff" | "portal") {
  return f.run(async (tx) => {
    const draft = await createFormTemplate(tx, ORG, f.actor, { title, schema, ...(respondent ? { respondent } : {}) })
    return publishFormTemplate(tx, ORG, f.actor, draft.id)
  })
}

it("un formulario nuevo no nace como versión de otro, aunque el título sea igual o empiece igual", async () => {
  const f = await clinicalFixture()
  // Los primeros 40 caracteres son los mismos: antes compartían la clave.
  const menores = await inUse(f, "Historia de odontopediatría para menores de seis años")
  const adolescentes = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, { title: "Historia de odontopediatría para menores adolescentes", schema }),
  )
  expect(adolescentes.version).toBe(1)
  expect(adolescentes.key).not.toBe(menores.key)
  // Con un borrador de la primera abierto, la segunda tampoco choca con él.
  const borrador = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, { key: menores.key, title: menores.title, schema }),
  )
  expect(borrador.version).toBe(2)
  const otra = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, { title: "Historia de odontopediatría para menores de seis años", schema }),
  )
  expect(otra).toMatchObject({ version: 1, status: "borrador" })
  expect(new Set([menores.key, adolescentes.key, otra.key]).size).toBe(3)
  // Publicar la nueva no archiva a la que ya estaba en uso.
  await f.run((tx) => publishFormTemplate(tx, ORG, f.actor, adolescentes.id))
  const published = await f.run((tx) => listFormTemplates(tx, ORG, { status: "publicado" }))
  expect(published.map((row) => row.id)).toEqual(expect.arrayContaining([menores.id, adolescentes.id]))
  // La versión siguiente de una plantilla sigue naciendo con su clave.
  await expect(
    f.run((tx) => createFormTemplate(tx, ORG, f.actor, { key: menores.key, title: "Otra", schema })),
  ).rejects.toMatchObject({ code: "DRAFT_EXISTS" })
})

it("apagar una ficha deja de ofrecerla y encenderla vuelve a usar la misma versión, sin crear otra", async () => {
  const f = await clinicalFixture()
  const periodontal = await inUse(f, "Ficha periodontal de prueba")
  const llenado = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: periodontal.id, patientId: f.patient.id, answers: { hallazgos: "Bolsa de 5 mm" } }),
  )
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, llenado.id))

  // «Sin usar»: la misma versión, publicada y apagada.
  const left = await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, periodontal.id))
  expect(left).toMatchObject({ id: periodontal.id, status: "publicado", inUse: false, version: 1 })
  const offered = await f.run((tx) => listFormTemplates(tx, ORG, { status: "publicado" }))
  expect(offered.some((row) => row.key === periodontal.key)).toBe(false)
  // Configuración la sigue viendo, apagada.
  const all = await f.run((tx) => listFormTemplates(tx, ORG, {}))
  expect(all.find((row) => row.id === periodontal.id)).toMatchObject({ status: "publicado", inUse: false })
  // Ya no se empieza una nueva con ella.
  await expect(
    f.run((tx) => createFormResponse(tx, ORG, f.actor, { templateId: periodontal.id, patientId: f.patient.id })),
  ).rejects.toMatchObject({ status: 400 })

  // «En uso» otra vez: la misma versión, sin una nueva.
  const back = await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, periodontal.id))
  expect(back).toMatchObject({ id: periodontal.id, key: periodontal.key, version: 1, status: "publicado", inUse: true })
  expect((await f.run((tx) => listFormTemplates(tx, ORG, {}))).filter((row) => row.key === periodontal.key)).toHaveLength(1)
  // Lo ya llenado conserva sus preguntas.
  const [kept] = await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, llenado.id))
  expect(kept).toMatchObject({ status: "finalizado", templateVersion: 1, answers: { hallazgos: "Bolsa de 5 mm" } })
  const [trace] = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "form_template.reuse"), eq(auditEvent.entityId, back.id)))
  expect(trace?.metadata).toMatchObject({ key: periodontal.key, version: 1, from: 1 })

  // En uso: no se vuelve a encender dos veces.
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, periodontal.id))).rejects.toMatchObject({ status: 409 })
  // Un borrador que se archivó nunca estuvo en uso: no hay a qué volver.
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Borrador que no se usó", schema }))
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, draft.id))
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, draft.id))).rejects.toMatchObject({ status: 409 })
  // Apagada con un borrador preparado: se enciende igual, y el borrador sigue ahí.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, back.id))
  const pending = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { key: back.key, title: back.title, schema }))
  expect(await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, back.id))).toMatchObject({ id: back.id, inUse: true })
  expect((await f.run((tx) => listFormTemplates(tx, ORG, {}))).find((row) => row.id === pending.id)?.status).toBe("borrador")
  await expect(
    f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, "00000000-0000-4000-8000-000000000000")),
  ).rejects.toMatchObject({ status: 404 })
})

it("publicar la versión siguiente de una ficha apagada la deja apagada; una que se dejó de usar antes del interruptor vuelve como versión nueva", async () => {
  const f = await clinicalFixture()
  const off = await inUse(f, "Ficha apagada con versión nueva")
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, off.id))
  const next = await f.run(async (tx) => {
    const draft = await createFormTemplate(tx, ORG, f.actor, { key: off.key, title: off.title, schema })
    return publishFormTemplate(tx, ORG, f.actor, draft.id)
  })
  expect(next).toMatchObject({ version: 2, status: "publicado", inUse: false })

  // Antes del interruptor, dejar de usar archivaba la versión: de ahí no se sale, y nace la siguiente.
  const legacy = await inUse(f, "Ficha dejada de usar antes del interruptor")
  await ownerDb.update(clinicalFormTemplate).set({ status: "archivado" }).where(eq(clinicalFormTemplate.id, legacy.id))
  const revived = await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, legacy.id))
  expect(revived).toMatchObject({ key: legacy.key, version: 2, status: "publicado", inUse: true })
})

it("la base deja apagar y encender la versión publicada sin tocar nada más, y nada de una archivada", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Ficha que la base protege")
  await ownerDb.update(clinicalFormTemplate).set({ inUse: false }).where(eq(clinicalFormTemplate.id, template.id))
  await expect(
    ownerDb.update(clinicalFormTemplate).set({ inUse: true, title: "Otro título" }).where(eq(clinicalFormTemplate.id, template.id)),
  ).rejects.toMatchObject({ cause: { code: "25001" } })
  await ownerDb.update(clinicalFormTemplate).set({ status: "archivado" }).where(eq(clinicalFormTemplate.id, template.id))
  await expect(
    ownerDb.update(clinicalFormTemplate).set({ inUse: true }).where(eq(clinicalFormTemplate.id, template.id)),
  ).rejects.toMatchObject({ cause: { code: "25001" } })
})

it("el servidor rechaza una fecha imposible y un valor que no es del tipo de la pregunta", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación de bordes")
  const response = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id }),
  )
  const save = (answers: Record<string, unknown>) =>
    f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, response.id, { answers }))
  // El borrador se guarda por partes (entrega 3): lo que no vale no se guarda y vuelve en
  // `rejected`, dicho en su pregunta, sin frenar a las demás ni pisar lo que había.
  const refused = async (answers: Record<string, unknown>, id: string, words: string) => {
    const result = await save(answers)
    expect(result.rejected[`answers.${id}`]).toEqual(expect.stringContaining(words))
    expect((result.answers as Record<string, unknown>)[id] ?? null).toBeNull()
  }
  await refused({ fecha: "2026-02-31" }, "fecha", "Esa fecha no existe")
  await refused({ fecha: "2026-13-01" }, "fecha", "Esa fecha no existe")
  await refused({ intensidad: true }, "intensidad", "Escribe un número")
  await refused({ dolor: true }, "dolor", "Va de 0 a 10")
  await refused({ intensidad: [7] }, "intensidad", "Escribe un número")
  // Lo que sí es de su tipo se guarda: el 29 de febrero de un año bisiesto existe.
  const saved = await save({ fecha: "2028-02-29", intensidad: 7, dolor: "4" })
  expect(saved.answers).toMatchObject({ fecha: "2028-02-29", intensidad: 7, dolor: 4 })
})

it("dos «Empezar» seguidos del mismo formulario no dejan dos borradores", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación repetida")
  const start = () =>
    f.run((tx) =>
      createFormResponse(tx, ORG, f.actor, {
        templateId: template.id,
        patientId: f.patient.id,
        encounterId: f.encounter.id,
        answers: {},
      }),
    )
  const first = await start()
  const second = await start()
  expect(second.id).toBe(first.id)
  // A la vez (doble clic que llega dos veces): también uno solo.
  const other = await inUse(f, "Evaluación a la vez")
  const together = await Promise.all(
    [1, 2, 3].map(() =>
      f.run((tx) =>
        createFormResponse(tx, ORG, f.actor, { templateId: other.id, patientId: f.patient.id, encounterId: f.encounter.id }),
      ),
    ),
  )
  expect(new Set(together.map((row) => row.id)).size).toBe(1)
  const drafts = await ownerDb
    .select({ id: clinicalFormResponse.id, templateId: clinicalFormResponse.templateId })
    .from(clinicalFormResponse)
    .where(eq(clinicalFormResponse.patientId, f.patient.id))
  expect(drafts.filter((row) => row.templateId === template.id)).toHaveLength(1)
  expect(drafts.filter((row) => row.templateId === other.id)).toHaveLength(1)
  // Uno que ya tiene algo escrito no es el mismo: se puede llenar otro (otra pieza, otro momento).
  await f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, first.id, { answers: { hallazgos: "Pieza 16" } }))
  const another = await start()
  expect(another.id).not.toBe(first.id)
})

it("el equipo no crea una respuesta con un formulario que responde el paciente", async () => {
  const f = await clinicalFixture()
  const questionnaire = await inUse(f, "Cuestionario del paciente de prueba", "portal")
  await expect(
    f.run((tx) => createFormResponse(tx, ORG, f.actor, { templateId: questionnaire.id, patientId: f.patient.id })),
  ).rejects.toMatchObject({ status: 400, fields: { templateId: expect.any(String) } })
})

it("la lista dice cuál de los cuestionarios del paciente es el que le llega", async () => {
  const f = await clinicalFixture()
  const first = await inUse(f, "Cuestionario previo de la lista", "portal")
  const staff = await inUse(f, "Ficha del equipo de la lista")
  const second = await inUse(f, "Cuestionario de salud de la lista", "portal")
  const reach = async () =>
    new Map((await f.run((tx) => listClinicFormTemplates(tx, ORG))).map((row) => [row.id, row.reachesPatients]))
  let marks = await reach()
  // Los dos siguen publicados, pero a los pacientes les llega solo el último.
  expect(marks.get(second.id)).toBe(true)
  expect(marks.get(first.id)).toBe(false)
  expect(marks.get(staff.id)).toBe(false)
  // Al dejar de usar el último, vuelve a llegar el anterior.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, second.id))
  marks = await reach()
  expect(marks.get(first.id)).toBe(true)
  expect(marks.get(second.id)).toBe(false)
  // Lo deja como estaba: otras pruebas del archivo no dependen de un cuestionario del paciente.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, first.id))
})

it("un formulario empezado antes de firmar la atención se termina después, y el cierre lo avisa sin frenar", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación que queda a medias")
  const draft = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id }),
  )
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  // Avisa, no frena: el cierre sigue listo.
  expect(closing.ready).toBe(true)
  expect(closing.openForms).toEqual([{ id: draft.id, title: "Evaluación que queda a medias" }])
  const signed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(signed.encounter.status).toBe("finalizada")
  const [trace] = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "encounter.finalized"), eq(auditEvent.entityId, f.encounter.id)))
  // La constancia de que se firmó con un formulario a medias.
  expect(trace?.metadata).toMatchObject({ openForms: 1 })

  // Firmada la atención, el formulario se sigue llenando y se finaliza con su propia fecha.
  const saved = await f.run((tx) =>
    updateFormResponseDraft(tx, ORG, f.actor, draft.id, { answers: { hallazgos: "Percusión positiva" } }),
  )
  expect(saved.answers).toMatchObject({ hallazgos: "Percusión positiva" })
  const done = await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, draft.id))
  expect(done).toMatchObject({ status: "finalizado", encounterId: f.encounter.id })
  expect(done.finalizedAt!.getTime()).toBeGreaterThan(signed.encounter.finalizedAt!.getTime())

  // Lo que no se puede es empezar uno nuevo sobre la atención ya firmada: se empieza desde Documentos.
  await expect(
    f.run((tx) =>
      createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id }),
    ),
  ).rejects.toMatchObject({ code: "ENCOUNTER_CLOSED", status: 409, message: expect.stringContaining("ya está firmada") })
  await expect(
    f.run((tx) => createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id })),
  ).resolves.toMatchObject({ status: "borrador", encounterId: null })
  // Tampoco sobre una anulada.
  const voided = await f.run(async (tx) => {
    const visit = await createEncounter(tx, ...f.args, { reason: "Se abrió por error" })
    return voidEncounter(tx, ...f.args, visit.id, { reason: "Paciente equivocado" })
  })
  expect(voided.status).toBe("anulada")
  await expect(
    f.run((tx) =>
      createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: voided.id }),
    ),
    // Una atención anulada no se dice «cerrada» ni «firmada».
  ).rejects.toMatchObject({ code: "ENCOUNTER_CLOSED", status: 409, message: expect.stringContaining("está anulada") })
})

it("el borrador vacío de otra persona, o el de hace semanas, no es «el mismo»: se empieza uno nuevo", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación de otra persona")
  // La Dra. B, otra persona del equipo.
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Dra. B", email: `${other}@example.test` })
  const start = (actor: string) =>
    f.run((tx) =>
      createFormResponse(tx, ORG, actor, {
        templateId: template.id,
        patientId: f.patient.id,
        professionalUserId: f.actor,
        answers: {},
      }),
    )
  const ofA = await start(f.actor)
  // Otra persona empieza la misma, vacía y recién creada: recibe la suya, con su autoría.
  const ofB = await start(other)
  expect(ofB.id).not.toBe(ofA.id)
  expect(ofB.authorUserId).toBe(other)
  expect(ofA.authorUserId).toBe(f.actor)
  // La de A quedó vacía hace tres semanas: hoy A empieza otra, con la fecha de hoy.
  await ownerDb
    .update(clinicalFormResponse)
    .set({ createdAt: new Date(Date.now() - 21 * 24 * 3600_000) })
    .where(eq(clinicalFormResponse.id, ofA.id))
  const today = await start(f.actor)
  expect(today.id).not.toBe(ofA.id)
  expect(Date.now() - today.createdAt.getTime()).toBeLessThan(60_000)
  // Y el doble clic de la misma persona sigue siendo uno solo.
  expect((await start(f.actor)).id).toBe(today.id)
})

it("dos «Volver a usar» a la vez: uno lo pone en uso y el otro recibe que ya está en uso, no un error interno", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Ficha que vuelve dos veces")
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, template.id))
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, template.id))),
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  expect(rejected).toHaveLength(2)
  for (const reason of rejected) expect(reason).toMatchObject({ status: 409 })
  // La misma versión, encendida una sola vez.
  const versions = (await f.run((tx) => listFormTemplates(tx, ORG, {}))).filter((row) => row.key === template.key)
  expect(versions.map((row) => `${row.version}:${row.status}:${row.inUse}`)).toEqual(["1:publicado:true"])
})

it("volver a usar revisa las preguntas como al publicar: si ya no valen, lo dice y no pone en uso algo que no se puede llenar", async () => {
  const f = await clinicalFixture()
  // Quedó archivada con una pregunta de opciones que hoy no se puede publicar (una sola opción).
  const [old] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({
      organizationId: ORG,
      key: "ficha-con-reglas-de-antes",
      title: "Ficha con reglas de antes",
      version: 1,
      status: "archivado",
      schema: {
        sections: [{ id: "s", title: "S", fields: [{ id: "lado", label: "Lado", type: "opcion_unica", options: ["Derecho"] }] }],
      },
      respondent: "staff",
      publishedAt: new Date(Date.now() - 90 * 24 * 3600_000),
    })
    .returning()
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, old!.id))).rejects.toMatchObject({
    code: "SCHEMA_OUTDATED",
    status: 409,
    message: expect.stringMatching(/«Ficha con reglas de antes».*Lado.*versión nueva/s),
  })
  const versions = (await f.run((tx) => listFormTemplates(tx, ORG, {}))).filter((row) => row.key === old!.key)
  expect(versions.map((row) => row.status)).toEqual(["archivado"])
  // La salida: una versión nueva desde esa, corregida, se guarda y se publica.
  const fixed = await f.run(async (tx) => {
    const draft = await createFormTemplate(tx, ORG, f.actor, {
      key: old!.key,
      title: old!.title,
      schema: { sections: [{ id: "s", title: "S", fields: [{ id: "lado", label: "Lado", type: "opcion_unica", options: ["Derecho", "Izquierdo"] }] }] },
    })
    return publishFormTemplate(tx, ORG, f.actor, draft.id)
  })
  expect(fixed).toMatchObject({ version: 2, status: "publicado" })
})

it("«Dejar de usar» y archivar un borrador quedan anotados como cosas distintas", async () => {
  const f = await clinicalFixture()
  const used = await inUse(f, "Ficha que se deja de usar (rastro)")
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, used.id))
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Borrador que se archiva (rastro)", schema }))
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, draft.id))
  const actionOf = async (id: string) =>
    (
      await ownerDb
        .select({ action: auditEvent.action })
        .from(auditEvent)
        .where(and(eq(auditEvent.entity, "clinical_form_template"), eq(auditEvent.entityId, id)))
    )
      .map((row) => row.action)
      .filter((action) => action.startsWith("form_template.") && !["form_template.create", "form_template.publish"].includes(action))
  expect(await actionOf(used.id)).toEqual(["form_template.leave"])
  expect(await actionOf(draft.id)).toEqual(["form_template.archive"])
})

it("antes de publicar, dejar de usar o volver a usar, el servidor dice qué cuestionario reciben los pacientes hoy y cuál recibirán", async () => {
  const f = await clinicalFixture()
  const preview = (id: string, change: "publish" | "leave" | "reuse") =>
    f.run((tx) => previewPatientQuestionnaire(tx, ORG, id, change))
  // Parte sin ningún cuestionario del paciente publicado: los de las pruebas de arriba se dejan de usar.
  for (const row of await f.run((tx) => listFormTemplates(tx, ORG, { status: "publicado" })))
    if (row.respondent === "portal") await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, row.id))
  // (a) La versión 1 la llenaba el equipo y nadie recibe nada: la 2, del paciente, no reemplaza a ninguno.
  const ingreso = await inUse(f, "Ficha de ingreso (a quién le llega)")
  const ingresoV2 = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, { key: ingreso.key, title: ingreso.title, respondent: "portal", schema }),
  )
  expect(await preview(ingresoV2.id, "publish")).toEqual({
    now: null,
    after: { key: ingreso.key, title: ingreso.title },
  })
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, ingresoV2.id))

  const previo = await inUse(f, "Cuestionario previo (a quién le llega)", "portal")
  const salud = await inUse(f, "Cuestionario de salud (a quién le llega)", "portal")
  const named = (row: { key: string; title: string }) => ({ key: row.key, title: row.title })
  // (b) La versión nueva de «salud» pasa al equipo: los pacientes pasan a recibir «previo», que sigue publicado.
  const saludV2 = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, { key: salud.key, title: salud.title, respondent: "staff", schema }),
  )
  expect(await preview(saludV2.id, "publish")).toEqual({ now: named(salud), after: named(previo) })
  // Dejar de usar el que les llega: después reciben el otro; dejar el otro no les cambia nada.
  expect(await preview(salud.id, "leave")).toEqual({ now: named(salud), after: named(previo) })
  expect(await preview(previo.id, "leave")).toEqual({ now: named(salud), after: named(salud) })
  // Y lo que anuncia es lo que pasa.
  await f.run((tx) => publishFormTemplate(tx, ORG, f.actor, saludV2.id))
  const marks = new Map((await f.run((tx) => listClinicFormTemplates(tx, ORG))).map((row) => [row.id, row.reachesPatients]))
  expect(marks.get(previo.id)).toBe(true)
  // Volver a usar uno del paciente lo deja como el que les llega.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, previo.id))
  expect(await preview(previo.id, "reuse")).toEqual({ now: null, after: named(previo) })
  await expect(preview("00000000-0000-4000-8000-000000000000", "publish")).rejects.toMatchObject({ status: 404 })
})

it("dos «Dejar de usar» a la vez: uno lo deja y el otro recibe que ya no se usa, no un error interno", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Ficha que se deja dos veces")
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, template.id))),
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  for (const result of results)
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "ARCHIVED", status: 409 })
  // Y un borrador que se archiva dos veces, igual.
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Borrador que se archiva dos veces", schema }))
  const again = await Promise.allSettled([1, 2].map(() => f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, draft.id))))
  expect(again.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  for (const result of again)
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "ARCHIVED", status: 409 })
})

it("anular la atención descarta sus formularios a medias con el motivo de la anulación; lo ya finalizado se conserva", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación de una atención que se anula")
  const start = (answers: Record<string, unknown>) =>
    f.run((tx) =>
      createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id, answers }),
    )
  const finished = await start({ hallazgos: "Percusión negativa" })
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, finished.id))
  const halfway = await start({ hallazgos: "Anotado para otra persona" })
  // Uno suelto de la misma persona, sin atención: anularla no lo toca.
  const loose = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, answers: { hallazgos: "Suelto" } }),
  )
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Se abrió para el paciente equivocado" }))
  const byId = new Map(
    (await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.patientId, f.patient.id))).map((row) => [row.id, row]),
  )
  // Nada se borra: el borrador queda descartado, con quién, cuándo y por qué.
  expect(byId.get(halfway.id)).toMatchObject({
    status: "descartado",
    discardedBy: f.actor,
    discardReason: "Atención anulada: Se abrió para el paciente equivocado",
    answers: { hallazgos: "Anotado para otra persona" },
  })
  expect(byId.get(halfway.id)?.discardedAt).toBeInstanceOf(Date)
  expect(byId.get(finished.id)).toMatchObject({ status: "finalizado", encounterId: f.encounter.id })
  expect(byId.get(loose.id)).toMatchObject({ status: "borrador" })
  // Descartado ya no se llena ni se finaliza.
  await expect(f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, halfway.id))).rejects.toMatchObject({ status: 409 })
  const [trace] = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "form_response.discard"), eq(auditEvent.entityId, halfway.id)))
  expect(trace?.metadata).toMatchObject({ encounterId: f.encounter.id })
})

it("los rechazos al empezar o llenar un formulario se dicen con palabras de la persona", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación con mensajes claros")
  const response = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id }),
  )
  // Un sí/no donde va una pieza: se dice qué va ahí, no «inválida: true».
  // Guardado por partes (entrega 3): no frena lo demás y se dice en su pregunta.
  const saved = await f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, response.id, { answers: { pieza: true } }))
  expect(saved.rejected["answers.pieza"]).toEqual(expect.stringContaining('"Pieza" debe ser el número de una pieza'))
  const start = (templateId: string) =>
    f.run((tx) => createFormResponse(tx, ORG, f.actor, { templateId, patientId: f.patient.id }))
  // Uno que ya no se usa.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, template.id))
  await expect(start(template.id)).rejects.toMatchObject({
    status: 400,
    fields: { templateId: "Esta ficha ya no se usa: elige otra, o vuelve a usarla desde Configuración" },
  })
  // Uno que todavía es un borrador.
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Borrador con mensajes claros", schema }))
  await expect(start(draft.id)).rejects.toMatchObject({
    status: 400,
    fields: { templateId: "Esta ficha aún es un borrador: publícala para empezar a llenarla" },
  })
})

it("«Actividad del equipo» dice de qué formulario se trata al publicarlo, dejarlo de usar y volver a usarlo", async () => {
  const f = await clinicalFixture()
  // Crear y publicar en dos pasos, como en la pantalla: cada uno es su fila.
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Ficha con nombre en la actividad", schema }))
  const template = await f.run((tx) => publishFormTemplate(tx, ORG, f.actor, draft.id))
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, template.id))
  const back = await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, template.id))
  const { items } = await f.run((tx) => listWorkspaceAudit(tx, ORG, { area: "configuracion" }))
  const about = (id: string, action: string) => items.find((item) => item.entityId === id && item.action === action)
  expect(about(template.id, "form_template.publish")).toMatchObject({
    what: "Publicó una versión de una ficha de consulta",
    about: "«Ficha con nombre en la actividad» · versión 1",
  })
  expect(about(template.id, "form_template.leave")).toMatchObject({
    what: "Dejó de usar una ficha de consulta",
    about: "«Ficha con nombre en la actividad» · versión 1",
  })
  // Volver a usarla enciende la misma versión.
  expect(about(back.id, "form_template.reuse")).toMatchObject({
    what: "Volvió a usar una ficha de consulta",
    about: "«Ficha con nombre en la actividad» · versión 1",
  })
})

it("la Historia y la lista dicen el formulario a medias, cuándo se terminó después de firmar y el de una atención anulada", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación con su propia fecha")
  const draft = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id }),
  )
  await f.ready(f.encounter.id)
  const signed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const formsOf = async (patientId: string) =>
    (await f.run((tx) => getTimeline(tx, ORG, patientId))).data.find((row) => row.type === "encounter")?.born?.forms
  // Firmada con el formulario a medias: la tarjeta de la atención lo dice.
  expect(await formsOf(f.patient.id)).toMatchObject([
    { id: draft.id, title: "Evaluación con su propia fecha", state: "a_medias", finalizedAt: null, afterSigning: false, retired: false },
  ])
  let [listed] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: f.patient.id }))
  expect(listed).toMatchObject({ id: draft.id, encounterStatus: "finalizada" })
  expect(listed?.encounterFinalizedAt?.getTime()).toBe(signed.encounter.finalizedAt?.getTime())
  // Terminado después: su propia fecha y hora, y «después de firmar».
  const done = await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, draft.id))
  expect(await formsOf(f.patient.id)).toMatchObject([
    { id: draft.id, title: "Evaluación con su propia fecha", state: "finalizado", finalizedAt: done.finalizedAt, afterSigning: true, retired: false },
  ])
  ;[listed] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: f.patient.id }))
  expect(listed?.finalizedAt?.getTime()).toBeGreaterThan(listed?.encounterFinalizedAt?.getTime() ?? Number.POSITIVE_INFINITY)

  // Otra persona: finalizado dentro de una atención que después se anula. Va con lo que ya no vale.
  const g = await clinicalFixture()
  const inVoided = await g.run((tx) =>
    createFormResponse(tx, ORG, g.actor, { templateId: template.id, patientId: g.patient.id, encounterId: g.encounter.id }),
  )
  await g.run((tx) => finalizeFormResponse(tx, ORG, g.actor, inVoided.id))
  await g.run((tx) => voidEncounter(tx, ...g.args, g.encounter.id, { reason: "Paciente equivocado" }))
  expect(await formsOf(g.patient.id)).toMatchObject([{ id: inVoided.id, state: "finalizado", afterSigning: false, retired: true }])
  expect(await g.run((tx) => listFormResponses(tx, ORG, { patientId: g.patient.id }))).toMatchObject([
    { id: inVoided.id, status: "finalizado", encounterStatus: "anulada" },
  ])
  // Uno suelto no tiene atención.
  const loose = await g.run((tx) => createFormResponse(tx, ORG, g.actor, { templateId: template.id, patientId: g.patient.id }))
  const rows = await g.run((tx) => listFormResponses(tx, ORG, { patientId: g.patient.id }))
  expect(rows.find((row) => row.id === loose.id)).toMatchObject({ encounterStatus: null, encounterFinalizedAt: null })
})

it("la atención anulada dice en la Historia qué formularios tenía: el que se descartó al anularla, con el motivo, y el que ya estaba finalizado", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación de una atención anulada, en la Historia")
  const start = (answers: Record<string, unknown>) =>
    f.run((tx) =>
      createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id, answers }),
    )
  const finished = await start({ hallazgos: "Percusión negativa" })
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, finished.id))
  // Uno que se descartó a mano antes de anular: lleva su propio motivo.
  const dropped = await start({ hallazgos: "Formulario equivocado" })
  await f.run((tx) => discardFormResponse(tx, ORG, f.actor, dropped.id, "No era este formulario"))
  const halfway = await start({ hallazgos: "A medias" })
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Se abrió por error" }))

  const card = (await f.run((tx) => getTimeline(tx, ORG, f.patient.id))).data.find((row) => row.type === "encounter")
  expect(card).toMatchObject({ status: "anulada" })
  const byId = new Map((card?.born?.forms ?? []).map((form) => [form.id, form]))
  expect(byId.size).toBe(3)
  // El finalizado se conserva y se dice, de una atención anulada.
  expect(byId.get(finished.id)).toMatchObject({ state: "finalizado", retired: true, discardReason: null, discardedWithAttention: false })
  // El que quedó sin terminar: descartado al anular, con el motivo de la anulación.
  expect(byId.get(halfway.id)).toMatchObject({
    state: "descartado",
    retired: true,
    discardedWithAttention: true,
    discardReason: "Atención anulada: Se abrió por error",
  })
  // El descartado antes, con su motivo.
  expect(byId.get(dropped.id)).toMatchObject({
    state: "descartado",
    discardedWithAttention: false,
    discardReason: "No era este formulario",
  })

  // En una atención que no se anuló, lo descartado sigue sin ser parte de la Historia.
  const g = await clinicalFixture()
  const other = await g.run((tx) =>
    createFormResponse(tx, ORG, g.actor, { templateId: template.id, patientId: g.patient.id, encounterId: g.encounter.id }),
  )
  await g.run((tx) => discardFormResponse(tx, ORG, g.actor, other.id, "Paciente equivocado"))
  const live = (await g.run((tx) => getTimeline(tx, ORG, g.patient.id))).data.find((row) => row.type === "encounter")
  expect(live?.born?.forms ?? []).toEqual([])
})

it("la fecha en que se creó un formulario es la de su primera versión, y no cambia al volver a usarlo", async () => {
  const f = await clinicalFixture()
  const first = await inUse(f, "Ficha con fecha estable")
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, first.id))
  const back = await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, first.id))
  expect(back.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime())
  const rows = (await f.run((tx) => listClinicFormTemplates(tx, ORG))).filter((row) => row.key === first.key)
  expect(rows).toHaveLength(2)
  // Las dos versiones dicen la misma fecha: la de la primera. Es lo que distingue a dos con el mismo título.
  for (const row of rows) expect(row.formCreatedAt.getTime()).toBe(first.createdAt.getTime())
  // También en lo que ofrece «Nuevo» › «Formulario», que solo trae la versión en uso.
  const [offered] = (await f.run((tx) => listClinicFormTemplates(tx, ORG, { status: "publicado" }))).filter(
    (row) => row.key === first.key,
  )
  expect(offered).toMatchObject({ id: back.id, version: 2 })
  expect(offered?.formCreatedAt.getTime()).toBe(first.createdAt.getTime())
})
