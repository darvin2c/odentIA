import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { encounter, encounterDictationSegment } from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listDictationSaid, settleDictationSegment, startDictationSegment } from "./dictation-said.js"
import {
  DICTATION_REVIEW_CHARS,
  DICTATION_SENTENCE_CHARS,
  dictationSentences,
  type DictationReviewInput,
  releaseDictationReview,
  saveDictationReview,
  setDictationTurnSpeaker,
  startDictationReview,
  turnsFromStarts,
  turnsSayTranscript,
} from "./dictation-review.js"
import { discardDictationSuggestion, type DictationDraft, listDictationSuggestions, saveDictationSegment } from "./encounter-dictation.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El repaso al terminar el dictado (mesa del 20 nov 2026, «Clío en una consulta conversada», P4):
 * una lectura de toda la conversación guardada, con lo que ya quedó de ella. Lo que devuelve el
 * modelo se escribe aquí como lo devolvería Clío; lo que hace la ruta de punta a punta (el modelo
 * llamado una vez, el permiso) lo prueba `apps/api/src/routes/encounter-dictation.test.ts`.
 */
setupTestDb()
const ORG = "org_a"
const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

async function conversation() {
  const fx = await clinicalFixture()
  /** Una pausa ya ordenada, como la deja la ruta: guardada y con lo que propuso. */
  const pause = async (transcript: string, drafts: DictationDraft[] = []) => {
    const segmentId = randomUUID()
    await fx.run(async (tx) => {
      await startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId, transcript })
      await saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts, segmentId, transcript })
      await settleDictationSegment(tx, ORG, fx.encounter.id, segmentId, [])
    })
    return segmentId
  }
  const start = (openForms: string[] = []) => fx.run((tx) => startDictationReview(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { openForms }))
  /** El repaso entero con lo que «devolvió» Clío. */
  const review = async (answer: Partial<Omit<DictationReviewInput, "reviewId" | "segments" | "readIds" | "formQuestions">> = {}, openForms: string[] = []) => {
    const started = await start(openForms)
    if (!started.due) throw new Error("No tocaba el repaso")
    return fx.run((tx) =>
      saveDictationReview(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        reviewId: started.reviewId,
        segments: started.segments,
        readIds: started.readIds,
        formQuestions: started.forms,
        drafts: [],
        turns: [],
        unused: [],
        omitted: 0,
        outOfPlace: [],
        ...answer,
      }),
    )
  }
  const pending = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
  const said = () => fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
  return { fx, pause, start, review, pending, said }
}

describe("cuándo toca el repaso", () => {
  it("solo con tramos que ningún repaso leyó: terminar otra vez sin decir nada no vuelve a llamar al modelo", async () => {
    await enable(true)
    const { fx, pause, start, review } = await conversation()
    expect(await start()).toEqual({ due: false })
    await pause("Buenos días, ¿qué la trae por aquí?")
    await pause("Me duele una muela cuando tomo algo frío.")
    const first = await start()
    expect(first.due).toBe(true)
    if (!first.due) return
    expect(first.segments.map((item) => [item.number, item.transcript, item.needsTurns])).toEqual([
      [1, "Buenos días, ¿qué la trae por aquí?", true],
      [2, "Me duele una muela cuando tomo algo frío.", true],
    ])
    expect(first.earlierLeftOut).toBe(false)
    // Mientras ese repaso lee, otro pedido (otra pestaña) no paga otra llamada (revisión del 21 nov, C1).
    expect(await start()).toEqual({ due: false, inProgress: true })
    // Si el primero falla, lo nuevo deja de estar en curso y se puede pedir ya.
    await fx.run((tx) => releaseDictationReview(tx, ORG, fx.encounter.id, first.readIds))
    await review()
    expect(await start()).toEqual({ due: false })
    await pause("Te veo la próxima semana para la otra resina.")
    expect((await start()).due).toBe(true)
    await enable(false)
  })

  it("con más de lo que lee de una vez, lee los últimos tramos enteros y dice que dejó lo de antes", async () => {
    await enable(true)
    const { fx, pause, start, review } = await conversation()
    const long = `${"Le molesta al masticar del lado izquierdo desde hace semanas. ".repeat(180)}Fin.`
    for (let index = 0; index < 4; index += 1) await pause(`${index}. ${long}`)
    const started = await start()
    if (!started.due) throw new Error("No tocaba el repaso")
    await fx.run((tx) => releaseDictationReview(tx, ORG, fx.encounter.id, started.readIds))
    expect(started.earlierLeftOut).toBe(true)
    expect(started.segments.reduce((sum, item) => sum + item.transcript.length + 1, 0)).toBeLessThanOrEqual(DICTATION_REVIEW_CHARS)
    expect(started.segments.at(-1)?.transcript.startsWith("3.")).toBe(true)
    expect(started.segments[0]?.transcript.startsWith("0.")).toBe(false)
    // Lo que dejó fuera por largo tampoco pide otro repaso.
    await review()
    expect(await start()).toEqual({ due: false })
    await enable(false)
  })

  it("con la atención firmada o de otro profesional, no", async () => {
    await enable(true)
    const { fx, pause, start } = await conversation()
    await pause("Me duele una muela.")
    const other = await clinicalFixture()
    await expect(other.run((tx) => startDictationReview(tx, ORG, other.actor, fx.patient.id, fx.encounter.id))).rejects.toMatchObject({ status: 409 })
    await ownerDb.update(encounter).set({ status: "anulada", voidedAt: new Date(), voidedBy: fx.actor, voidReason: "Prueba" }).where(eq(encounter.id, fx.encounter.id))
    await expect(start()).rejects.toMatchObject({ code: "VOIDED" })
    await enable(false)
  })
})

describe("lo que propone el repaso", () => {
  it("C8: «te veo la próxima semana para la otra resina» queda como control con para qué vuelve", async () => {
    await enable(true)
    const { pause, review, pending } = await conversation()
    await pause("Hoy hicimos la resina de la treinta y seis.")
    await pause("Bueno, te veo la próxima semana para la otra resina.")
    const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const result = await review({
      drafts: [{ kind: "control", payload: { title: "Control: la otra resina", dueAt }, sourceText: "te veo la próxima semana para la otra resina" }],
    })
    expect(result.suggestions.map((item) => [item.kind, item.payload["title"]])).toEqual([["control", "Control: la otra resina"]])
    expect((await pending()).filter((item) => item.kind === "control")).toHaveLength(1)
    await enable(false)
  })

  it("no repite lo pendiente: la consulta se suma, sin otra tarjeta", async () => {
    await enable(true)
    const { pause, review, pending } = await conversation()
    await pause("Me duele una muela de abajo cuando tomo algo frío.", [
      { kind: "nota", payload: { reason: "Dolor de muela al frío", presentIllness: "Le duele una muela de abajo al tomar algo frío." }, sourceText: "Me duele una muela de abajo cuando tomo algo frío" },
    ])
    await pause("Hace como dos semanas, y anoche me dolió solita.")
    const result = await review({
      drafts: [
        { kind: "nota", payload: { illnessDuration: "dos semanas", presentIllness: "Le duele una muela de abajo al tomar algo frío. Anoche le dolió sin causa." }, sourceText: "Hace como dos semanas, y anoche me dolió solita" },
      ],
    })
    expect(result.suggestions).toEqual([])
    const notes = (await pending()).filter((item) => item.kind === "nota")
    expect(notes).toHaveLength(1)
    expect(notes[0]?.payload).toMatchObject({ reason: "Dolor de muela al frío", illnessDuration: "dos semanas" })
    expect(String(notes[0]?.payload["presentIllness"])).toContain("Anoche le dolió sin causa")
    // Lo que ya decía no se repite.
    expect(String(notes[0]?.payload["presentIllness"]).match(/al tomar algo frío/g)).toHaveLength(1)
    await enable(false)
  })

  it("lo pendiente tampoco se propone dos veces: el control dicho en una pausa no sale otra vez en el repaso (CI del 23 nov)", async () => {
    await enable(true)
    const { pause, review, pending } = await conversation()
    const dueAt = new Date(Date.now() + 180 * 86_400_000).toISOString()
    await pause("Control en seis meses.", [{ kind: "control", payload: { title: "Control en 6 meses", dueAt }, sourceText: "Control en seis meses" }])
    const result = await review({ drafts: [{ kind: "control", payload: { title: "Control en 6 meses", dueAt }, sourceText: "Control en seis meses" }] })
    expect(result.suggestions).toEqual([])
    expect((await pending()).filter((item) => item.kind === "control")).toHaveLength(1)
    await enable(false)
  })

  it("la frase ya corregida en su pausa no vuelve con lo de antes: «en la veinticinco…» corregida a la 26 (CI del 23 nov)", async () => {
    await enable(true)
    const { fx, pause, review, pending } = await conversation()
    const dueAt = new Date(Date.now() + 180 * 86_400_000).toISOString()
    await pause("Control en seis meses.", [{ kind: "control", payload: { title: "Control en 6 meses", dueAt }, sourceText: "Control en seis meses" }])
    const [control] = await pending()
    await fx.run((tx) => discardDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, control!.id))
    // Otra fecha y otro título, con la misma frase: no es nuevo.
    const later = new Date(Date.now() + 200 * 86_400_000).toISOString()
    const result = await review({ drafts: [{ kind: "control", payload: { title: "Control semestral", dueAt: later }, sourceText: "control en seis meses" }] })
    expect(result.suggestions).toEqual([])
    await enable(false)
  })

  it("lo descartado no vuelve aunque Clío lo proponga otra vez: lo filtra el servicio, no solo el prompt", async () => {
    await enable(true)
    const { fx, pause, review, pending } = await conversation()
    const dueAt = new Date(Date.now() + 180 * 86_400_000).toISOString()
    await pause("Control en seis meses.", [{ kind: "control", payload: { title: "Control en 6 meses", dueAt }, sourceText: "Control en seis meses" }])
    const [control] = await pending()
    await fx.run((tx) => discardDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, control!.id))
    const result = await review({ drafts: [{ kind: "control", payload: { title: "Control en 6 meses", dueAt }, sourceText: "Control en seis meses" }] })
    expect(result.suggestions).toEqual([])
    expect(await pending()).toEqual([])
    await enable(false)
  })

  it("lo de su salud ya revisado no vuelve; lo nuevo dicho en la conversación, sí", async () => {
    await enable(true)
    const { fx, pause, review, pending } = await conversation()
    await pause("Tomo losartán de cincuenta para la presión.", [
      { kind: "salud", payload: { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán", dose: "50 mg" }] } }, sourceText: "Tomo losartán de cincuenta para la presión" },
    ])
    const [health] = await pending()
    await fx.run((tx) => discardDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, health!.id))
    await pause("Y también la metformina, por el azúcar.")
    const result = await review({
      drafts: [
        {
          kind: "salud",
          payload: { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán", dose: "50 mg" }, { name: "metformina" }] } },
          sourceText: "Y también la metformina, por el azúcar",
        },
      ],
    })
    const proposed = result.suggestions.find((item) => item.kind === "salud")
    expect(proposed?.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "metformina" }] })
    await enable(false)
  })

  it("C9: las respuestas de la ficha abierta que las pausas dejaron se proponen en la ficha", async () => {
    await enable(true)
    const { fx, pause, review } = await conversation()
    const schema = {
      sections: [
        {
          id: "endo",
          title: "Pruebas",
          fields: [
            { id: "percusion", label: "Percusión", type: "opcion_unica", options: ["Positiva", "Negativa"] },
            { id: "frio", label: "Prueba al frío", type: "opcion_unica", options: ["Normal", "Prolongado", "Sin respuesta"] },
          ],
        },
      ],
    }
    const [template] = await ownerDb
      .insert(clinicalFormTemplate)
      .values({ organizationId: ORG, key: `endo-${fx.actor}`, title: "Ficha de endodoncia", status: "publicado", schema })
      .returning()
    const [form] = await ownerDb
      .insert(clinicalFormResponse)
      .values({
        organizationId: ORG,
        templateId: template!.id,
        templateVersion: 1,
        templateTitle: "Ficha de endodoncia",
        templateSnapshot: schema,
        patientId: fx.patient.id,
        encounterId: fx.encounter.id,
        professionalUserId: fx.actor,
        authorUserId: fx.actor,
        status: "borrador",
        source: "staff",
        answers: {},
      })
      .returning()
    await pause("La treinta y seis con percusión positiva y frío prolongado.")
    const started = await fx.run((tx) => startDictationReview(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { openForms: [form!.id] }))
    if (!started.due) throw new Error("No tocaba el repaso")
    const number = (fieldId: string) => started.forms.find((item) => item.fieldId === fieldId)?.number
    // Ese repaso solo sirvió para ver los números de las preguntas: no queda en curso.
    await fx.run((tx) => releaseDictationReview(tx, ORG, fx.encounter.id, started.readIds))
    const result = await review(
      {
        drafts: [
          { kind: "ficha", payload: { question: number("percusion"), answer: "Positiva" }, sourceText: "percusión positiva" },
          { kind: "ficha", payload: { question: number("frio"), answer: "Prolongado" }, sourceText: "frío prolongado" },
        ],
      },
      [form!.id],
    )
    expect(result.suggestions.map((item) => [item.payload["fieldId"], item.payload["value"]])).toEqual([
      ["percusion", "Positiva"],
      ["frio", "Prolongado"],
    ])
    await enable(false)
  })
})

describe("los turnos de lo que se dijo", () => {
  it("son el tramo tal cual: juntos dicen lo que se dijo, sin una palabra cambiada", () => {
    const said = "¿Desde cuándo le duele? Hace dos semanas, doctora."
    expect(turnsSayTranscript([{ texto: "¿Desde cuándo le duele?" }, { texto: "Hace dos semanas, doctora." }], said)).toBe(true)
    // Solo el espacio entre los dos se perdona.
    expect(turnsSayTranscript([{ texto: "¿Desde cuándo le duele?Hace" }, { texto: " dos semanas, doctora." }], said)).toBe(true)
    expect(turnsSayTranscript([{ texto: "¿Desde cuándo le duele?" }, { texto: "Hace 2 semanas, doctora." }], said)).toBe(false)
    expect(turnsSayTranscript([{ texto: "¿Desde cuándo le duele?" }], said)).toBe(false)
    expect(turnsSayTranscript([], said)).toBe(false)
  })

  it("C10: se guardan con quién habló; los que no son el tramo no se guardan; una persona los cambia con un toque y otro repaso no los pisa", async () => {
    await enable(true)
    const { fx, pause, review, said } = await conversation()
    const asked = await pause("¿Tiene alguna enfermedad? Tiene asma, usa salbutamol.")
    const rewritten = await pause("Debe pesar veinticuatro kilos más o menos.")
    const result = await review({
      turns: [
        {
          segmentId: asked,
          turns: [
            { quien: "dra", texto: "¿Tiene alguna enfermedad?" },
            { quien: "no_se_sabe", texto: "Tiene asma, usa salbutamol." },
          ],
        },
        // Clío reescribió el número: no es lo que se dijo.
        { segmentId: rewritten, turns: [{ quien: "acompanante", vinculo: "madre", texto: "Debe pesar 24 kilos más o menos." }] },
      ],
    })
    expect(result.turnsSaved).toEqual([asked])
    expect(result.turnsRejected).toEqual([rewritten])
    // El que no era el tramo queda tal cual se oyó, en un turno de «No se sabe» (QA del 22 nov, UX-1).
    expect(result.turnsUnsplit).toEqual([rewritten])
    const [first, second] = await said()
    expect(first?.turns).toEqual([
      { quien: "dra", texto: "¿Tiene alguna enfermedad?" },
      { quien: "no_se_sabe", texto: "Tiene asma, usa salbutamol." },
    ])
    expect(second?.turns).toEqual([{ quien: "no_se_sabe", texto: "Debe pesar veinticuatro kilos más o menos." }])

    // La mamá de Mateo: un toque.
    const turns = await fx.run((tx) => setDictationTurnSpeaker(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, asked, 1, { quien: "acompanante", vinculo: "madre" }))
    expect(turns[1]).toEqual({ quien: "acompanante", vinculo: "madre", texto: "Tiene asma, usa salbutamol." })
    // El vínculo es de quien acompaña.
    expect((await fx.run((tx) => setDictationTurnSpeaker(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, asked, 0, { quien: "dra", vinculo: "madre" })))[0]).toEqual({ quien: "dra", texto: "¿Tiene alguna enfermedad?" })
    await expect(fx.run((tx) => setDictationTurnSpeaker(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, asked, 5, { quien: "dra" }))).rejects.toMatchObject({ status: 404 })

    // Otro repaso, con algo nuevo dicho: lo que cambió la persona se queda.
    await pause("Listo, nos vemos.")
    await review({ turns: [{ segmentId: asked, turns: [{ quien: "paciente", texto: "¿Tiene alguna enfermedad? Tiene asma, usa salbutamol." }] }] })
    expect((await said())[0]?.turns?.[1]).toEqual({ quien: "acompanante", vinculo: "madre", texto: "Tiene asma, usa salbutamol." })

    // Con la atención anulada, ya no se cambia.
    await ownerDb.update(encounter).set({ status: "anulada", voidedAt: new Date(), voidedBy: fx.actor, voidReason: "Prueba" }).where(eq(encounter.id, fx.encounter.id))
    await expect(fx.run((tx) => setDictationTurnSpeaker(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, asked, 0, { quien: "paciente" }))).rejects.toMatchObject({ code: "VOIDED" })
    await enable(false)
  })

  it("UX-1: si Clío no separó ningún tramo, cada uno queda en un turno de «No se sabe» y el repaso dice cuántos", async () => {
    await enable(true)
    const { pause, review, start, said } = await conversation()
    // Seis pausas escritas sin puntuación, como en la QA: Clío no dijo dónde empezaba ningún turno.
    const pauses = [
      "buenas tardes rosa que la trae por aca",
      "me duele una muela de abajo a la izquierda cuando tomo algo frio",
      "desde cuando le pasa eso",
      "hace como dos semanas y en la noche tambien me late",
      "toma alguna medicina si tomo losartan para la presion",
      "la 36 tiene caries profunda dolor al frio que se queda",
    ]
    // Con lo que dice dónde empieza cada turno, las frases del servidor los arman tal cual: no es que
    // no calcen; lo que pasó es que no llegó ningún comienzo (o ninguno dentro de lo numerado).
    const segments = pauses.map((transcript) => ({ transcript, needsTurns: true }))
    const built = turnsFromStarts(segments, [
      { desde: 1, quien: "dra" },
      { desde: 2, quien: "paciente" },
      { desde: 3, quien: "dra" },
      { desde: 4, quien: "paciente" },
      { desde: 5, quien: "dra" },
      { desde: 5, quien: "paciente", empieza: "si tomo losartan" },
      { desde: 6, quien: "dra" },
    ])
    expect(built.every((turns, index) => turns !== null && turnsSayTranscript(turns, pauses[index]!))).toBe(true)
    expect(turnsFromStarts(segments, [{ desde: 40, quien: "dra" }])).toEqual(pauses.map(() => null))
    const ids: string[] = []
    for (const transcript of pauses) ids.push(await pause(transcript))
    const result = await review({ turns: [] })
    expect(result.turnsSaved).toEqual([])
    expect(result.turnsUnsplit).toEqual(ids)
    expect((await said()).map((item) => item.turns)).toEqual(pauses.map((texto) => [{ quien: "no_se_sabe", texto }]))
    // Otro «Terminar» sin decir nada no vuelve a llamar al modelo: la conversación ya se ve.
    expect(await start()).toEqual({ due: false })
    await enable(false)
  })
})

describe("lo que el repaso no usó", () => {
  it("C4: lo que quien acompaña dice de sí misma y el peso dicho quedan en «No lo usé» del tramo donde se dijeron, con su motivo, sin repetir lo que la pausa ya avisó", async () => {
    await enable(true)
    const { fx, pause, review, said } = await conversation()
    await pause("Yo soy diabética, por si acaso.")
    const weight = randomUUID()
    await fx.run(async (tx) => {
      await startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId: weight, transcript: "Debe pesar veinticuatro, más o menos. Y le gusta el fútbol." })
      await settleDictationSegment(tx, ORG, fx.encounter.id, weight, [{ said: "Debe pesar veinticuatro", why: "sin_lugar" }])
    })
    const result = await review({
      outOfPlace: [
        { said: "Yo soy diabética", why: "familiar" },
        { said: "Debe pesar veinticuatro", why: "peso_dicho" },
      ],
      unused: ["le gusta el fútbol"],
      omitted: 1,
    })
    expect(result.unused.map((item) => item.said)).toEqual(["le gusta el fútbol", "Yo soy diabética"])
    const [family, kid] = await said()
    expect(family?.unused).toEqual([{ said: "Yo soy diabética", why: "sin_lugar", detail: expect.stringContaining("quien lo acompaña") }])
    // La frase que la pausa ya avisó sin motivo queda una vez, con el motivo del repaso (QA del 22 nov, H6).
    expect(kid?.unused).toEqual([
      { said: "Debe pesar veinticuatro", why: "sin_lugar", detail: expect.stringContaining("no medidos") },
      { said: "le gusta el fútbol", why: "sin_lugar" },
    ])
    await enable(false)
  })

  it("lo que se dijo mientras el repaso leía sigue pidiendo otro repaso", async () => {
    await enable(true)
    const { fx, pause, start } = await conversation()
    await pause("Me duele una muela.")
    const started = await start()
    if (!started.due) throw new Error("No tocaba el repaso")
    await pause("Ah, y anoche no me dejó dormir.")
    await fx.run((tx) =>
      saveDictationReview(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        reviewId: started.reviewId,
        segments: started.segments,
        readIds: started.readIds,
        formQuestions: started.forms,
        drafts: [],
        turns: [],
        unused: [],
        omitted: 0,
        outOfPlace: [],
      }),
    )
    const rows = await ownerDb.select().from(encounterDictationSegment).where(eq(encounterDictationSegment.encounterId, fx.encounter.id))
    expect(rows.filter((row) => row.reviewedAt === null).map((row) => row.transcript)).toEqual(["Ah, y anoche no me dejó dormir."])
    expect((await start()).due).toBe(true)
    await enable(false)
  })
})

describe("las frases de un tramo", () => {
  const same = (pieces: string[], said: string) => expect(pieces.join("").replace(/\s+/gu, "")).toBe(said.replace(/\s+/gu, ""))

  it("se parten en el punto, la pregunta y la exclamación, y antes de «¿» o «¡»; un decimal no se parte", () => {
    const said = "Buenos días. ¿Qué la trae por aquí? ¡Me duele mucho! Bien ¿y desde cuándo?… Hace dos semanas, tomé 6.5 mg."
    expect(dictationSentences(said)).toEqual([
      "Buenos días.",
      "¿Qué la trae por aquí?",
      "¡Me duele mucho!",
      "Bien",
      "¿y desde cuándo?…",
      "Hace dos semanas, tomé 6.5 mg.",
    ])
    same(dictationSentences(said), said)
    // Las comillas que cierran van con su frase.
    expect(dictationSentences("Dijo «me duele». Y se fue.")).toEqual(["Dijo «me duele».", "Y se fue."])
  })

  it("lo que llega sin puntuación (la voz de Chrome) se parte por largo, antes de un conector", () => {
    const said =
      "me duele una muela de abajo del lado izquierdo cuando tomo algo frío desde hace como dos semanas y anoche me dolió solita no me dejó dormir pero hoy amaneció mejor entonces vine para que me la vean doctora"
    const pieces = dictationSentences(said)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((piece) => piece.length <= DICTATION_SENTENCE_CHARS)).toBe(true)
    expect(pieces.slice(1).every((piece) => /^(y|pero|porque|entonces|bueno|o sea|ya|después|además|también|ahora|mira|oiga|doctora?|sí|no)\s/u.test(piece))).toBe(true)
    same(pieces, said)
    // Sin conectores, en el último espacio que cabe.
    const flat = "palabra ".repeat(60).trim()
    const cut = dictationSentences(flat)
    expect(cut.every((piece) => piece.length <= DICTATION_SENTENCE_CHARS)).toBe(true)
    same(cut, flat)
  })

  it("es estable: el mismo tramo da siempre las mismas frases, y una corta o vacía no cambia", () => {
    const said = "¿Alérgica a algo? Que yo sepa no. Bueno."
    expect(dictationSentences(said)).toEqual(dictationSentences(said))
    expect(dictationSentences("hola")).toEqual(["hola"])
    expect(dictationSentences("   ")).toEqual([])
  })
})

describe("un turno que empieza a media frase (QA del 21 nov, C10)", () => {
  it("la pregunta y su respuesta sin puntuación quedan en dos turnos, con el texto exacto; sin sus palabras, empieza en la frase", () => {
    const segments = [{ transcript: "toma alguna medicina si tomo warfarina no perdon ahora apixaban", needsTurns: true }]
    const [turns] = turnsFromStarts(segments, [
      { desde: 1, quien: "dra" },
      { desde: 1, quien: "paciente", empieza: "Si tomo warfarina" },
    ])
    expect(turns).toEqual([
      { quien: "dra", texto: "toma alguna medicina" },
      { quien: "paciente", texto: "si tomo warfarina no perdon ahora apixaban" },
    ])
    expect(turnsSayTranscript(turns ?? [], segments[0]!.transcript)).toBe(true)
    expect(turnsFromStarts(segments, [{ desde: 1, quien: "paciente", empieza: "no dijo esto" }])[0]).toEqual([{ quien: "paciente", texto: segments[0]!.transcript }])
  })
})

describe("los turnos armados desde dónde empieza cada uno", () => {
  const segments = [
    { transcript: "¿Tiene alguna enfermedad? Tiene asma, usa salbutamol.", needsTurns: true },
    { transcript: "Ya tiene turnos.", needsTurns: false },
    { transcript: "Y el inhalador lo usa de noche. ¿Algo más?", needsTurns: true },
  ]
  it("cada turno sigue hasta el siguiente, también en el tramo que viene; son el tramo tal cual por construcción", () => {
    const turns = turnsFromStarts(segments, [
      { desde: 1, quien: "dra" },
      { desde: 2, quien: "acompanante", vinculo: "madre" },
      { desde: 5, quien: "dra" },
    ])
    expect(turns).toEqual([
      [
        { quien: "dra", texto: "¿Tiene alguna enfermedad?" },
        { quien: "acompanante", vinculo: "madre", texto: "Tiene asma, usa salbutamol." },
      ],
      null,
      [
        { quien: "acompanante", vinculo: "madre", texto: "Y el inhalador lo usa de noche." },
        { quien: "dra", texto: "¿Algo más?" },
      ],
    ])
    segments.forEach((segment, index) => {
      const built = turns[index]
      if (built) expect(turnsSayTranscript(built, segment.transcript)).toBe(true)
    })
  })
  it("sin ningún turno empezado no hay turnos; lo de antes del primero no se sabe de quién es", () => {
    expect(turnsFromStarts(segments, [])).toEqual([null, null, null])
    expect(turnsFromStarts(segments, [{ desde: 2, quien: "paciente", vinculo: "madre" }])[0]).toEqual([
      { quien: "no_se_sabe", texto: "¿Tiene alguna enfermedad?" },
      { quien: "paciente", texto: "Tiene asma, usa salbutamol." },
    ])
  })
})
