import { withOrgContext } from "@odentia/db"
import { encounter, patientAnamnesis, patientFamilyHistory, patientHealthDeclaration, patientMedication, patientRegistration } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { getPatientHealth, savePatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { confirmDictationHealth, confirmSaidHealth, confirmSaidStopped, dictatedHealthInterview, listDictationSuggestions, listSaidHealth, saveDictationSegment } from "./encounter-dictation.js"
import { finalizeEncounter } from "./encounters.js"
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
    expect((await medicines()).filter((row) => !row.endDate || row.endDate >= today).map((row) => row.name).sort()).toEqual(["apixabán", "aspirina"])

    await fx.run((tx) => confirmSaidStopped(tx, ...fx.args, said!.id, stopped!.key))
    const yesterday = new Date(`${today}T12:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const apixaban = (await medicines()).find((row) => row.name === "apixabán")
    expect(apixaban?.endDate).toBe(yesterday.toISOString().slice(0, 10))
    // Un solo antitrombótico vigente, y lo dicho ya no espera nada.
    const health2 = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(health2.medications.filter((row) => !row.endDate || row.endDate >= today).map((row) => row.name)).toEqual(["aspirina"])
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

/* Revisión con ojos nuevos del 25 nov: lo que la entrega dejaba mal. */
describe("revisión del 25 nov", () => {
  it("«eso es mío», dicho por la madre, no se lleva lo de su familia; «no, la penicilina no» sí lo quita", async () => {
    await enable(true)
    const { segment, health } = await session()
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: { declarante: "acompanante", vinculo: "madre", family: [{ relation: "papá", of: "paciente", name: "alergia a la penicilina" }] },
          sourceText: "su papá es alérgico a la penicilina",
        },
      ],
      transcript: "Su papá es alérgico a la penicilina.",
    })
    const [said] = await health()
    // Clío lee «eso es mío» como un «quitar»: la frase no nombra nada de lo propuesto, y no se quita.
    await segment({ drafts: [], removals: [{ suggestionId: said!.id, said: "yo soy diabética, eso es mío" }], transcript: "Yo soy diabética, eso es mío." })
    const [kept] = await health()
    expect(kept?.status).not.toBe("descartada")
    expect(kept?.healthRows?.filter((row) => row.group === "family").map((row) => `${row.label}: ${row.value}`)).toEqual(["Papá: alergia a la penicilina"])
    // Lo que nombra, sí: sin nada más, la propuesta se quita entera, como antes.
    await segment({ drafts: [], removals: [{ suggestionId: said!.id, said: "no, lo de la penicilina no" }], transcript: "No, lo de la penicilina no." })
    expect((await health()).filter((item) => item.status !== "descartada")).toEqual([])
    await enable(false)
  })

  it("la dosis dicha en palabras queda en su campo al revisarlo («apixabán de cinco cada doce horas»)", async () => {
    await enable(true)
    const { segment, health, confirm, medicines } = await session()
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán de cinco miligramos cada doce horas" } },
          sourceText: "tomo apixaban de cinco miligramos cada doce horas",
        },
      ],
      transcript: "Tomo apixaban de cinco miligramos cada doce horas.",
    })
    const [said] = await health()
    expect(said?.healthRows?.find((row) => row.group === "anticoagulants")?.value).toBe("apixabán 5 mg cada 12 h")
    await confirm(said!.id)
    expect((await medicines()).map((row) => [row.name, row.dose, row.frequency])).toEqual([["apixabán", "5 mg", "cada 12 h"]])
    await enable(false)
  })

  it("«toma apixabán» firmado otro día y hoy «ya no toma apixabán»: lo de antes queda atrás y no se registra como vigente", async () => {
    await enable(true)
    const { fx, segment, medicines } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } }, sourceText: "tomo apixabán" }],
      transcript: "Tomo apixabán.",
    })
    await fx.ready(fx.encounter.id)
    await fx.run((tx) => finalizeEncounter(tx, ...fx.args, fx.encounter.id))
    const [second] = await ownerDb.insert(encounter).values({ organizationId: ORG, patientId: fx.patient.id, professionalUserId: fx.actor, reason: "Control" }).returning()
    const [today] = (
      await fx.run((tx) =>
        saveDictationSegment(tx, ...fx.args, second!.id, {
          drafts: [{ kind: "salud", payload: { declarante: "paciente", stopped: [{ name: "apixabán" }] }, sourceText: "ya no tomo el apixabán" }],
          transcript: "Ya no tomo el apixabán.",
        }),
      )
    ).suggestions
    const [before] = await fx.run((tx) => listSaidHealth(tx, ORG, fx.patient.id))
    expect(before?.rows.find((row) => row.key === "anticoagulants")?.newer).toBeTruthy()
    // Lo de antes, revisado ahora, ya no registra el apixabán como vigente.
    await expect(fx.run((tx) => confirmSaidHealth(tx, ...fx.args, before!.suggestionId))).resolves.toBeTruthy()
    expect(await medicines()).toEqual([])
    const key = today!.healthRows!.find((row) => row.group === "stopped")!.key
    await fx.run((tx) => confirmSaidStopped(tx, ...fx.args, today!.id, key))
    expect((await medicines()).map((row) => [row.name, !!row.endDate])).toEqual([["apixabán", true]])
    expect(await fx.run((tx) => listSaidHealth(tx, ORG, fx.patient.id))).toEqual([])
    await enable(false)
  })

  it("latidIA: la última regla dicha sola queda en su entrevista; «Corregir algo» la trae", async () => {
    await setProduct("medical")
    await enable(true)
    const { fx, segment, health, confirm } = await session()
    const today = await fx.run((tx) => clinicToday(tx, ORG))
    const fur = new Date(`${today}T12:00:00Z`)
    fur.setUTCDate(fur.getUTCDate() - 20)
    const day = fur.toISOString().slice(0, 10)
    await segment({
      drafts: [
        { kind: "salud", payload: { declarante: "paciente", gyneco: { fur: day }, family: [{ relation: "madre", name: "hipertensión" }] }, sourceText: "mi última regla fue hace veinte días, mi mamá es hipertensa" },
      ],
      transcript: "Mi última regla fue hace veinte días, mi mamá es hipertensa.",
    })
    const [said] = await health()
    expect(await fx.run((tx) => dictatedHealthInterview(tx, ORG, said!.payload))).toMatchObject({ ginecoObstetricos: { fur: day } })
    await confirm(said!.id)
    const [latest] = await ownerDb.select().from(patientAnamnesis).where(eq(patientAnamnesis.patientId, fx.patient.id))
    expect(latest?.answers).toMatchObject({ ginecoObstetricos: { fur: day } })
    await enable(false)
    await setProduct("dental")
  })

  it("con Antecedentes abierto desde antes, guardarlo no borra la familia sumada ni vuelve vigente lo que dejó", async () => {
    await enable(true)
    const { fx, segment, health, confirm } = await session()
    const stale = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", family: [{ relation: "padre", name: "diabetes" }] }, sourceText: "mi papá es diabético" }],
      transcript: "Mi papá es diabético.",
    })
    const [said] = await health()
    await confirm(said!.id)
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.revision).toBeGreaterThan(stale.revision)
    await expect(
      fx.run((tx) =>
        savePatientHealth(tx, ORG, fx.actor, fx.patient.id, { expectedRevision: stale.revision, allergies: [], conditions: [], medications: [], familyHistory: [] } as never),
      ),
    ).rejects.toMatchObject({ status: 409 })
    await enable(false)
  })

  it("«Sí, lo dejó» de lo dicho antes no termina la que volvió a tomar después", async () => {
    await enable(true)
    const { fx, segment, health, medicines } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", stopped: [{ name: "metformina" }] }, sourceText: "ya no tomo la metformina" }],
      transcript: "Ya no tomo la metformina.",
    })
    const [said] = await health()
    // Anotada después, con fecha de inicio desde el día en que lo dijo.
    const today = await fx.run((tx) => clinicToday(tx, ORG))
    await ownerDb.insert(patientMedication).values({ organizationId: ORG, patientId: fx.patient.id, name: "metformina", startDate: today })
    const key = said!.healthRows!.find((row) => row.group === "stopped")!.key
    await fx.run((tx) => confirmSaidStopped(tx, ...fx.args, said!.id, key))
    expect((await medicines()).map((row) => row.endDate)).toEqual([null])
    await enable(false)
  })
})

/* Revisión final del 25 nov (voz de desarrollo): la primera consulta de un paciente nuevo. */
describe("la primera consulta de un paciente registrado en el panel", () => {
  it("lo suyo y lo de su familia juntos se revisan con «Lo revisé con…» sin «Otra sesión guardó antecedentes»", async () => {
    await enable(true)
    const { fx, segment, health, confirm, family } = await session()
    // Todo paciente creado en el panel tiene su registro, y nunca se guardó nada de su salud (versión 0).
    await ownerDb.insert(patientRegistration).values({ organizationId: ORG, patientId: fx.patient.id, entryPoint: "platform", respondent: "staff", answers: {} })
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: { declarante: "paciente", conditions: { state: "recorded", items: [{ name: "hipertensión" }] }, family: [{ relation: "madre", name: "preeclampsia" }] },
          sourceText: "tengo hipertensión y mi mamá tuvo preeclampsia",
        },
      ],
      transcript: "Tengo hipertensión y mi mamá tuvo preeclampsia.",
    })
    const [said] = await health()
    const confirmed = await confirm(said!.id)
    expect(confirmed.status).toBe("confirmada")
    expect((await family()).map((row) => `${row.relationship}: ${row.condition}`)).toEqual(["MTH: preeclampsia"])
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.conditions.map((row) => row.name)).toEqual(["hipertensión"])
    await enable(false)
  })
})
