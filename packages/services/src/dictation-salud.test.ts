import { prescribingAlerts } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { patientAllergy, patientCondition, patientHealthDeclaration, patientMedication } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { addDeclaredAllergies, anesthesiaRisksOf, extractionRisksOf, getPatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  confirmDictationHealth,
  confirmDictationSuggestion,
  dictationModelLabel,
  listDictationSuggestions,
  listSaidHealth,
  saveDictationSegment,
  undoDictationVoiceCorrection,
} from "./encounter-dictation.js"
import { prescribingSituationOf } from "./prescriptions.js"
import { productHooksFor } from "./products.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Lo de salud dicho en la conversación (mesa del 20 nov 2026, «Clío en una consulta conversada»,
 * P3). Antes, Clío no tenía dónde ponerlo: la warfarina y la metformina caían en el relato y la
 * franja seguía diciendo «Anticoagulante: no se le preguntó»; el asma de un niño se perdía; y «no
 * que yo sepa» se volvía «No tiene alergias», que «Confirmar las N» confirmaba de un toque. Las
 * pausas se escriben como las ordenaría Clío en los casos de la voz clínica (C1–C4).
 */
setupTestDb()
const ORG = "org_a"
const DENTAL = productHooksFor("dental").dictation!
/** El catálogo con el que receta odentIA. */
const DENTAL_PRESCRIBING = productHooksFor("dental").prescribing.catalog

const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))
const setProduct = (product: "dental" | "medical") => ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, ORG))

async function session() {
  const fx = await clinicalFixture()
  const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
  const pending = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
  const health = async () => (await pending()).filter((item) => item.kind === "salud")
  const confirm = (id: string, input?: Parameters<typeof confirmDictationHealth>[6]) =>
    fx.run((tx) => confirmDictationHealth(tx, ...fx.args, fx.encounter.id, id, input))
  const declarations = () => ownerDb.select().from(patientHealthDeclaration).where(eq(patientHealthDeclaration.patientId, fx.patient.id))
  return { fx, segment, pending, health, confirm, declarations }
}

describe("C1 y C2 · la medicación dicha en la conversación", () => {
  it("una sola salud pendiente: la warfarina corregida a apixabán queda con «antes dijo», y lo demás no se pierde", async () => {
    await enable(true)
    const { segment, health } = await session()
    // Pausa 2: «Tomo warfarina por la arritmia, y metformina.»
    const [first] = (
      await segment({
        drafts: [
          {
            kind: "salud",
            payload: {
              declarante: "paciente",
              anticoagulants: { state: "recorded", detail: "warfarina" },
              medications: { state: "recorded", items: [{ name: "metformina" }] },
              conditions: { state: "recorded", items: [{ name: "arritmia" }] },
            },
            sourceText: "Tomo warfarina por la arritmia, y metformina",
          },
        ],
        transcript: "Tomo warfarina por la arritmia, y metformina.",
      })
    ).suggestions
    expect(first?.kind).toBe("salud")
    // Pausa 4: «No es warfarina, es apixabán, el Eliquis.» Lo nuevo se suma a la misma: no es otra tarjeta.
    const second = await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } }, sourceText: "es apixabán, el Eliquis" }],
      transcript: "No es warfarina, es apixabán, el Eliquis.",
    })
    expect(second.suggestions).toEqual([])
    expect(second.added).toEqual([first!.id])

    const [one, ...others] = await health()
    expect(others).toEqual([])
    expect(one?.payload["anticoagulants"]).toEqual({ state: "recorded", detail: "apixabán" })
    expect(one?.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "metformina" }] })
    expect(one?.payload["conditions"]).toEqual({ state: "recorded", items: [{ name: "arritmia" }] })
    expect(one?.summary).toContain("Anticoagulante: apixabán (antes dijo «warfarina»)")
    expect(one?.summary).toContain("Medicación: metformina")
    // A Clío le llega lo que ya dice, para sumar sin repetir.
    expect(dictationModelLabel(one!, DENTAL)).toContain("anticoagulante: «apixabán»")
    await enable(false)
  })

  it("confirmada, queda en Antecedentes, declarada en la consulta por la paciente y revisada por quien confirma; la exodoncia y la receta la ven", async () => {
    await enable(true)
    const { fx, segment, confirm, declarations } = await session()
    const [said] = (
      await segment({
        drafts: [
          {
            kind: "salud",
            payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, medications: { state: "recorded", items: [{ name: "metformina" }] } },
            sourceText: "tomo apixabán y metformina",
          },
        ],
        transcript: "Tomo apixabán y metformina.",
      })
    ).suggestions
    // «Confirmar las N» no la lleva: la operación de siempre la rechaza.
    await expect(fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, said!.id))).rejects.toMatchObject({ code: "HEALTH_NEEDS_REVIEW" })

    const confirmed = await confirm(said!.id)
    expect(confirmed.status).toBe("confirmada")
    const [declaration, ...more] = await declarations()
    expect(more).toEqual([])
    expect(declaration?.via).toBe("consulta")
    expect(declaration?.respondent).toBe("patient")
    expect(declaration?.health).toMatchObject({ anticoagulants: { state: "recorded", detail: "apixabán" } })
    const medicines = await ownerDb.select().from(patientMedication).where(eq(patientMedication.patientId, fx.patient.id))
    expect(medicines.map((row) => row.name).sort()).toEqual(["apixabán", "metformina"])
    const health = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(health.reviewPending).toBe(false)
    expect(health.reviewedBy).toBe(fx.actor)
    expect(health.declared).toEqual([])
    // La línea de riesgo de la exodoncia y la receta leen lo confirmado.
    expect(await fx.run((tx) => extractionRisksOf(tx, ORG, fx.patient.id))).toEqual(["Toma apixabán: riesgo de sangrado."])
    const catalog = DENTAL_PRESCRIBING
    const situation = await fx.run((tx) => prescribingSituationOf(tx, ORG, fx.patient.id, catalog))
    expect(prescribingAlerts(situation, [{ genericName: "naproxeno" }], catalog.medications).warnings.join(" ")).toContain("toma apixabán")
    await enable(false)
  })

  it("lo dicho sin confirmar se puede leer para la franja, con quién lo dijo", async () => {
    await enable(true)
    const { fx, segment } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } }, sourceText: "tomo apixabán" }],
      transcript: "Tomo apixabán.",
    })
    const said = await fx.run((tx) => listSaidHealth(tx, ORG, fx.patient.id))
    expect(said).toHaveLength(1)
    expect(said[0]?.encounterId).toBe(fx.encounter.id)
    expect(said[0]?.by).toEqual({ kind: "patient", name: null, relation: null })
    expect(said[0]?.rows).toContainEqual({ key: "anticoagulants", label: "Anticoagulante", value: "apixabán" })
    await enable(false)
  })
})

describe("la anestesia dicha en la conversación", () => {
  it("confirmada, el aviso de la anestesia la dice", async () => {
    await enable(true)
    const { fx, segment, health, confirm } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", dental: { problemaAnestesia: { anestesia: "si", quePaso: "desmayo" } } }, sourceText: "la última vez me desmayé con la anestesia" }],
      transcript: "La última vez me desmayé con la anestesia.",
    })
    const [said] = await health()
    expect(said?.summary).toContain("Anestesia del dentista: problemas: sí (se desmayó o le bajó la presión)")
    await confirm(said!.id)
    expect(await fx.run((tx) => anesthesiaRisksOf(tx, ORG, fx.patient.id))).toContain("tuvo problemas con la anestesia: se desmayó o le bajó la presión")
    await enable(false)
  })
})

describe("C3 · «no que yo sepa» no es «No tiene alergias»", () => {
  it("la alergia dictada con duda no sale `none`: queda como que no sabe, en la salud", async () => {
    await enable(true)
    const { segment, pending, health } = await session()
    await segment({ drafts: [{ kind: "alergia", payload: { none: true }, sourceText: "No que yo sepa" }], transcript: "¿Alérgica a algo? No que yo sepa." })
    const all = await pending()
    expect(all.filter((item) => item.kind === "alergia")).toEqual([])
    const [said] = await health()
    expect(said?.payload["allergies"]).toEqual({ state: "unknown", items: [] })
    expect(said?.summary).toContain("Alergias: no sabe")
    await enable(false)
  })

  it("en la salud, un «no» con duda («creo que no») queda como que no sabe; el silencio no es «no»", async () => {
    await enable(true)
    const { segment, health } = await session()
    await segment({
      drafts: [{ kind: "salud", payload: { declarante: "paciente", conditions: { state: "none", items: [] } }, sourceText: "creo que no tengo ninguna enfermedad" }],
      transcript: "Creo que no tengo ninguna enfermedad.",
    })
    const [said] = await health()
    expect(said?.payload["conditions"]).toEqual({ state: "unknown", items: [] })
    // Lo que no se dijo no aparece: ni medicación ni alergias.
    expect(said?.payload["medications"]).toBeUndefined()
    expect(said?.payload["allergies"]).toBeUndefined()
    await enable(false)
  })

  it("confirmada, la declaración dice que no sabe de sus alergias y no marca «No tiene alergias»", async () => {
    await enable(true)
    const { fx, segment, health, confirm, declarations } = await session()
    await segment({ drafts: [{ kind: "alergia", payload: { none: true }, sourceText: "que yo sepa no" }], transcript: "Que yo sepa no." })
    const [said] = await health()
    await confirm(said!.id)
    const [declaration] = await declarations()
    expect(declaration?.health).toMatchObject({ allergies: { state: "unknown", items: [] } })
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.reviewStatus.allergies).not.toBe("none")
    expect(after.allergiesReviewedAt).toBeNull()
    await enable(false)
  })
})

describe("C4 · la mamá de Mateo", () => {
  it("el asma y el salbutamol son de Mateo, dichos por su madre; lo que no es de su salud no se propone", async () => {
    await enable(true)
    const { fx, segment, health, confirm, declarations } = await session()
    // «Tiene asma, usa salbutamol. Yo soy diabética. Debe pesar 24.» Lo de la madre y el peso no van:
    // si Clío los pusiera, no hay dónde, y no se guardan.
    await segment({
      drafts: [
        {
          kind: "salud",
          payload: {
            declarante: "acompanante",
            vinculo: "madre",
            conditions: { state: "recorded", items: [{ name: "asma" }] },
            medications: { state: "recorded", items: [{ name: "salbutamol" }] },
            peso: 24,
            familiares: [{ parentesco: "padre", enfermedad: "diabetes" }],
          },
          sourceText: "tiene asma, usa salbutamol",
        },
      ],
      transcript: "Tiene asma, usa salbutamol. Yo soy diabética. Debe pesar 24.",
    })
    const [said] = await health()
    expect(Object.keys(said!.payload).sort()).toEqual(["conditions", "declarante", "medications", "vinculo"])
    expect(said?.summary).toContain("Lo dijo: su madre")
    await confirm(said!.id)
    const [declaration] = await declarations()
    expect(declaration?.via).toBe("consulta")
    expect(declaration?.respondent).toBe("representative")
    expect(declaration?.declarantRelation).toBe("madre")
    const conditions = await ownerDb.select().from(patientCondition).where(eq(patientCondition.patientId, fx.patient.id))
    expect(conditions.map((row) => row.name)).toEqual(["asma"])
    await enable(false)
  })

  it("solo lo que no es de su salud no deja ninguna sugerencia", async () => {
    await enable(true)
    const { segment, health } = await session()
    await segment({ drafts: [{ kind: "salud", payload: { declarante: "acompanante", vinculo: "madre", peso: 24 }, sourceText: "debe pesar 24" }], transcript: "Debe pesar 24." })
    expect(await health()).toEqual([])
    await enable(false)
  })
})

describe("«No tiene alergias» de Clío no confirma de paso lo declarado", () => {
  it("una alergia que dijo por su enlace, sin revisar, sigue sin confirmar", async () => {
    await enable(true)
    const { fx, segment, pending } = await session()
    await fx.run((tx) => addDeclaredAllergies(tx, ORG, null, fx.patient.id, [{ substance: "Látex", reaction: null }], { entity: "prueba", entityId: fx.encounter.id }))
    await segment({ drafts: [{ kind: "alergia", payload: { none: true }, sourceText: "no, ninguna alergia" }], transcript: "¿Alergias? No, ninguna alergia." })
    const [none] = (await pending()).filter((item) => item.kind === "alergia")
    expect(none?.payload["none"]).toBe(true)
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, none!.id))
    const [latex] = await ownerDb
      .select()
      .from(patientAllergy)
      .where(and(eq(patientAllergy.patientId, fx.patient.id), eq(patientAllergy.substance, "Látex")))
    expect(latex?.verification).toBe("no_confirmada")
    const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
    expect(after.allergiesReviewedAt).toBeNull()
    await enable(false)
  })
})

describe("latidIA · lo de salud dicho en la consulta", () => {
  it("el embarazo, la lactancia y el alcohol dichos entran a su entrevista al confirmar", async () => {
    await setProduct("medical")
    await enable(true)
    try {
      const { fx, segment, health, confirm } = await session()
      await segment({
        drafts: [
          {
            kind: "salud",
            payload: { declarante: "paciente", personal: { embarazo: true, semanasEmbarazo: 24 }, medical: { lactancia: false, alcohol: "ocasional" } },
            sourceText: "estoy embarazada de 24 semanas",
          },
        ],
        transcript: "Estoy embarazada de 24 semanas, no doy de lactar y tomo alcohol de vez en cuando.",
      })
      const [said] = await health()
      expect(said?.summary).toContain("Embarazo: sí, 24 semanas")
      await confirm(said!.id)
      const after = await fx.run((tx) => getPatientHealth(tx, ORG, fx.patient.id))
      expect(after.pregnancy).not.toBeNull()
      expect(after.latestAnamnesis?.answers).toMatchObject({ habitos: { alcohol: "ocasional" } })
    } finally {
      await enable(false)
      await setProduct("dental")
    }
  })
})

describe("una corrección por voz de la salud", () => {
  it("exige su frase, cambia solo lo que trae y se deshace de a un paso", async () => {
    await enable(true)
    const { fx, segment, health } = await session()
    const [said] = (
      await segment({
        drafts: [{ kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "warfarina" }, medications: { state: "recorded", items: [{ name: "losartán" }] } }, sourceText: "tomo warfarina y losartán" }],
        transcript: "Tomo warfarina y losartán.",
      })
    ).suggestions
    // Sin la frase dicha no se corrige.
    expect((await segment({ drafts: [], corrections: [{ suggestionId: said!.id, changes: { anticoagulants: { state: "recorded", detail: "apixabán" } } }], transcript: "Abra grande." })).corrected).toEqual([])
    const phrase = "perdón, no es warfarina, es apixabán"
    const fixed = await segment({ drafts: [], corrections: [{ suggestionId: said!.id, changes: { anticoagulants: { state: "recorded", detail: "apixabán" } }, said: phrase }], transcript: `${phrase}.` })
    expect(fixed.corrected).toEqual([said!.id])
    const [after] = await health()
    expect(after?.payload["anticoagulants"]).toEqual({ state: "recorded", detail: "apixabán" })
    expect(after?.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán" }] })
    expect(after?.voice).not.toBeNull()
    expect(after?.summary).toContain("(antes dijo «warfarina»)")
    // «Deshacer» vuelve a lo dicho antes de la corrección, con lo demás igual.
    const back = await fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, said!.id))
    expect(back.payload["anticoagulants"]).toEqual({ state: "recorded", detail: "warfarina" })
    expect(back.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán" }] })
    expect(back.voice).toBeNull()
    await enable(false)
  })
})
