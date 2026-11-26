import { withOrgContext } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { confirmDictationSuggestion, listDictationSuggestions, saveDictationSegment } from "./encounter-dictation.js"
import { clinicToday } from "./inventory-stock.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Mesa del 25 nov 2026 («salud y familia», entrega 3): odentIA dicta el peso y la presión. Antes, el
 * peso medido en la balanza se perdía sin aviso y «Anestesia local» quedaba sin dosis máxima.
 */
setupTestDb()
const ORG = "org_a"
const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

async function tomas() {
  const fx = await clinicalFixture()
  // Tomás tiene 7 años.
  const today = await fx.run((tx) => clinicToday(tx, ORG))
  const born = `${Number(today.slice(0, 4)) - 7}-01-01`
  const birth = born > today ? `${Number(today.slice(0, 4)) - 8}-01-01` : born
  await ownerDb.update(contact).set({ birthDate: birth }).where(eq(contact.id, fx.patient.personId))
  const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
  const signs = async () => (await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).filter((item) => item.kind === "signos")
  return { fx, segment, signs }
}

describe("C5 · el peso medido en odentIA", () => {
  it("«en la balanza pesa 23» llega a los signos de la atención con un clic, junto a la presión", async () => {
    await enable(true)
    const { fx, segment, signs } = await tomas()
    await segment({
      drafts: [{ kind: "signos", payload: { peso: 23, presionSistolica: 100, presionDiastolica: 65 }, sourceText: "en la balanza pesa veintitrés, presión cien con sesenta y cinco" }],
      transcript: "En la balanza pesa veintitrés, presión cien con sesenta y cinco.",
    })
    const [one] = await signs()
    expect(one?.status).toBe("lista")
    expect(one?.summary).toContain("23")
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, one!.id))
    const [row] = await ownerDb.select({ vitals: encounter.vitals }).from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(row?.vitals).toMatchObject({ peso: 23, presionSistolica: 100, presionDiastolica: 65 })
    await enable(false)
  })

  it("«230 kg» a los 7 años queda por revisar, con su aviso; lo que no dicta odentIA no se propone", async () => {
    await enable(true)
    const { segment, signs } = await tomas()
    await segment({
      drafts: [{ kind: "signos", payload: { peso: 230, temperatura: 37 }, sourceText: "pesa doscientos treinta" }],
      transcript: "Pesa doscientos treinta.",
    })
    const [one] = await signs()
    expect(one?.status).toBe("por_revisar")
    expect(one?.note).toContain("230 kg no es un peso posible a los 7 años")
    expect(one?.payload).toEqual({ peso: 230 })
    await enable(false)
  })
})
