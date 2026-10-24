import { withOrgContext } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { upsertAgentConfig } from "../agentConfig.js"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import {
  confirmDictationSuggestion,
  dictationModelLabel,
  listDictationSuggestions,
  saveDictationSegment,
  settleDictationMedicalLeave,
} from "../encounter-dictation.js"
import { createMedicalLeave } from "../medical-leaves.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { MEDICAL_DICTATION } from "./dictation.js"

/** Clío médica (issue 229, entrega 10): lo dictado de un consultorio queda como sugerencia y entra a la atención al confirmarlo. */
setupTestDb()
const ORG = "org_a"
const setProduct = (product: "dental" | "medical") =>
  ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, ORG))
const enable = (on: boolean) =>
  withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

beforeAll(async () => {
  await seedDiagnosisCodes([{ code: "J03.9", title: "Amigdalitis aguda, no especificada" }])
})

describe("Clío médica (issue 229, entrega 10)", () => {
  it("los signos, el examen y el descanso dictados se revisan, se confirman sin pisar lo que había y el descanso se emite aparte", async () => {
    await setProduct("medical")
    await enable(true)
    try {
      const fx = await clinicalFixture()
      // Lo que ya tenía la atención: el peso y la piel.
      await ownerDb
        .update(encounter)
        .set({
          vitals: { peso: 62 },
          examination: { sistemas: { piel: { estado: "sin_alteraciones" } } },
        })
        .where(eq(encounter.id, fx.encounter.id))
      const segment = (input: Parameters<typeof saveDictationSegment>[5]) =>
        fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
      const saved = await segment({
        drafts: [
          {
            kind: "signos",
            payload: { presionSistolica: 118, presionDiastolica: 76, temperatura: 38.5 },
            sourceText: "Presión 118 con 76, temperatura 38 y medio.",
          },
          {
            kind: "examen",
            payload: {
              system: "bocaGarganta",
              state: "con_hallazgos",
              finding: "Amígdalas aumentadas, con placas blanquecinas.",
            },
          },
          // Por su nombre también vale; normal no lleva texto.
          {
            kind: "examen",
            payload: {
              system: "Tórax y pulmones",
              state: "sin_alteraciones",
              finding: "Pulmones limpios",
            },
          },
          { kind: "examen", payload: { system: "abdomen", state: "con_hallazgos" } },
          {
            kind: "examen",
            payload: { system: "rodilla", state: "con_hallazgos", finding: "Derrame" },
          },
          { kind: "signos", payload: { presionSistolica: 118 } },
          // Sin «dónde» (decisión 4): una pieza que llegue se quita.
          {
            kind: "diagnostico",
            payload: { diagnosisCode: "J03.9", diagnosisType: "provisional", toothNumber: 16 },
          },
          // Lo indicado no espera un presupuesto (decisión 15): sin otros caminos que elegir.
          {
            kind: "plan",
            payload: { service: "Tratamiento propio", alternatives: ["Otro tratamiento"] },
          },
          { kind: "descanso", payload: { days: 3 }, sourceText: "Descanso de tres días." },
          // Lo dental no es de latidIA: no se guarda.
          { kind: "odontograma", payload: { toothNumber: 36, condition: "caries" } },
        ],
      })
      const [vitals, throat, lungs, abdomen, knee, half, diagnosis, plan, leave] = saved.suggestions
      expect(saved.suggestions).toHaveLength(9)
      expect(vitals).toMatchObject({
        status: "lista",
        payload: { presionSistolica: 118, presionDiastolica: 76, temperatura: 38.5 },
        summary: "PA 118/76 mmHg · T 38.5 °C",
      })
      expect(dictationModelLabel(vitals!, MEDICAL_DICTATION)).toBe(
        "Signos vitales: PA 118/76 mmHg · T 38.5 °C",
      )
      expect(throat).toMatchObject({
        status: "lista",
        payload: {
          system: "bocaGarganta",
          state: "con_hallazgos",
          finding: "Amígdalas aumentadas, con placas blanquecinas.",
        },
        summary: "Boca y garganta · con hallazgos\nAmígdalas aumentadas, con placas blanquecinas.",
      })
      expect(lungs).toMatchObject({
        status: "lista",
        payload: { system: "toraxPulmones", state: "sin_alteraciones" },
        summary: "Tórax y pulmones · sin alteraciones",
      })
      expect(lungs?.payload).not.toHaveProperty("finding")
      expect(abdomen).toMatchObject({
        status: "por_revisar",
        note: "Dijiste que hay hallazgos, pero no cuáles. Escríbelos.",
      })
      expect(knee?.note).toContain("No reconozco «rodilla»")
      expect(half).toMatchObject({ status: "por_revisar" })
      expect(half?.note).toContain("presión arterial completa")
      expect(diagnosis).toMatchObject({ status: "lista", payload: { diagnosisCode: "J03.9" } })
      expect(diagnosis?.payload).not.toHaveProperty("toothNumber")
      expect(plan).toMatchObject({ status: "lista", payload: { serviceId: fx.service.id } })
      expect(plan?.payload).not.toHaveProperty("options")
      expect(leave).toMatchObject({
        status: "lista",
        payload: { days: 3 },
        summary: "3 días desde hoy",
      })

      // «No, la temperatura es 38,4»: se corrige y se puede ver qué decía antes.
      const corrected = await segment({
        drafts: [],
        corrections: [{ suggestionId: vitals!.id, changes: { temperatura: 38.4 } }],
      })
      expect(corrected.corrected).toEqual([vitals!.id])
      const fixed = (
        await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
      ).find((item) => item.id === vitals!.id)
      expect(fixed).toMatchObject({
        summary: "PA 118/76 mmHg · T 38.4 °C",
        voice: { before: "T 38.5 °C" },
      })

      // Confirmar suma a lo que ya tenía la atención: el peso y la piel se quedan.
      await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, vitals!.id))
      await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, throat!.id))
      await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, lungs!.id))
      const [row] = await ownerDb
        .select({ vitals: encounter.vitals, examination: encounter.examination })
        .from(encounter)
        .where(eq(encounter.id, fx.encounter.id))
      expect(row?.vitals).toEqual({
        peso: 62,
        presionSistolica: 118,
        presionDiastolica: 76,
        temperatura: 38.4,
      })
      expect(row?.examination).toEqual({
        sistemas: {
          piel: { estado: "sin_alteraciones" },
          bocaGarganta: {
            estado: "con_hallazgos",
            hallazgo: "Amígdalas aumentadas, con placas blanquecinas.",
          },
          toraxPulmones: { estado: "sin_alteraciones" },
        },
      })

      // El descanso no se confirma: se emite firmado, y su sugerencia queda con él.
      await expect(
        fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, leave!.id)),
      ).rejects.toMatchObject({
        code: "MEDICAL_LEAVE_NEEDS_ISSUE",
      })
      const issued = await fx.run((tx) =>
        createMedicalLeave(tx, ...fx.args, { encounterId: fx.encounter.id, days: 3 }),
      )
      expect(
        await fx.run((tx) =>
          settleDictationMedicalLeave(tx, ...fx.args, fx.encounter.id, issued.id),
        ),
      ).toEqual({ settled: 1 })
      const left = await fx.run((tx) =>
        listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id),
      )
      expect(left.map((item) => item.kind)).not.toContain("descanso")
    } finally {
      await enable(false)
      await setProduct("dental")
    }
  })
})
