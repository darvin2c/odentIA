import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { encounter } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { clinicalFixture, makeSigner } from "./clinical-test-fixture.js"
import {
  addFormAddendum,
  createFormResponse,
  discardFormResponse,
  finalizeFormResponse,
  listFormResponses,
  reuseFormTemplate,
  updateFormResponseDraft,
} from "./clinical-forms.js"
import { discardEmptyEncounter, finalizeEncounter, getOpenEncounterRef, takeOverEncounter } from "./encounters.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { listWorkspaceAudit } from "./workspace.js"

setupTestDb()

/**
 * Regla del producto (revisión final de formularios, 15 nov, decisión 1): la
 * ficha de una atención la escribe quien la lleva o quien toma el relevo, como
 * el dictado (`NOT_ATTENDING`); los demás la leen y, ya finalizada, le agregan
 * una adenda. La ficha suelta, sin atención, la sigue cualquiera del equipo.
 */

const ORG = "org_a"
const SCHEMA = {
  sections: [{ id: "examen", title: "Examen", fields: [{ id: "movilidad", label: "Movilidad", type: "numero", unit: "mm", min: 0, max: 10 }] }],
}

async function colleague(): Promise<string> {
  const id = randomUUID()
  await ownerDb.insert(user).values({ id, name: "Otra doctora", email: `${id}@example.test` })
  await makeSigner(ORG, id)
  return id
}

/** La atención en curso de la doctora del fixture, con una ficha empezada, y una colega que no la lleva. */
async function attentionWithForm() {
  const fx = await clinicalFixture(ORG)
  const other = await colleague()
  const [template] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({ organizationId: ORG, key: `ficha-${fx.actor}`, title: "Ficha de prueba", status: "publicado", schema: SCHEMA })
    .returning()
  const form = await fx.run((tx) =>
    createFormResponse(tx, ORG, fx.actor, { templateId: template!.id, patientId: fx.patient.id, encounterId: fx.encounter.id, answers: { movilidad: 3 } }),
  )
  return { fx, other, form, templateId: template!.id }
}

const rejection = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

describe("la ficha de una atención la escribe quien la lleva", () => {
  it("quien no lleva la atención no escribe, no finaliza, no descarta ni empieza una ficha en ella: 409 NOT_ATTENDING", async () => {
    const { fx, other, form, templateId } = await attentionWithForm()
    const attempts = [
      () => fx.run((tx) => updateFormResponseDraft(tx, ORG, other, form.id, { answers: { movilidad: 2 } })),
      () => fx.run((tx) => finalizeFormResponse(tx, ORG, other, form.id)),
      () => fx.run((tx) => discardFormResponse(tx, ORG, other, form.id, "No era")),
      () => fx.run((tx) => createFormResponse(tx, ORG, other, { templateId, patientId: fx.patient.id, encounterId: fx.encounter.id, answers: {} })),
    ]
    for (const attempt of attempts) {
      expect(await rejection(attempt())).toMatchObject({ code: "NOT_ATTENDING", status: 409 })
    }
    const [row] = await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, form.id))
    expect(row).toMatchObject({ status: "borrador", answers: { movilidad: 3 } })
  })

  it("quien la lleva escribe; con el relevo escribe quien lo tomó y ya no quien la llevaba", async () => {
    const { fx, other, form } = await attentionWithForm()
    await fx.run((tx) => updateFormResponseDraft(tx, ORG, fx.actor, form.id, { answers: { movilidad: 4 } }))
    await fx.run((tx) => takeOverEncounter(tx, ORG, other, fx.patient.id, fx.encounter.id))
    const saved = await fx.run((tx) => updateFormResponseDraft(tx, ORG, other, form.id, { answers: { movilidad: 2 } }))
    expect(saved.answers).toEqual({ movilidad: 2 })
    expect(await rejection(fx.run((tx) => updateFormResponseDraft(tx, ORG, fx.actor, form.id, { answers: { movilidad: 5 } })))).toMatchObject({
      code: "NOT_ATTENDING",
    })
  })

  it("firmada la atención, la ficha a medias la termina quien atendió; los demás, una adenda cuando esté finalizada", async () => {
    const { fx, other, form } = await attentionWithForm()
    await fx.ready(fx.encounter.id)
    await fx.run((tx) => finalizeEncounter(tx, ...fx.args, fx.encounter.id))
    expect(await rejection(fx.run((tx) => updateFormResponseDraft(tx, ORG, other, form.id, { answers: { movilidad: 1 } })))).toMatchObject({
      code: "NOT_ATTENDING",
      message: expect.stringContaining("adenda"),
    })
    await fx.run((tx) => finalizeFormResponse(tx, ORG, fx.actor, form.id))
    const addendum = await fx.run((tx) => addFormAddendum(tx, ORG, other, form.id, "Movilidad revisada: 2 mm"))
    expect(addendum.createdBy).toBe(other)
  })

  it("la ficha suelta, sin atención, la sigue cualquiera del equipo clínico", async () => {
    const { fx, other, templateId } = await attentionWithForm()
    const loose = await fx.run((tx) => createFormResponse(tx, ORG, fx.actor, { templateId, patientId: fx.patient.id, answers: {} }))
    const saved = await fx.run((tx) => updateFormResponseDraft(tx, ORG, other, loose.id, { answers: { movilidad: 1 } }))
    expect(saved.answers).toEqual({ movilidad: 1 })
  })
})

describe("una ficha empezada sin respuestas no traba la atención (revisión final del 15 nov, A6)", () => {
  it("se descarta la atención con su ficha vacía; con respuestas no, y dice por qué", async () => {
    const fx = await clinicalFixture(ORG)
    await ownerDb.execute(
      sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${fx.encounter.id}`,
    )
    const [template] = await ownerDb
      .insert(clinicalFormTemplate)
      .values({ organizationId: ORG, key: `vacia-${fx.actor}`, title: "Ficha de prueba", status: "publicado", schema: SCHEMA })
      .returning()
    const open = async () => {
      const [row] = await ownerDb
        .insert(encounter)
        .values({ organizationId: ORG, patientId: fx.patient.id, professionalUserId: fx.actor, reason: "Control" })
        .returning({ id: encounter.id })
      return row!.id
    }
    const start = (encounterId: string, answers: Record<string, unknown>) =>
      fx.run((tx) => createFormResponse(tx, ORG, fx.actor, { templateId: template!.id, patientId: fx.patient.id, encounterId, answers }))

    // «Empezar la de hoy» y cerrarla sin escribir: la atención sigue vacía y se descarta.
    const empty = await open()
    const blank = await start(empty, {})
    expect((await fx.run((tx) => getOpenEncounterRef(tx, ORG, fx.patient.id)))?.empty).toBe(true)
    await fx.run((tx) => discardEmptyEncounter(tx, ...fx.args, empty))
    expect(await ownerDb.select({ id: encounter.id }).from(encounter).where(eq(encounter.id, empty))).toEqual([])
    const [kept] = await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, blank.id))
    expect(kept).toMatchObject({ status: "descartado", encounterId: null, discardReason: "Se descartó la atención antes de llenarla" })

    // Con una respuesta ya no está vacía, y el rechazo dice qué tiene.
    const filled = await open()
    await start(filled, { movilidad: 2 })
    expect((await fx.run((tx) => getOpenEncounterRef(tx, ORG, fx.patient.id)))?.empty).toBe(false)
    expect(await rejection(fx.run((tx) => discardEmptyEncounter(tx, ...fx.args, filled)))).toMatchObject({
      code: "ENCOUNTER_NOT_EMPTY",
      message: "Tiene una ficha con respuestas: termínala o anúlala con su motivo",
    })
  })
})

describe("el cuestionario que respondía el paciente se retiró (revisión final del 15 nov, A7)", () => {
  it("no se vuelve a usar: el servidor lo rechaza como al publicarlo", async () => {
    const fx = await clinicalFixture(ORG)
    const [retired] = await ownerDb
      .insert(clinicalFormTemplate)
      .values({
        organizationId: ORG,
        key: `previo-${fx.actor}`,
        title: "Cuestionario previo a la cita",
        status: "publicado",
        inUse: false,
        respondent: "portal",
        schema: SCHEMA,
      })
      .returning()
    expect(await rejection(fx.run((tx) => reuseFormTemplate(tx, ORG, fx.actor, retired!.id)))).toMatchObject({
      code: "PATIENT_FORMS_RETIRED",
      status: 409,
    })
  })
})

describe("lo cambiado después de firmar queda dicho (revisión final del 15 nov, A5 y A14)", () => {
  it("cada pregunta cambiada con la atención firmada dice quién y cuándo; la Actividad dice de qué paciente es", async () => {
    const { fx, form } = await attentionWithForm()
    await fx.ready(fx.encounter.id)
    await fx.run((tx) => finalizeEncounter(tx, ...fx.args, fx.encounter.id))
    const before = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(before.find((row) => row.id === form.id)?.afterSigning).toEqual({})
    await fx.run((tx) => updateFormResponseDraft(tx, ORG, fx.actor, form.id, { answers: { movilidad: 2 } }))
    const after = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(after.find((row) => row.id === form.id)?.afterSigning).toEqual({ movilidad: { by: fx.actor, at: expect.any(Date) } })
    const { items } = await fx.run((tx) => listWorkspaceAudit(tx, ORG, { action: "form_response.update" }))
    expect(items.find((item) => item.entityId === form.id)?.subject).toBeTruthy()
  })
})
