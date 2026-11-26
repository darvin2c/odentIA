import { withOrgContext } from "@odentia/db"
import { patientFamilyHistory, patientHealthDeclaration, patientMedication } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { getPatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { confirmDictationHealth, confirmSaidStopped, listDictationSuggestions, saveDictationSegment } from "./encounter-dictation.js"
import { clinicToday } from "./inventory-stock.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Mesa del 25 nov 2026 («salud y familia», entrega 2): lo que se dice en la consulta tiene su lugar.
 * Antes, lo de un familiar iba a «No lo usé» y se anotaba a mano (unos 5 clics por familiar), y «ya no
 * toma apixabán, ahora aspirina» dejaba los dos vigentes, con dos avisos en la exodoncia.
 */
setupTestDb()
const ORG = "org_a"

const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))
const setProduct = (product: "dental" | "medical") => ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, ORG))

async function session() {
  const fx = await clinicalFixture()
  const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
  const health = async () => (await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))).filter((item) => item.kind === "salud")
  const confirm = (id: string) => fx.run((tx) => confirmDictationHealth(tx, ...fx.args, fx.encounter.id, id))
  const family = () => ownerDb.select().from(patientFamilyHistory).where(eq(patientFamilyHistory.patientId, fx.patient.id))
  const medicines = () => ownerDb.select().from(patientMedication).where(eq(patientMedication.patientId, fx.patient.id))
  return { fx, segment, health, confirm, family, medicines }
}

describe("C5 y C6 · lo de su familia", () => {
  it("«su hermana tuvo cáncer de boca» se revisa con «Lo revisé con…» y se suma a sus familiares, sin rehacerlos ni declararlo como suyo", async () => {
    await enable(true)
    const { fx, segment, health, confirm, family } = await session()
    // Ya tenía anotado a su padre: no se borra ni se repite.
    await ownerDb.insert(patientFamilyHistory).values({ organizationId: ORG, patientId: fx.patient.id, relationship: "FTH", condition: "diabetes" })
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: {
            declarante: "acompanante",
            vinculo: "hija",
            family: [
              { relation: "hermana", name: "cáncer de boca" },
              { relation: "padre", name: "diabetes" },
            ],
          },
          sourceText: "y su hermana tuvo cáncer de boca, su papá era diabético",
        },
      ],
      transcript: "Y su hermana tuvo cáncer de boca, su papá era diabético.",
    })
    const [said] = await health()
    expect(said?.healthRows?.filter((row) => row.group === "family").map((row) => `${row.label}: ${row.value}`)).toEqual(["Hermana: cáncer de boca"])
    expect(said?.summary).not.toContain("Enfermedades")

    const confirmed = await confirm(said!.id)
    expect(confirmed.status).toBe("confirmada")
    const rows = (await family()).map((row) => `${row.relationship}: ${row.condition}`).sort()
    expect(rows).toEqual(["FTH: diabetes", "SIB: cáncer de boca"])
    // No es una declaración de su propia salud, ni pide revisar sus antecedentes.
    expect(await ownerDb.select().from(patientHealthDeclaration).where(eq(patientHealthDeclaration.patientId, fx.patient.id))).toEqual([])
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.conditions).toEqual([])
    await enable(false)
  })
})

describe("C7 · «ya no toma apixabán, ahora aspirina»", () => {
  it("la aspirina entra con «Lo revisé con…»; el apixabán espera su «Sí, lo dejó», y termina el día anterior al que se dijo", async () => {
    await enable(true)
    const { fx, segment, health, confirm, medicines } = await session()
    await ownerDb.insert(patientMedication).values({ organizationId: ORG, patientId: fx.patient.id, name: "apixabán", atcCode: "B01AF02" })
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: { declarante: "acompanante", vinculo: "hija", anticoagulants: { state: "recorded", detail: "aspirina 100 mg" }, stopped: [{ name: "apixabán" }] },
          sourceText: "el cardiólogo le cambió el apixabán por aspirina cien",
        },
      ],
      transcript: "El cardiólogo le cambió el apixabán por aspirina cien.",
    })
    const [said] = await health()
    const stopped = said?.healthRows?.find((row) => row.group === "stopped")
    expect(stopped).toMatchObject({ label: "Ya no toma", value: "apixabán", stopped: true })

    // «Lo revisé con…» guarda la aspirina y deja esperando lo que dejó: no lo da por dejado de paso.
    const reviewed = await confirm(said!.id)
    expect(reviewed.status).toBe("lista")
    const today = await fx.run((tx) => clinicToday(tx, ORG))
    expect((await medicines()).filter((row) => !row.endDate || row.endDate >= today).map((row) => row.name).sort()).toEqual(["apixabán", "aspirina 100 mg"])

    await fx.run((tx) => confirmSaidStopped(tx, ...fx.args, said!.id, stopped!.key))
    const yesterday = new Date(`${today}T12:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const apixaban = (await medicines()).find((row) => row.name === "apixabán")
    expect(apixaban?.endDate).toBe(yesterday.toISOString().slice(0, 10))
    // Un solo antitrombótico vigente, y lo dicho ya no espera nada.
    const health2 = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(health2.medications.filter((row) => !row.endDate || row.endDate >= today).map((row) => row.name)).toEqual(["aspirina 100 mg"])
    expect(await health()).toEqual([])
    // Otra vez, ya no está: no se termina dos veces.
    await expect(fx.run((tx) => confirmSaidStopped(tx, ...fx.args, said!.id, stopped!.key))).rejects.toMatchObject({ code: "SUGGESTION_DECIDED" })
    await enable(false)
  })

  it("lo que dejó y no estaba en Antecedentes queda anotado ya terminado; con «Lo revisé con…» solo, no se puede", async () => {
    await enable(true)
    const { fx, segment, health, confirm, medicines } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", stopped: [{ name: "metformina" }] }, sourceText: "ya no tomo la metformina" }],
      transcript: "Ya no tomo la metformina.",
    })
    const [said] = await health()
    await expect(confirm(said!.id)).rejects.toMatchObject({ code: "HEALTH_ONLY_DENIALS", message: "Lo que ya no toma se confirma en su fila, con «Sí, lo dejó»." })
    const key = said!.healthRows!.find((row) => row.group === "stopped")!.key
    await fx.run((tx) => confirmSaidStopped(tx, ...fx.args, said!.id, key))
    const [row, ...more] = await medicines()
    expect(more).toEqual([])
    expect(row?.name).toBe("metformina")
    expect(row?.endDate).not.toBeNull()
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    const today = await fx.run((tx) => clinicToday(tx, ORG))
    expect(after.medications.filter((one) => !one.endDate || one.endDate >= today)).toEqual([])
    await enable(false)
  })
})

describe("C8 · latidIA, control prenatal", () => {
  it("con el embarazo y la FUR dichos, sus semanas salen de la FUR y la receta lo ve", async () => {
    await setProduct("medical")
    await enable(true)
    const { fx, segment, health, confirm } = await session()
    const today = await fx.run((tx) => clinicToday(tx, ORG))
    const fur = new Date(`${today}T12:00:00Z`)
    fur.setUTCDate(fur.getUTCDate() - 70)
    const day = fur.toISOString().slice(0, 10)
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", personal: { embarazo: true }, gyneco: { fur: day } }, sourceText: "mi última regla fue hace diez semanas, es mi segundo embarazo" }],
      transcript: "Mi última regla fue hace diez semanas, es mi segundo embarazo.",
    })
    const [said] = await health()
    expect(said?.healthRows?.map((row) => row.label)).toEqual(expect.arrayContaining(["Embarazo", "Última regla"]))
    await confirm(said!.id)
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.pregnancy).toMatchObject({ state: "vigente", weeksToday: 10 })
    await enable(false)
    await setProduct("dental")
  })
})
