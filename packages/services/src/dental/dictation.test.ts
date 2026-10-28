import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  encounter,
  encounterDiagnosis,
  encounterDictationSuggestion,
  encounterProcedure,
  patient,
  patientAllergy,
  prescriptionItem,
  serviceCatalog,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { findDraftBudget } from "../budgets.js"
import { appointment } from "@odentia/db/schema/agenda"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { upsertAgentConfig } from "../agentConfig.js"
import { createAppointment, createRoom } from "../appointments.js"
import { setProfessionalSchedule, zonedTimeToUtc } from "../availability.js"
import { clinicalFixture, makeSigner, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import {
  confirmDictationSuggestion,
  discardDictationSuggestion,
  discardPendingDictation,
  countConfirmedDictation,
  dictationModelLabel,
  dictationSegmentSeen,
  issueDictationPrescription,
  keepConfirmedDictation,
  listConfirmedDictation,
  listDictationSuggestions,
  listVoiceRemovedDictation,
  previewDictationSuggestions,
  saveDictationSegment,
  saveDictationSuggestions,
  undoConfirmedDictation,
  undoDictationVoiceCorrection,
  updateDictationSuggestion,
} from "../encounter-dictation.js"
import { DENTAL_DICTATION } from "./dictation.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { nextPatientNumber } from "../patients.js"
import { insertTestPatients } from "../test-patient.js"
import { withOrgContext } from "@odentia/db"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { orgStrictVariants } from "./odontogram.js"
import { dentalSiteOfRow } from "./site.js"

/** Asistente clínico: lo dictado queda como sugerencia y solo entra a la historia cuando el odontólogo confirma. */
setupTestDb()
const ORG = "org_a"
const inSixMonths = () => new Date(Date.now() + 180 * 86_400_000).toISOString()

beforeAll(async () => {
  await seedDiagnosisCodes([{ code: "K02.1", title: "Caries de la dentina" }])
})

const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

/** Atención de prueba con una prestación de nombre propio: dos servicios con el mismo nombre serían ambiguos. */
async function openSession(serviceName: string, scope = "tooth") {
  const fx = await clinicalFixture()
  // Por pieza o por caras: las prestaciones generales no admiten pieza ni superficies.
  await ownerDb.update(serviceCatalog).set({ name: serviceName, scope }).where(eq(serviceCatalog.id, fx.service.id))
  return fx
}

describe("odontograma por voz (issue 109)", () => {
  it("un hallazgo dictado pide lo que exige la norma, se completa y entra como al tocar la pieza, con su diagnóstico", async () => {
    await enable(true)
    const fx = await openSession("Obturación de prueba")
    const strict = await fx.run((tx) => orgStrictVariants(tx, ORG))
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const saved = await segment({
      drafts: [
        { kind: "odontograma", payload: { toothNumber: 36, condition: "caries", variant: "dentina", surfaces: ["oclusal"] }, sourceText: "La 36 con caries oclusal en dentina." },
        { kind: "odontograma", payload: { toothNumber: 11, condition: "crown" }, sourceText: "La 11 tiene corona." },
        // Lo que no se dicta (pide marcar que se observó) o no existe no se adivina: queda por revisar, a la vista.
        { kind: "odontograma", payload: { toothNumber: 46, condition: "implant" } },
        { kind: "odontograma", payload: { toothNumber: 19, condition: "missing_tooth" } },
      ],
    })
    const [caries, crown, implant, nineteen] = saved.suggestions
    // «dentina» es la variante por su nombre; la caries lleva su diagnóstico de la lista de la clínica.
    expect(caries).toMatchObject({
      status: "lista",
      payload: { condition: "caries", variant: "dentin", surfaces: ["occlusal"], diagnosisCode: "K02.1" },
      summary: "Pieza 36 · Lesión de caries a nivel de la dentina · cara oclusal\nCon el diagnóstico presuntivo K02.1 Caries de la dentina",
    })
    // La corona siempre pide su estado; en Perú, además, el material.
    expect(crown).toMatchObject({ status: "por_revisar", payload: { missing: strict ? ["variant", "quality"] : ["quality"] } })
    expect(implant).toMatchObject({ status: "por_revisar" })
    expect(nineteen?.note).toContain("no existe")

    // Elegir con un toque lo que falta la deja lista.
    await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, crown!.id, { quality: "good", variant: "metal_ceramic" }))
    expect((await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).find((item) => item.id === crown!.id)).toMatchObject({
      status: "lista",
      payload: { variant: "metal_ceramic", quality: "good" },
    })

    // El asistente a veces corrige y además vuelve a registrar: el mismo hallazgo pendiente no se repite.
    expect((await segment({ drafts: [{ kind: "odontograma", payload: { toothNumber: 36, condition: "caries", surfaces: ["oclusal"] } }] })).suggestions).toEqual([])

    // Confirmar usa la operación del panel de la pieza: el hallazgo y el diagnóstico de la atención.
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, caries!.id))
    const entries = await ownerDb.select().from(odontogramEntry).where(eq(odontogramEntry.encounterId, fx.encounter.id))
    expect(entries).toEqual([expect.objectContaining({ toothNumber: 36, condition: "caries", surface: "occlusal", details: { variant: "dentin" }, diagnosisCode: "K02.1" })])
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toEqual([
      expect.objectContaining({ diagnosisCode: "K02.1", diagnosisType: "provisional" }),
    ])
    await enable(false)
  })
})

describe("receta y caminos por voz (issue 109, fase 2)", () => {
  it("la receta dictada calcula la cantidad, pide lo que falta, avisa la alergia y se emite con su propio botón", async () => {
    await enable(true)
    const fx = await openSession("Obturación de receta")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const saved = await segment({
      drafts: [
        { kind: "receta", payload: { genericName: "Amoxicilina", strength: "500 mg", dosageForm: "cápsula", dose: "1 cápsula", frequency: "cada ocho horas", duration: "7 días" } },
        { kind: "receta", payload: { genericName: "ibuprofeno", strength: "400 mg", dosageForm: "tableta", dose: "1 tableta", frequency: "cada 8 horas si hay dolor" } },
      ],
    })
    const [amoxicilina, ibuprofeno] = saved.suggestions
    // La vía oral no se dicta con una cápsula, y 1 cada 8 horas por 7 días son 21 (decisiones 5 y 6).
    expect(amoxicilina).toMatchObject({ status: "lista", payload: { genericName: "amoxicilina", route: "oral", routeImplied: true, quantity: 21, quantityCalculated: true } })
    expect(ibuprofeno).toMatchObject({ status: "por_revisar", note: "Falta la duración de ibuprofeno. Dila o complétala." })
    // No se emite con «Confirmar»: es firmar con la colegiatura.
    await expect(fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, amoxicilina!.id))).rejects.toMatchObject({ code: "PRESCRIPTION_NEEDS_ISSUE" })
    await expect(fx.run((tx) => issueDictationPrescription(tx, ...fx.args, fx.encounter.id))).rejects.toMatchObject({ code: "SUGGESTION_NEEDS_REVIEW" })

    // Dicho después: «el ibuprofeno por tres días». Si además llega registrado otra vez, no se receta dos veces.
    await segment({
      drafts: [{ kind: "receta", payload: { genericName: "Ibuprofeno", duration: "3 días" } }],
      corrections: [{ suggestionId: ibuprofeno!.id, changes: { duration: "tres días" } }],
    })
    const completed = (await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).find((item) => item.id === ibuprofeno!.id)
    expect(completed).toMatchObject({ status: "lista", payload: { quantity: 9 }, voice: { before: "sin duración" } })

    const { prescriptionId } = await fx.run((tx) => issueDictationPrescription(tx, ...fx.args, fx.encounter.id))
    const items = await ownerDb.select().from(prescriptionItem).where(eq(prescriptionItem.prescriptionId, prescriptionId))
    expect(items.map((item) => [item.genericName, item.route, item.quantity]).sort()).toEqual([["amoxicilina", "oral", 21], ["ibuprofeno", "oral", 9]])
    expect(await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).toEqual([])

    // Con alergia a las penicilinas, la amoxicilina queda con el aviso de siempre y no se emite sola.
    await ownerDb.insert(patientAllergy).values({ organizationId: ORG, patientId: fx.patient.id, substance: "Penicilinas", severity: "severa" })
    const [warned] = (await segment({ drafts: [{ kind: "receta", payload: { genericName: "amoxicilina", strength: "500 mg", dosageForm: "cápsula", dose: "1 cápsula", frequency: "cada 8 horas", duration: "7 días" } }] })).suggestions
    expect(warned).toMatchObject({ status: "por_revisar", payload: { allergyWarnings: [expect.stringContaining("Penicilinas")] } })
    await expect(fx.run((tx) => issueDictationPrescription(tx, ...fx.args, fx.encounter.id))).rejects.toMatchObject({ code: "SUGGESTION_NEEDS_REVIEW" })
    await enable(false)
  })

  it("«onlay, o si no una carilla» deja el presupuesto en borrador con dos opciones, y no se mezcla con otra elección", async () => {
    await enable(true)
    const fx = await openSession("Onlay cerámico", "tooth")
    await ownerDb.insert(serviceCatalog).values({ organizationId: ORG, name: "Carilla feldespática", scope: "tooth", source: "custom", priceCents: 90000, currency: "PEN" })
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const saved = await segment({
      drafts: [
        { kind: "plan", payload: { service: "onlay cerámico", toothNumber: 46, alternatives: ["carilla feldespática"] }, sourceText: "Un onlay, o si no una carilla." },
        // Una segunda elección en el mismo dictado espera: el presupuesto lleva una sola (decisión 3).
        { kind: "plan", payload: { service: "onlay cerámico", toothNumber: 36, alternatives: ["carilla feldespática"] } },
      ],
    })
    const [choice, second] = saved.suggestions
    expect(choice).toMatchObject({ status: "lista", summary: expect.stringContaining("Pieza 46 · dos caminos, el paciente elige"), payload: { serviceName: "Onlay cerámico", options: [expect.objectContaining({ serviceName: "Carilla feldespática" })] } })
    expect(second).toMatchObject({ status: "por_revisar", note: expect.stringContaining("Ya hay otra elección") })

    // «Recomendar» la corona la hace la opción A; volver a recomendar la resina deja todo como estaba.
    const swapped = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, choice!.id, { recommend: 1 }))
    expect(swapped.payload).toMatchObject({ serviceName: "Carilla feldespática", options: [expect.objectContaining({ serviceName: "Onlay cerámico" })] })
    await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, choice!.id, { recommend: 1 }))

    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, second!.id))
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, choice!.id))
    const budget = await fx.run((tx) => findDraftBudget(tx, ORG, fx.patient.id))
    const options = await ownerDb.select().from(treatmentBudgetOption).where(eq(treatmentBudgetOption.budgetId, budget!.id))
    expect(options).toHaveLength(2)
    const lines = await ownerDb.select().from(treatmentBudgetItem).where(eq(treatmentBudgetItem.budgetId, budget!.id))
    const byOption = (position: number) => lines.filter((line) => line.optionId === options.find((option) => option.position === position)!.id).map((line) => line.title)
    expect([byOption(1), byOption(2)]).toEqual([["Onlay cerámico"], ["Carilla feldespática"]])
    expect(options.find((option) => option.position === 1)?.isRecommended).toBe(true)

    // Otra elección después ya no cabe en ese borrador: se arma a mano en el presupuesto.
    const [later] = (await segment({ drafts: [{ kind: "plan", payload: { service: "onlay cerámico", toothNumber: 36, alternatives: ["carilla feldespática"] } }] })).suggestions
    expect(later).toMatchObject({ status: "por_revisar", note: expect.stringContaining("ya tiene opciones") })
    await enable(false)
  })

  it("«resina en la 36, o si no una corona» se confirma: cada camino lleva solo lo suyo", async () => {
    await enable(true)
    const fx = await openSession("Resina fotocurable", "surfaces")
    const [corona] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: ORG, name: "Funda metal-cerámica", scope: "tooth", source: "custom", priceCents: 90000, currency: "PEN" })
      .returning()
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const [choice] = (
      await segment({ drafts: [{ kind: "plan", payload: { service: "resina fotocurable", toothNumber: 36, surfaces: ["oclusal"], alternatives: ["funda metal-cerámica"] } }] })
    ).suggestions
    expect(choice).toMatchObject({ status: "lista", payload: { toothNumber: 36, surfaces: ["occlusal"] } })

    // Antes, la corona recibía las caras de la resina y la operación la rechazaba.
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, choice!.id))
    const items = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.sourceEncounterId, fx.encounter.id))
    const siteOf = (serviceId: string) => dentalSiteOfRow(items.find((item) => item.serviceId === serviceId)!)
    expect(siteOf(fx.service.id)).toMatchObject({ toothNumber: 36, surfaces: ["occlusal"] })
    expect(siteOf(corona!.id)).toMatchObject({ toothNumber: 36, surfaces: [] })
    await enable(false)
  })

  it("con la corona recomendada y la resina sin cara, avisa qué opción no tiene cara y se confirma igual", async () => {
    await enable(true)
    const fx = await openSession("Resina de una cara", "surfaces")
    const [funda] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: ORG, name: "Funda libre de metal", scope: "tooth", source: "custom", priceCents: 150000, currency: "PEN" })
      .returning()
    const [choice] = (
      await fx.run((tx) =>
        saveDictationSegment(tx, ...fx.args, fx.encounter.id, { drafts: [{ kind: "plan", payload: { service: "funda libre de metal", toothNumber: 36, alternatives: ["resina de una cara"] } }] }),
      )
    ).suggestions
    expect(choice).toMatchObject({ status: "lista", payload: { pending: ["surfaces"] }, note: expect.stringMatching(/^Opción B · Resina de una cara: ¿Qué cara de la 36\?/) })
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, choice!.id))
    const items = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.sourceEncounterId, fx.encounter.id))
    expect(dentalSiteOfRow(items.find((item) => item.serviceId === funda!.id)!)).toMatchObject({ toothNumber: 36, surfaces: [] })
    expect(dentalSiteOfRow(items.find((item) => item.serviceId === fx.service.id)!)).toMatchObject({ toothNumber: 36, surfaces: [] })
    await enable(false)
  })

  it("una resina sin cara entra al plan por definir; al hacerla se pide la cara y queda en el tratamiento", async () => {
    await enable(true)
    const fx = await openSession("Resina por definir", "surfaces")
    const [resin] = (await fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, { drafts: [{ kind: "plan", payload: { service: "resina por definir", toothNumber: 46 } }] }))).suggestions
    expect(resin).toMatchObject({ status: "lista", payload: { pending: ["surfaces"] } })
    // Un toque en la cara la completa; si no, se confirma igual.
    const touched = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, resin!.id, { surfaces: ["occlusal"] }))
    expect(touched).toMatchObject({ status: "lista", note: null, payload: { surfaces: ["occlusal"] } })
    expect(touched.payload).not.toHaveProperty("pending")
    const [other] = (await fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, { drafts: [{ kind: "plan", payload: { service: "resina por definir", toothNumber: 47 } }] }))).suggestions
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, other!.id))
    const [item] = await ownerDb.select().from(treatmentPlanItem).where(and(eq(treatmentPlanItem.sourceEncounterId, fx.encounter.id), eq(treatmentPlanItem.serviceId, fx.service.id)))
    expect(dentalSiteOfRow(item!)).toMatchObject({ toothNumber: 47, surfaces: [] })
    await enable(false)
  })
})

describe("quitar por voz lo ya confirmado", () => {
  it("no se quita solo: queda propuesto; «Quitar del plan» lo cancela y «Dejarla» lo deja", async () => {
    await enable(true)
    const fx = await openSession("Endodoncia para quitar", "tooth")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const [endo, other] = (
      await segment({
        drafts: [
          { kind: "plan", payload: { service: "endodoncia para quitar", toothNumber: 36 } },
          { kind: "plan", payload: { service: "endodoncia para quitar", toothNumber: 46 } },
        ],
      })
    ).suggestions
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, endo!.id))
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, other!.id))
    const confirmed = await fx.run((tx) => listConfirmedDictation(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(confirmed.map((item) => item.id).sort()).toEqual([endo!.id, other!.id].sort())

    // «Quita también la endodoncia de la 36»: queda pedido, nada cambia todavía.
    const asked = await segment({ drafts: [], segmentId: randomUUID(), removals: [{ suggestionId: endo!.id, said: "quita también la endodoncia" }] })
    expect(asked).toMatchObject({ removed: [], undoRequested: [endo!.id] })
    const planItem = async (id: string) => (await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, id)))[0]
    const endoRow = (await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, endo!.id)))[0]!
    expect((await planItem(endoRow.entityId!))?.status).toBe("pendiente")

    await fx.run((tx) => undoConfirmedDictation(tx, ...fx.args, fx.encounter.id, endo!.id))
    expect(await planItem(endoRow.entityId!)).toMatchObject({ status: "cancelado", statusReason: "Se quitó al dictar: «quita también la endodoncia»" })

    // «Dejarla»: el pedido se va y el tratamiento sigue.
    await segment({ drafts: [], segmentId: randomUUID(), removals: [{ suggestionId: other!.id, said: "quita la de la 46" }] })
    await fx.run((tx) => keepConfirmedDictation(tx, ...fx.args, fx.encounter.id, other!.id))
    const otherRow = (await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, other!.id)))[0]!
    expect(otherRow.status).toBe("confirmada")
    expect((await planItem(otherRow.entityId!))?.status).toBe("pendiente")
    expect((await fx.run((tx) => listConfirmedDictation(tx, ORG, fx.patient.id, fx.encounter.id))).every((item) => item.undoRequest === null)).toBe(true)
    await enable(false)
  })
})

describe("lo que el asistente registra dos veces (dictados reales)", () => {
  it("la indicación que solo agrega la pieza corrige la que estaba; la repetida o el camino suelto no se registran", async () => {
    await enable(true)
    const fx = await openSession("Resina para repetir", "surfaces")
    await ownerDb.insert(serviceCatalog).values({ organizationId: ORG, name: "Funda metal base", scope: "tooth", source: "custom", priceCents: 90000, currency: "PEN" })
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const list = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))

    // «En la 36 resina, o si no una corona» y el modelo además registra la corona suelta, sin pieza.
    const first = await segment({
      drafts: [
        { kind: "plan", payload: { service: "funda metal base" } },
        { kind: "plan", payload: { service: "resina para repetir", toothNumber: 36, surfaces: ["oclusal"], alternatives: ["funda metal base"] } },
      ],
    })
    expect(first.suggestions).toHaveLength(1)
    expect(first.suggestions[0]?.payload["options"]).toEqual([expect.objectContaining({ serviceName: "Funda metal base" })])

    // Otra corona, ahora sin pieza y aparte: queda pendiente. «La corona es en la 25» la corrige,
    // y si además llega registrada otra vez en la 25, no se repite.
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, first.suggestions[0]!.id))
    const [loose] = (await segment({ drafts: [{ kind: "plan", payload: { service: "funda metal base" } }] })).suggestions
    // Sin pieza no frena: queda lista, con la pregunta a la vista.
    expect(loose).toMatchObject({ status: "lista", payload: { pending: ["toothNumber"] }, note: expect.stringContaining("¿En qué pieza?") })
    expect(dictationModelLabel(loose!, DENTAL_DICTATION)).toBe("Plan de tratamiento: Funda metal base · falta: la pieza")
    const fixed = await segment({ drafts: [{ kind: "plan", payload: { service: "funda metal base", toothNumber: 25 } }] })
    expect(fixed).toMatchObject({ suggestions: [], corrected: [loose!.id] })
    const again = await segment({
      corrections: [{ suggestionId: loose!.id, changes: { toothNumber: 25 } }],
      drafts: [{ kind: "plan", payload: { service: "funda metal base", toothNumber: 25 } }],
    })
    expect(again.suggestions).toEqual([])
    expect(await list()).toEqual([expect.objectContaining({ id: loose!.id, status: "lista", payload: expect.objectContaining({ toothNumber: 25 }) })])

    // La misma prestación en otra pieza sí es otra indicación.
    expect((await segment({ drafts: [{ kind: "plan", payload: { service: "funda metal base", toothNumber: 26 } }] })).suggestions).toHaveLength(1)
    await enable(false)
  })

  it("el mismo diagnóstico en la misma pieza no se repite; en otra pieza sí", async () => {
    await enable(true)
    const fx = await openSession("Obturación de diagnósticos")
    const segment = (drafts: Parameters<typeof saveDictationSegment>[5]["drafts"]) =>
      fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, { drafts }))
    expect((await segment([{ kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 } }])).suggestions).toHaveLength(1)
    expect((await segment([{ kind: "diagnostico", payload: { diagnosisCode: "k02.1", diagnosisType: "provisional", toothNumber: 16 } }])).suggestions).toEqual([])
    expect((await segment([{ kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 26 } }])).suggestions).toHaveLength(1)
    await enable(false)
  })
})

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
        { kind: "diagnostico", payload: { diagnosisCode: "k02.1", diagnosisType: "provisional", toothNumber: 16 }, sourceText: "En la dieciséis hay caries en dentina." },
        { kind: "diagnostico", payload: { diagnosisCode: "Z99.9", diagnosisType: "provisional" } },
        { kind: "plan", payload: { service: "resina compuesta", toothNumber: 16, surfaces: ["oclusal"] }, sourceText: "Le ponemos el tratamiento en la cara oclusal." },
        { kind: "plan", payload: { service: "Corona de zirconio", toothNumber: 36 } },
        { kind: "control", payload: { title: "Control en 6 meses", dueAt: inSixMonths() } },
        // Lo que no encaja en su operación no se pierde: queda por revisar.
        { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "seguro" } },
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
    expect(diagnosis).toMatchObject({ payload: { diagnosisCode: "K02.1", description: "Caries de la dentina", toothNumber: 16 }, summary: "K02.1 · Caries de la dentina\nPieza 16 · Presuntivo" })
    expect(unknownCode?.note).toContain("no está en la lista CIE-10 (OMS) de la clínica")
    // La prestación se reconoce por su nombre y trae la tarifa del tarifario, que no se dicta.
    expect(plan?.payload).toMatchObject({ serviceId: fx.service.id, serviceName: "Resina compuesta", priceCents: 120000, currency: "PEN" })
    expect(plan?.summary).toMatch(/^Resina compuesta · S\/\s1,200\.00\nPieza 16 · cara oclusal$/)
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
        { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 } },
        { kind: "plan", payload: { service: "Endodoncia multirradicular", toothNumber: 16 } },
        { kind: "plan", payload: { service: "Corona de zirconio", toothNumber: 36 } },
        { kind: "control", payload: { title: "Control en 6 meses", dueAt: due } },
        { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 26 } },
      ]),
    )
    const confirm = (id: string) => fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, id))

    await confirm(note!.id)
    const [session] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(session).toMatchObject({ reason: "Dolor al masticar", evolution: "Se realizó la limpieza de la cavidad." })

    await confirm(diagnosis!.id)
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toEqual([
      expect.objectContaining({ diagnosisCode: "K02.1", diagnosisType: "provisional", siteSystem: "ISO-3950", siteCode: "16" }),
    ])

    await confirm(plan!.id)
    const items = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.planId, fx.plan.id))
    expect(items).toEqual([expect.objectContaining({ serviceId: fx.service.id, siteSystem: "ISO-3950", siteCode: "16", sourceEncounterId: fx.encounter.id })])

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
        { kind: "nota", payload: { indications: "Tomar radiografía" } },
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
      { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "provisional" } },
    ]))
    expect(preview.map((item) => item.status)).toEqual(["lista", "lista"])
    expect((await ownerDb.select({ id: encounterDictationSuggestion.id }).from(encounterDictationSuggestion)).length).toBe(before)
    await enable(false)
  })

  it("mientras se dicta: un tramo no se guarda dos veces, una corrección por voz se puede deshacer y lo que se pide quitar se descarta", async () => {
    await enable(true)
    const fx = await openSession("Pulpotomía de urgencia")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const list = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    const first = randomUUID()
    const drafts = [
      { kind: "plan" as const, payload: { service: "Pulpotomía de urgencia", toothNumber: 25 }, sourceText: "En la veinticinco hacemos pulpotomía." },
      { kind: "diagnostico" as const, payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 } },
    ]
    const saved = await segment({ drafts, segmentId: first })
    expect(saved).toMatchObject({ repeated: false, corrected: [], removed: [] })
    const [plan, diagnosis] = saved.suggestions
    // Los datos del tramo no salen del servicio ni ensucian lo que entraría a la historia.
    expect(plan?.payload).not.toHaveProperty("_meta")
    expect(plan).toMatchObject({ voice: null, payload: { serviceScope: "tooth" } })
    // Al asistente se le nombra sin tarifa.
    expect(dictationModelLabel(plan!, DENTAL_DICTATION)).toBe("Plan de tratamiento: Pulpotomía de urgencia, Pieza 25")
    expect(dictationModelLabel(diagnosis!, DENTAL_DICTATION)).toBe("Diagnóstico: K02.1 Caries de la dentina, Pieza 16")

    // El mismo tramo reenviado (la respuesta se perdió): no duplica.
    expect(await fx.run((tx) => dictationSegmentSeen(tx, ORG, fx.patient.id, fx.encounter.id, first))).toBe(true)
    expect(await segment({ drafts, segmentId: first })).toEqual({ suggestions: [], corrected: [], removed: [], undoRequested: [], alreadyOnFile: [], repeated: true })
    expect(await list()).toHaveLength(2)

    // «No, es la veintiséis»: cambia la sugerencia y recuerda cómo estaba.
    const fixed = await segment({
      drafts: [],
      segmentId: randomUUID(),
      corrections: [
        { suggestionId: plan!.id, changes: { toothNumber: 26 } },
        // Lo que no encaja en la operación, lo que no cambia nada o apunta a otra atención se ignora.
        { suggestionId: diagnosis!.id, changes: { diagnosisType: "seguro" } },
        { suggestionId: diagnosis!.id, changes: { toothNumber: 16, inventado: "x" } },
        { suggestionId: randomUUID(), changes: { toothNumber: 11 } },
      ],
    })
    expect(fixed).toMatchObject({ suggestions: [], corrected: [plan!.id], removed: [] })
    const now = await list()
    const corrected = now.find((item) => item.id === plan!.id)
    const untouched = now.find((item) => item.id === diagnosis!.id)
    expect(corrected).toMatchObject({ status: "lista", payload: { toothNumber: 26, serviceId: fx.service.id }, voice: { before: "pieza 25" } })
    expect(untouched).toMatchObject({ payload: { diagnosisType: "provisional", toothNumber: 16 }, voice: null })

    // Deshacer vuelve a la pieza dictada primero; no hay nada más que deshacer.
    const undone = await fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, plan!.id))
    expect(undone).toMatchObject({ payload: { toothNumber: 25 }, voice: null })
    await expect(fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, plan!.id))).rejects.toMatchObject({ code: "NO_VOICE_CORRECTION" })

    // Corregida por voz y luego editada a mano: ya no se ofrece deshacer.
    await segment({ drafts: [], corrections: [{ suggestionId: plan!.id, changes: { toothNumber: 26 } }] })
    const edited = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, plan!.id, { detail: "Con aislamiento" }))
    expect(edited).toMatchObject({ payload: { toothNumber: 26, detail: "Con aislamiento" }, voice: null })

    // «Quita el diagnóstico»: sale de la lista sin entrar a la historia.
    const quita = { suggestionId: diagnosis!.id, said: "Quita el diagnóstico." }
    expect(await segment({ drafts: [], removals: [quita, { suggestionId: randomUUID(), said: "Quita lo otro." }] })).toMatchObject({ removed: [diagnosis!.id] })
    expect((await list()).map((item) => item.id)).toEqual([plan!.id])
    expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, fx.encounter.id))).toEqual([])
    // Queda a la vista, con lo que dijo, y «Deshacer» la devuelve como estaba (issue 135).
    const removedList = () => fx.run((tx) => listVoiceRemovedDictation(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(await removedList()).toEqual([expect.objectContaining({ id: diagnosis!.id, status: "descartada", removal: { said: "Quita el diagnóstico." } })])
    const back = await fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, diagnosis!.id))
    expect(back).toMatchObject({ status: "lista", removal: null, payload: { toothNumber: 16 } })
    expect(back.payload).not.toHaveProperty("_meta")
    expect(await removedList()).toEqual([])
    expect((await list()).map((item) => item.id).sort()).toEqual([plan!.id, diagnosis!.id].sort())
    // Descartada a mano no se ofrece deshacer: no fue la voz.
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, diagnosis!.id))
    expect(await removedList()).toEqual([])
    await expect(fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, diagnosis!.id))).rejects.toMatchObject({ code: "SUGGESTION_DECIDED" })

    // Confirmar lleva a la operación los campos de la sugerencia, sin sus metadatos.
    expect(await fx.run((tx) => countConfirmedDictation(tx, ORG, fx.patient.id, fx.encounter.id))).toBe(0)
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, plan!.id))
    expect(await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.planId, fx.plan.id))).toEqual([
      expect.objectContaining({ serviceId: fx.service.id, siteSystem: "ISO-3950", siteCode: "26", detail: "Con aislamiento" }),
    ])
    expect(await fx.run((tx) => countConfirmedDictation(tx, ORG, fx.patient.id, fx.encounter.id))).toBe(1)
    // La auditoría cuenta correcciones y descartes, sin texto.
    const audits = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.entityId, fx.encounter.id), eq(auditEvent.action, "encounter.dictation_suggested")))
    expect(audits.map((row) => row.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ count: 0, corrected: 1, removed: 0 }), expect.objectContaining({ removed: 1 })]))
    await enable(false)
  })
})

describe("alergias y lo hecho hoy por voz (issue 109)", () => {
  it("la alergia dictada avisa en la receta aunque no esté confirmada, entra con su código y no se repite", async () => {
    await enable(true)
    const fx = await openSession("Obturación de alergia")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const amoxicillin = { genericName: "amoxicilina", strength: "500 mg", dosageForm: "cápsula", dose: "1 cápsula", frequency: "cada 8 horas", duration: "7 días" }
    const [allergy, recipe] = (
      await segment({
        drafts: [
          { kind: "receta", payload: amoxicillin },
          { kind: "alergia", payload: { substance: "penicilina", reaction: "ronchas" }, sourceText: "es alérgica a la penicilina, le salieron ronchas" },
        ],
      })
    ).suggestions
    // La alergia va antes que la receta: la que se acaba de dictar ya avisa en el mismo tramo.
    expect(allergy).toMatchObject({ kind: "alergia", status: "lista", summary: "Alergia a penicilinas\nronchas", payload: { substanceSystem: "atc", substanceCode: "J01C", pending: ["severity"] } })
    expect(allergy!.note).toContain("¿Qué tan fuerte fue?")
    expect(recipe).toMatchObject({ kind: "receta", status: "por_revisar" })
    expect(recipe!.note).toContain("Aviso de la alergia que dictaste hoy")
    expect(dictationModelLabel(allergy!, DENTAL_DICTATION)).toBe("Alergias: penicilinas · falta: qué tan fuerte fue")

    // Un toque en «Severa» la completa; descartarla quita el aviso de la receta.
    const severe = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, allergy!.id, { severity: "severa" }))
    expect(severe).toMatchObject({ status: "lista", note: null, payload: { severity: "severa" } })
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, allergy!.id))
    const pending = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    expect((await pending()).find((item) => item.id === recipe!.id)).toMatchObject({ status: "lista", note: null })

    // Dicha otra vez y confirmada: entra a sus alergias con su código, y la receta avisa como siempre.
    const [again] = (await segment({ drafts: [{ kind: "alergia", payload: { substance: "Penicilina", severity: "moderada" } }] })).suggestions
    expect((await pending()).find((item) => item.id === recipe!.id)).toMatchObject({ status: "por_revisar" })
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, again!.id))
    const [row] = await ownerDb.select().from(patientAllergy).where(and(eq(patientAllergy.patientId, fx.patient.id), eq(patientAllergy.isActive, true)))
    expect(row).toMatchObject({ substanceSystem: "atc", substanceCode: "J01C", severity: "moderada" })
    expect((await pending()).find((item) => item.id === recipe!.id)?.note).toContain("Aviso de alergia:")

    // Ya registrada: no se propone otra vez, se avisa. «Niega alergias» con alergias es «Sin alergias nuevas».
    const known = await segment({ drafts: [{ kind: "alergia", payload: { substance: "penicilinas" } }, { kind: "alergia", payload: { none: true } }] })
    expect(known.alreadyOnFile).toEqual(["penicilinas"])
    expect(known.suggestions).toMatchObject([{ kind: "alergia", summary: "Sin alergias nuevas" }])
    await ownerDb.update(patient).set({ allergiesReviewedAt: null }).where(eq(patient.id, fx.patient.id))
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, known.suggestions[0]!.id))
    expect((await ownerDb.select({ at: patient.allergiesReviewedAt }).from(patient).where(eq(patient.id, fx.patient.id)))[0]?.at).not.toBeNull()

    // «No, no era alérgica»: lo confirmado no se quita solo; «Quitar de sus alergias» la quita como error.
    const asked = await segment({ drafts: [], segmentId: randomUUID(), removals: [{ suggestionId: again!.id, said: "no, no era alérgica" }] })
    expect(asked.undoRequested).toEqual([again!.id])
    await fx.run((tx) => undoConfirmedDictation(tx, ...fx.args, fx.encounter.id, again!.id))
    expect((await ownerDb.select().from(patientAllergy).where(eq(patientAllergy.id, row!.id)))[0]).toMatchObject({ isActive: false, removedReason: "error" })
    await enable(false)
  })

  it("lo hecho hoy sale del plan (y lo acepta al hacerlo), de los servicios o queda como acto libre; sin pieza, se pregunta", async () => {
    await enable(true)
    const fx = await openSession("Resina hecha hoy", "tooth")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))

    // Sin pieza: lo hecho sí la necesita, se pregunta.
    const [noTooth] = (await segment({ drafts: [{ kind: "procedimiento", payload: { service: "resina hecha hoy" } }] })).suggestions
    expect(noTooth).toMatchObject({ status: "por_revisar", note: "¿En qué pieza lo hiciste? Tócala o dila.", payload: { source: "servicio", pending: ["toothNumber"] } })
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, noTooth!.id))

    // Indicada hoy en la 36, aún sin aceptar: «le hice la resina de la 36» sale de ese tratamiento.
    const [indicated] = (await segment({ drafts: [{ kind: "plan", payload: { service: "resina hecha hoy", toothNumber: 36 } }] })).suggestions
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, indicated!.id))
    const [done, direct, free] = (
      await segment({
        drafts: [
          { kind: "procedimiento", payload: { service: "resina hecha hoy", toothNumber: 36 } },
          { kind: "procedimiento", payload: { service: "resina hecha hoy", toothNumber: 46 } },
          { kind: "procedimiento", payload: { service: "pulido de bordes incisales" } },
        ],
      })
    ).suggestions
    const planRow = (await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, indicated!.id)))[0]!
    expect(done).toMatchObject({ status: "lista", payload: { source: "plan", planItemId: planRow.entityId, acceptOnDo: true, toothNumber: 36 } })
    expect(done!.note).toContain("queda aceptado y hecho")
    expect(done!.summary).toContain("Hecho hoy · Resina hecha hoy")
    expect(direct).toMatchObject({ status: "lista", payload: { source: "servicio", serviceId: fx.service.id, toothNumber: 46 } })
    expect(free).toMatchObject({ status: "lista", payload: { source: "libre" } })
    expect(free!.note).toContain("No está en tus servicios")

    for (const item of [done, direct, free]) await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, item!.id))
    expect((await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, planRow.entityId!)))[0]).toMatchObject({ decisionStatus: "aceptado", decisionNote: "Aceptado al hacerlo en la atención" })
    const procedures = await ownerDb.select().from(encounterProcedure).where(eq(encounterProcedure.encounterId, fx.encounter.id))
    expect(procedures.map((row) => [row.planItemId === planRow.entityId, row.serviceId, row.priceCents === null]).sort()).toEqual(
      [[true, fx.service.id, false], [false, fx.service.id, false], [false, null, true]].sort(),
    )

    // «No, eso no se hizo» sobre uno ya confirmado: «Anular el procedimiento».
    await segment({ drafts: [], segmentId: randomUUID(), removals: [{ suggestionId: free!.id, said: "no, el pulido no se hizo" }] })
    await fx.run((tx) => undoConfirmedDictation(tx, ...fx.args, fx.encounter.id, free!.id))
    const freeRow = (await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, free!.id)))[0]!
    expect((await ownerDb.select().from(encounterProcedure).where(eq(encounterProcedure.id, freeRow.entityId!)))[0]?.voidedAt).not.toBeNull()
    await enable(false)
  })
})

describe("la próxima cita y el presupuesto por voz (issue 109, paso 2)", () => {
  /** Una sede con su unidad dental y el horario de quien atiende: lunes a domingo, de 9 a 18. */
  async function withAgenda(fx: Awaited<ReturnType<typeof openSession>>) {
    const [place] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${fx.actor.slice(0, 6)}`, timezone: "America/Lima" }).returning()
    await ownerDb.update(encounter).set({ branchId: place!.id }).where(eq(encounter.id, fx.encounter.id))
    await fx.run(async (tx) => {
      await createRoom(tx, ORG, { branchId: place!.id, name: "Unidad dental 1" })
      await setProfessionalSchedule(tx, ORG, fx.actor, {
        branchId: place!.id,
        professionalUserId: fx.actor,
        rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 })),
      })
    })
    return place!
  }
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const at = (date: string, time: string) => zonedTimeToUtc(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), "America/Lima").toISOString()

  it("«cítalo en quince días» propone tu primer hueco y otros para tocar; reservar es «Nueva cita»; si se ocupó, deja el más cercano", async () => {
    await enable(true)
    const fx = await openSession("Obturación de cita")
    const place = await withAgenda(fx)
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    const day = inDays(15)
    const [first] = (await segment({ drafts: [{ kind: "cita", payload: { date: day, service: "obturación de cita" } }] })).suggestions
    expect(first).toMatchObject({ kind: "cita", status: "lista", note: null, payload: { startsAt: at(day, "09:00"), serviceId: fx.service.id, branchId: place.id } })
    expect(first!.payload["slots"]).toHaveLength(3)
    expect(first!.summary).toContain("Cita · ")
    await fx.run((tx) => discardDictationSuggestion(tx, ...fx.args, fx.encounter.id, first!.id))

    // Con la hora dicha, esa; tocar otro de los huecos lo deja elegido.
    const [timed] = (await segment({ drafts: [{ kind: "cita", payload: { date: day, time: "16:00" } }] })).suggestions
    expect(timed).toMatchObject({ status: "lista", note: null, payload: { startsAt: at(day, "16:00") } })
    const other = (timed!.payload["slots"] as string[]).find((startsAt) => startsAt !== at(day, "16:00"))!
    const picked = await fx.run((tx) => updateDictationSuggestion(tx, ...fx.args, fx.encounter.id, timed!.id, { startsAt: other }))
    expect(picked.payload["startsAt"]).toBe(other)

    // Ese hueco se ocupa mientras atiende: no se reserva, queda el más cercano con el aviso.
    const [someone] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Otra persona", patientNumber: await nextPatientNumber(ownerDb, ORG) })
    await fx.run((tx) => createAppointment(tx, ORG, fx.actor, { patientId: someone!.id, professionalUserId: fx.actor, branchId: place.id, startsAt: other, durationMin: 60 }))
    const moved = await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, timed!.id))
    expect(moved.status).toBe("lista")
    expect(moved.note).toContain("se ocupó")
    expect(moved.payload["startsAt"]).not.toBe(other)

    // Ahora sí: se reserva con quien atiende, en su sede.
    const booked = await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, timed!.id))
    expect(booked.status).toBe("confirmada")
    const [row] = await ownerDb.select().from(appointment).where(and(eq(appointment.patientId, fx.patient.id), eq(appointment.organizationId, ORG)))
    expect(row).toMatchObject({ professionalUserId: fx.actor, branchId: place.id, status: "programada" })
    expect(row!.startsAt.toISOString()).toBe(moved.payload["startsAt"])

    // Ya tiene cita cerca de ese día: no se reserva otra, se usa esa.
    const [again] = (await segment({ drafts: [{ kind: "cita", payload: { date: day } }] })).suggestions
    expect(again).toMatchObject({ status: "lista", payload: { existing: { id: row!.id } } })
    expect(again!.note).toContain("no se reserva otra")
    await enable(false)
  })

  it("«arma el presupuesto» lleva lo indicado hoy y lo dictado; armarlo confirma lo dictado y deja el borrador, sin enviar nada", async () => {
    await enable(true)
    const fx = await openSession("Corona para presupuestar", "tooth")
    const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
    // Nada con precio todavía: se dice, sin armar un presupuesto vacío.
    const [empty] = (await segment({ drafts: [{ kind: "presupuesto", payload: { show: true } }] })).suggestions
    expect(empty).toMatchObject({ kind: "presupuesto", status: "por_revisar" })
    expect(empty!.note).toContain("Aún no hay nada con precio")

    const [confirmedPlan] = (await segment({ drafts: [{ kind: "plan", payload: { service: "corona para presupuestar", toothNumber: 36 } }] })).suggestions
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, confirmedPlan!.id))
    const [dictated] = (await segment({ drafts: [{ kind: "plan", payload: { service: "corona para presupuestar", toothNumber: 46 } }] })).suggestions
    // El pedido que esperaba se puso al día: lo indicado hoy y lo dictado.
    const request = (await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).find((item) => item.id === empty!.id)!
    expect(request).toMatchObject({ status: "lista", payload: { totalCents: 240000, currency: "PEN" } })
    expect((request.payload["lines"] as Array<{ dictated: boolean }>).map((line) => line.dictated).sort()).toEqual([false, true])
    expect(request.summary).toContain("Presupuesto · 2 tratamientos")

    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, request.id))
    const draft = await fx.run((tx) => findDraftBudget(tx, ORG, fx.patient.id))
    expect(draft).not.toBeNull()
    expect(draft!.status).toBe("borrador")
    const lines = await ownerDb.select().from(treatmentBudgetItem).where(eq(treatmentBudgetItem.budgetId, draft!.id))
    expect(new Set(lines.map((line) => line.planItemId)).size).toBe(2)
    // Lo dictado quedó confirmado al armarlo.
    expect((await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.id, dictated!.id)))[0]?.status).toBe("confirmada")
    await enable(false)
  })
})
