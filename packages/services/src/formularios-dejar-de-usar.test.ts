/**
 * Formularios de la clínica (mesa del 13 nov): dejar de usar uno y volver a
 * usarlo, que uno nuevo no nazca como versión de otro, los bordes del servidor
 * al responder y que nada de esto trabe la atención: el formulario empezado
 * antes de firmar se termina después, y el cierre lo avisa sin frenar.
 */
import { auditEvent } from "@odentia/db/schema/org"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  archiveFormTemplate,
  createFormResponse,
  createFormTemplate,
  finalizeFormResponse,
  listFormTemplates,
  publishFormTemplate,
  reuseFormTemplate,
  updateFormResponseDraft,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createEncounter, finalizeEncounter, getEncounterClosing, voidEncounter } from "./encounters.js"
import { listClinicFormTemplates } from "./portal-questionnaire.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

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

it("dejar de usar un formulario deja de ofrecerlo y volver a usarlo crea la versión siguiente con las mismas preguntas", async () => {
  const f = await clinicalFixture()
  const periodontal = await inUse(f, "Ficha periodontal de prueba")
  const llenado = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: periodontal.id, patientId: f.patient.id, answers: { hallazgos: "Bolsa de 5 mm" } }),
  )
  await f.run((tx) => finalizeFormResponse(tx, ORG, f.actor, llenado.id))

  const left = await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, periodontal.id))
  expect(left.status).toBe("archivado")
  const offered = await f.run((tx) => listFormTemplates(tx, ORG, { status: "publicado" }))
  expect(offered.some((row) => row.key === periodontal.key)).toBe(false)
  // Ya no se empieza uno nuevo con ella.
  await expect(
    f.run((tx) => createFormResponse(tx, ORG, f.actor, { templateId: periodontal.id, patientId: f.patient.id })),
  ).rejects.toMatchObject({ status: 400 })

  const back = await f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, periodontal.id))
  expect(back).toMatchObject({
    key: periodontal.key,
    version: 2,
    status: "publicado",
    title: periodontal.title,
    respondent: "staff",
  })
  expect(back.schema).toEqual(periodontal.schema)
  expect(back.publishedAt).toBeInstanceOf(Date)
  // La que se dejó de usar no cambia, y lo ya llenado conserva sus preguntas.
  const all = await f.run((tx) => listFormTemplates(tx, ORG, {}))
  expect(all.find((row) => row.id === periodontal.id)?.status).toBe("archivado")
  const [kept] = await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, llenado.id))
  expect(kept).toMatchObject({ status: "finalizado", templateVersion: 1, answers: { hallazgos: "Bolsa de 5 mm" } })
  const [trace] = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "form_template.reuse"), eq(auditEvent.entityId, back.id)))
  expect(trace?.metadata).toMatchObject({ key: periodontal.key, version: 2, from: 1 })

  // En uso otra vez: no se vuelve a usar dos veces, ni una versión anterior.
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, periodontal.id))).rejects.toMatchObject({ status: 409 })
  // Un borrador que se archivó nunca estuvo en uso: no hay a qué volver.
  const draft = await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { title: "Borrador que no se usó", schema }))
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, draft.id))
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, draft.id))).rejects.toMatchObject({ status: 409 })
  // Con un borrador preparado se publica ese borrador.
  await f.run((tx) => archiveFormTemplate(tx, ORG, f.actor, back.id))
  await f.run((tx) => createFormTemplate(tx, ORG, f.actor, { key: back.key, title: back.title, schema }))
  await expect(f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, back.id))).rejects.toMatchObject({
    code: "DRAFT_EXISTS",
  })
  await expect(
    f.run((tx) => reuseFormTemplate(tx, ORG, f.actor, "00000000-0000-4000-8000-000000000000")),
  ).rejects.toMatchObject({ status: 404 })
})

it("el servidor rechaza una fecha imposible y un valor que no es del tipo de la pregunta", async () => {
  const f = await clinicalFixture()
  const template = await inUse(f, "Evaluación de bordes")
  const response = await f.run((tx) =>
    createFormResponse(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id }),
  )
  const save = (answers: Record<string, unknown>) =>
    f.run((tx) => updateFormResponseDraft(tx, ORG, f.actor, response.id, { answers }))
  await expect(save({ fecha: "2026-02-31" })).rejects.toMatchObject({
    status: 400,
    fields: { "answers.fecha": expect.stringContaining("Fecha de evaluación") },
  })
  await expect(save({ fecha: "2026-13-01" })).rejects.toMatchObject({ status: 400 })
  await expect(save({ intensidad: true })).rejects.toMatchObject({
    status: 400,
    fields: { "answers.intensidad": expect.stringContaining("Intensidad") },
  })
  await expect(save({ dolor: true })).rejects.toMatchObject({ status: 400 })
  await expect(save({ intensidad: [7] })).rejects.toMatchObject({ status: 400 })
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
  ).rejects.toMatchObject({ code: "ENCOUNTER_CLOSED", status: 409 })
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
  ).rejects.toMatchObject({ code: "ENCOUNTER_CLOSED", status: 409 })
})
