import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { cie10Code, clinicalFollowUp, encounter, encounterDiagnosis, encounterDictationSuggestion, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture, makeSigner } from "./clinical-test-fixture.js"
import {
  confirmDictationSuggestion,
  discardDictationSuggestion,
  discardPendingDictation,
  listDictationSuggestions,
  previewDictationSuggestions,
  saveDictationSuggestions,
  updateDictationSuggestion,
} from "./encounter-dictation.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { withOrgContext } from "@odentia/db"

/** Asistente clínico: lo dictado queda como sugerencia y solo entra a la historia cuando el odontólogo confirma. */
setupTestDb()
const ORG = "org_a"
const inSixMonths = () => new Date(Date.now() + 180 * 86_400_000).toISOString()

beforeAll(async () => {
  await ownerDb.insert(cie10Code).values({ code: "K02.1", description: "Caries de la dentina" }).onConflictDoNothing()
})

const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

/** Atención de prueba con una prestación de nombre propio: dos servicios con el mismo nombre serían ambiguos. */
async function openSession(serviceName: string, scope = "tooth") {
  const fx = await clinicalFixture()
  // Por pieza o por caras: las prestaciones generales no admiten pieza ni superficies.
  await ownerDb.update(serviceCatalog).set({ name: serviceName, scope }).where(eq(serviceCatalog.id, fx.service.id))
  return fx
}

describe("dictado en la atención", () => {
  it("apagado no acepta dictados; encendido, solo de quien lleva la atención", async () => {
    const fx = await clinicalFixture()
    await enable(false)
    await expect(fx.run((tx) => saveDictationSuggestions(tx, ...fx.args, fx.encounter.id, [{ kind: "nota", payload: { reason: "Dolor" } }])))
      .rejects.toMatchObject({ code: "CLINICAL_ASSISTANT_OFF" })
    await enable(true)
    const other = randomUUID()
    await ownerDb.insert(user).values({ id: other, name: "Otro profesional", email: `${other}@example.test` })
    await makeSigner(ORG, other)
    await expect(fx.run((tx) => saveDictationSuggestions(tx, ORG, other, fx.patient.id, fx.encounter.id, [{ kind: "nota", payload: { reason: "Dolor" } }])))
      .rejects.toMatchObject({ code: "NOT_ATTENDING" })
  })

  it("ordena lo dictado en sugerencias listas o por revisar, sin tocar la historia", async () => {
    await enable(true)
    const fx = await openSession("Resina compuesta", "surfaces")
    const saved = await fx.run((tx) =>
      saveDictationSuggestions(tx, ...fx.args, fx.encounter.id, [
        { kind: "nota", payload: { reason: "Dolor al masticar del lado derecho", evolution: "", illnessDuration: "una semana" }, sourceText: "Viene por dolor al masticar." },
        { kind: "diagnostico", payload: { cie10Code: "k02.1", diagnosisType: "presuntivo", toothNumber: 16 }, sourceText: "En la dieciséis hay caries en dentina." },
        { kind: "diagnostico", payload: { cie10Code: "Z99.9", diagnosisType: "presuntivo" } },
        { kind: "plan", payload: { service: "resina compuesta", toothNumber: 16, surfaces: ["oclusal"] }, sourceText: "Le ponemos el tratamiento en la cara oclusal." },
        { kind: "plan", payload: { service: "Corona de zirconio", toothNumber: 36 } },
        { kind: "control", payload: { title: "Control en 6 meses", dueAt: inSixMonths() } },
        // Lo que no encaja en su operación no se pierde: queda por revisar.
        { kind: "diagnostico", payload: { cie10Code: "K02.1", diagnosisType: "seguro" } },
        // Una nota vacía no es una sugerencia.
        { kind: "nota", payload: { reason: "  " } },
      ]),
    )
    expect(saved.map((item) => [item.kind, item.status])).toEqual([
      ["nota", "lista"], ["diagnostico", "lista"], ["diagnostico", "por_revisar"], ["plan", "lista"],
      ["plan", "por_revisar"], ["control", "lista"], ["diagnostico", "por_revisar"],
    ])
    const [note, diagnosis, unknownCode, plan, unknownService] = saved
    expect(note?.payload).toEqual({ reason: "Dolor al masticar del lado derecho", illnessDuration: "una semana" })
    expect(note?.sourceText).toBe("Viene por dolor al masticar.")
    expect(diagnosis).toMatchObject({ payload: { cie10Code: "K02.1", description: "Caries de la dentina", toothNumber: 16 }, summary: "K02.1 · Caries de la dentina\nPieza 16 · presuntivo" })
    expect(unknownCode?.note).toContain("no está en el catálogo CIE-10")
    // La prestación se reconoce por su nombre y trae la tarifa del tarifario, que no se dicta.
    expect(plan?.payload).toMatchObject({ serviceId: fx.service.id, serviceName: "Resina compuesta", priceCents: 120000, currency: "PEN" })
    expect(plan?.summary).toBe("Resina compuesta · S/ 1200.00\nPieza 16 · cara oclusal")
    expect(unknownService?.note).toBe("Dijiste «Corona de zirconio» y no está en tus servicios. Elige la prestación.")

    // Nada entró a la historia todavía.
    const [session] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(session?.reason).toBe("Consulta")
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toEqual([])
    // La auditoría cuenta, pero no copia lo dictado.
    const audits = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.entityId, fx.encounter.id), eq(auditEvent.action, "encounter.dictation_suggested")))
    expect(audits[0]?.metadata).toMatchObject({ count: 7 })
    expect(JSON.stringify(audits)).not.toContain("masticar")
    expect(await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).toHaveLength(7)
  })

  it("confirmar usa la operación de la atención; lo por revisar se resuelve antes; lo descartado no entra", async () => {
    await enable(true)
    const fx = await openSession("Endodoncia multirradicular")
    const due = inSixMonths()
    const [note, diagnosis, plan, pending, control, extra] = await fx.run((tx) =>
      saveDictationSuggestions(tx, ...fx.args, fx.encounter.id, [
        { kind: "nota", payload: { reason: "Dolor al masticar", evolution: "Se realizó la limpieza de la cavidad." } },
        { kind: "diagnostico", payload: { cie10Code: "K02.1", diagnosisType: "presuntivo", toothNumber: 16 } },
        { kind: "plan", payload: { service: "Endodoncia multirradicular", toothNumber: 16 } },
        { kind: "plan", payload: { service: "Corona de zirconio", toothNumber: 36 } },
        { kind: "control", payload: { title: "Control en 6 meses", dueAt: due } },
        { kind: "diagnostico", payload: { cie10Code: "K02.1", diagnosisType: "definitivo", toothNumber: 26 } },
      ]),
    )
    const confirm = (id: string) => fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, id))

    await confirm(note!.id)
    const [session] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(session).toMatchObject({ reason: "Dolor al masticar", evolution: "Se realizó la limpieza de la cavidad." })

    await confirm(diagnosis!.id)
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toEqual([
      expect.objectContaining({ cie10Code: "K02.1", diagnosisType: "presuntivo", toothNumber: 16 }),
    ])

    await confirm(plan!.id)
    const items = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.planId, fx.plan.id))
    expect(items).toEqual([expect.objectContaining({ serviceId: fx.service.id, toothNumber: 16, sourceEncounterId: fx.encounter.id })])

    // Falta elegir la prestación: no se confirma hasta que el odontólogo la elija.
    await expect(confirm(pending!.id)).rejects.toMatchObject({ code: "SUGGESTION_NEEDS_REVIEW" })
    await expect(fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, pending!.id, { serviceId: randomUUID() }))).rejects.toThrow(/no está activa/)
    const chosen = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, pending!.id, { serviceId: fx.service.id }))
    expect(chosen).toMatchObject({ status: "lista", note: null, payload: { serviceId: fx.service.id, toothNumber: 36 } })
    await confirm(pending!.id)
    expect(await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.planId, fx.plan.id))).toHaveLength(2)

    await confirm(control!.id)
    const controls = await ownerDb.select().from(clinicalFollowUp).where(eq(clinicalFollowUp.patientId, fx.patient.id))
    expect(controls).toEqual([expect.objectContaining({ title: "Control en 6 meses", kind: "mantenimiento", originEncounterId: fx.encounter.id, status: "pendiente" })])

    // Una vez decidida, no se decide otra vez.
    await expect(confirm(note!.id)).rejects.toMatchObject({ code: "SUGGESTION_DECIDED" })
    // Descartar: no entra a la historia y sale de la lista.
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, extra!.id))
    expect(await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).toEqual([])
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toHaveLength(1)
    const rows = await ownerDb.select({ status: encounterDictationSuggestion.status, entityId: encounterDictationSuggestion.entityId }).from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.encounterId, fx.encounter.id))
    expect(rows.filter((row) => row.status === "confirmada")).toHaveLength(5)
    expect(rows.filter((row) => row.status === "descartada")).toHaveLength(1)
  })

  it("si la operación rechaza el dato, la sugerencia sigue ahí; antes de firmar se descarta lo pendiente; la práctica no guarda", async () => {
    await enable(true)
    const fx = await openSession("Profilaxis dental", "general")
    const [badControl, kept] = await fx.run((tx) =>
      saveDictationSuggestions(tx, ...fx.args, fx.encounter.id, [
        { kind: "control", payload: { title: "Control", dueAt: new Date(Date.now() + 86_400_000).toISOString(), instructions: "x".repeat(2000) } },
        { kind: "nota", payload: { nextStep: "Tomar radiografía" } },
      ]),
    )
    // Vaciar un campo al editar lo quita de la sugerencia, que sigue lista.
    const edited = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, badControl!.id, { title: "Control de endodoncia", instructions: null }))
    expect(edited).toMatchObject({ status: "lista", payload: { title: "Control de endodoncia" } })
    expect(edited.payload["instructions"]).toBeUndefined()
    await ownerDb.update(encounterDictationSuggestion).set({ payload: { title: "", dueAt: "mañana" }, status: "lista" }).where(eq(encounterDictationSuggestion.id, badControl!.id))
    await expect(fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, badControl!.id))).rejects.toMatchObject({ code: "VALIDATION" })
    const [still] = await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, badControl!.id))
    expect(still?.status).toBe("lista")
    expect(await ownerDb.select().from(clinicalFollowUp).where(eq(clinicalFollowUp.patientId, fx.patient.id))).toEqual([])

    expect(await fx.run((tx) => discardPendingDictation(tx, ...fx.args, fx.encounter.id))).toBe(2)
    expect(await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).toEqual([])
    expect(kept).toBeTruthy()

    const before = (await ownerDb.select({ id: encounterDictationSuggestion.id }).from(encounterDictationSuggestion)).length
    const preview = await fx.run((tx) => previewDictationSuggestions(tx, ORG, [
      { kind: "plan", payload: { service: "profilaxis dental" } },
      { kind: "diagnostico", payload: { cie10Code: "K02.1", diagnosisType: "presuntivo" } },
    ]))
    expect(preview.map((item) => item.status)).toEqual(["lista", "lista"])
    expect((await ownerDb.select({ id: encounterDictationSuggestion.id }).from(encounterDictationSuggestion)).length).toBe(before)
    await enable(false)
  })
})
