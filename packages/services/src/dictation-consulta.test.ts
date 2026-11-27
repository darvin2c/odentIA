import { withOrgContext } from "@odentia/db"
import { encounter, encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  confirmDictationSuggestion,
  dictationModelLabel,
  listDictationSuggestions,
  saveDictationSegment,
  undoDictationVoiceCorrection,
} from "./encounter-dictation.js"
import { productHooksFor } from "./products.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Una sola consulta que se actualiza (mesa del 20 nov 2026, «Clío en una consulta conversada»).
 * Antes, a Clío la consulta pendiente le llegaba sin su texto, cada pausa la «corregía» a ciegas y
 * reemplazaba el relato, salían dos tiempos distintos que al confirmar se unían con «;» y «Deshacer»
 * volvía al principio. Las pausas se escriben como las ordenó Clío en los casos de la mesa.
 */
setupTestDb()
const ORG = "org_a"
const DENTAL = productHooksFor("dental").dictation!

const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

async function session() {
  const fx = await clinicalFixture()
  const segment = (input: Parameters<typeof saveDictationSegment>[5]) => fx.run((tx) => saveDictationSegment(tx, ...fx.args, fx.encounter.id, input))
  const pending = () => fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
  const notes = async () => (await pending()).filter((item) => item.kind === "nota")
  return { fx, segment, pending, notes }
}

describe("la consulta pendiente le llega a Clío con su texto", () => {
  it("cada campo con lo que dice, no solo su nombre", () => {
    const label = dictationModelLabel(
      { kind: "nota", payload: { reason: "Dolor de muela al tomar algo frío", illnessDuration: "dos semanas", presentIllness: "Le duele cuando toma algo frío." } },
      DENTAL,
    )
    expect(label).toBe("Consulta · motivo: «Dolor de muela al tomar algo frío» · tiempo: «dos semanas» · relato: «Le duele cuando toma algo frío.»")
  })

  it("un texto largo llega recortado, con su comienzo y su final", () => {
    const long = `Empezó con un dolor leve. ${"Le molesta al masticar. ".repeat(40)}Anoche no la dejó dormir.`
    const label = dictationModelLabel({ kind: "nota", payload: { presentIllness: long } }, DENTAL)
    expect(label.length).toBeLessThan(500)
    expect(label).toContain("relato: «Empezó con un dolor leve.")
    expect(label).toContain("…")
    expect(label).toContain("Anoche no la dejó dormir.»")
  })
})

describe("lo nuevo de la consulta se suma a la misma sugerencia", () => {
  it("C1: el relato no se pisa, el tiempo queda con lo último y lo anterior a la vista, y hay una sola consulta", async () => {
    await enable(true)
    const { fx, segment, notes } = await session()
    // Pausa 2: «Me duele una muela de abajo, del lado izquierdo, cuando tomo algo frío.»
    const [first] = (
      await segment({
        drafts: [{ kind: "nota", payload: { reason: "Dolor de muela al tomar algo frío", presentIllness: "Le duele una muela de abajo cuando toma algo frío." }, sourceText: "Me duele una muela de abajo" }],
        transcript: "Me duele una muela de abajo, del lado izquierdo, cuando tomo algo frío.",
      })
    ).suggestions
    // Pausa 4: «Hace como dos meses, y anoche me dolió solita.»
    const added = await segment({
      drafts: [{ kind: "nota", payload: { illnessDuration: "como dos meses", presentIllness: "Anoche le dolió sola." }, sourceText: "anoche me dolió solita" }],
      transcript: "Hace como dos meses, y anoche me dolió solita.",
    })
    // No es otra tarjeta: se suma a la que había, y no es una corrección.
    expect(added.suggestions).toEqual([])
    expect(added.corrected).toEqual([])
    expect(added.added).toEqual([first!.id])
    // Pausa 5: «No, fue para fin de agosto, serán como tres meses.» Se corrige: el tiempo cambia (QA del 22 nov, H2).
    await segment({ drafts: [{ kind: "nota", payload: { illnessDuration: "como tres meses" }, sourceText: "serán como tres meses" }], transcript: "No, fue para fin de agosto, serán como tres meses." })

    const [note, ...others] = await notes()
    expect(others).toEqual([])
    expect(note?.id).toBe(first!.id)
    expect(note?.payload).toEqual({
      reason: "Dolor de muela al tomar algo frío",
      presentIllness: "Le duele una muela de abajo cuando toma algo frío. Anoche le dolió sola.",
      illnessDuration: "como tres meses",
    })
    // Lo sumado no se muestra como «corregido por voz»; el tiempo dicho antes se ve en la tarjeta.
    expect(note?.voice).toBeNull()
    expect(note?.summary).toContain("Tiempo de enfermedad: como tres meses (antes dijo «como dos meses»)")
    expect(note?.summary).not.toContain(";")
    // A Clío le llega lo que ya dice.
    expect(dictationModelLabel(note!, DENTAL)).toContain("tiempo: «como tres meses»")

    // Lo que repite lo que ya dice no se suma otra vez.
    await segment({ drafts: [{ kind: "nota", payload: { presentIllness: "Anoche le dolió sola." } }] })
    expect((await notes())[0]?.payload["presentIllness"]).toBe("Le duele una muela de abajo cuando toma algo frío. Anoche le dolió sola.")

    // Al confirmar entra un solo tiempo, sin «;».
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, first!.id))
    const [saved] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(saved?.illnessDuration).toBe("como tres meses")
    expect(saved?.presentIllness).toBe("Le duele una muela de abajo cuando toma algo frío. Anoche le dolió sola.")
    await enable(false)
  })

  it("el mismo tramo enviado dos veces no se suma dos veces", async () => {
    await enable(true)
    const { segment, notes } = await session()
    await segment({ drafts: [{ kind: "nota", payload: { reason: "Dolor al frío" } }], segmentId: "t1" })
    const again = { drafts: [{ kind: "nota" as const, payload: { presentIllness: "Le duele de noche." } }], segmentId: "t2" }
    await segment(again)
    expect((await segment(again)).repeated).toBe(true)
    expect((await notes()).map((item) => item.payload)).toEqual([{ reason: "Dolor al frío", presentIllness: "Le duele de noche." }])
    await enable(false)
  })
})

describe("la evolución no termina en «;» (QA del 22 nov, H12)", () => {
  it("lo que Clío dejó con «;» al final se propone y se confirma sin él", async () => {
    await enable(true)
    const { fx, segment, notes } = await session()
    const [note] = (await segment({ drafts: [{ kind: "nota", payload: { evolution: "Pieza 36 con caries profunda oclusal que llega a pulpa;" } }], transcript: "la 36 tiene caries profunda oclusal que llega a pulpa" })).suggestions
    await segment({ drafts: [{ kind: "nota", payload: { evolution: "Dolor al frío que se queda ; " } }], transcript: "dolor al frio que se queda" })
    expect((await notes())[0]?.payload["evolution"]).toBe("Pieza 36 con caries profunda oclusal que llega a pulpa. Dolor al frío que se queda")
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, note!.id))
    const [saved] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(saved?.evolution).toBe("Pieza 36 con caries profunda oclusal que llega a pulpa. Dolor al frío que se queda")
    await enable(false)
  })
})

describe("una pausa sin nada del relato no lo pisa", () => {
  it("una «corrección» sin frase dicha, o con una pregunta, no cambia la consulta; una de verdad cambia solo lo que dijo", async () => {
    await enable(true)
    const { segment, notes } = await session()
    const [note] = (
      await segment({ drafts: [{ kind: "nota", payload: { reason: "Dolor de muela", presentIllness: "Le duele al tomar algo frío." } }], transcript: "Me duele la muela cuando tomo algo frío." })
    ).suggestions
    const relato = "Le duele al tomar algo frío."
    // «Tomo losartán para la presión»: Clío lo «corrigió» sin citar nada (auditor, C1 paso 4).
    expect((await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { presentIllness: "Tomo losartán para la presión." } }], transcript: "Tomo losartán para la presión." })).corrected).toEqual([])
    // «¿Y desde cuándo le pasa eso?», sola (desarrollo, C1 paso 3): una pregunta no corrige.
    const question = "¿Y desde cuándo le pasa eso?"
    expect((await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { presentIllness: "Pregunta desde cuándo." }, said: question }], transcript: question })).corrected).toEqual([])
    // Una frase que no está en lo dictado de la pausa tampoco.
    expect(
      (await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { reason: "Dolor de muela izquierda" }, said: "no, es la izquierda" }], transcript: "Abra grande, por favor." })).corrected,
    ).toEqual([])
    // Una pausa que solo trae el tiempo lo suma sin tocar el relato.
    await segment({ drafts: [{ kind: "nota", payload: { illnessDuration: "tres días" } }], transcript: "Desde hace tres días." })
    expect((await notes())[0]?.payload).toEqual({ reason: "Dolor de muela", presentIllness: relato, illnessDuration: "tres días" })

    // La corrección dicha cambia solo el campo que trae y sí queda «corregida por voz».
    const said = "no, perdón, es la del lado izquierdo"
    const fixed = await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { reason: "Dolor de muela del lado izquierdo" }, said }], transcript: `${said}.` })
    expect(fixed.corrected).toEqual([note!.id])
    const [after] = await notes()
    expect(after?.payload).toEqual({ reason: "Dolor de muela del lado izquierdo", presentIllness: relato, illnessDuration: "tres días" })
    expect(after?.voice).not.toBeNull()
    await enable(false)
  })
})

describe("«Deshacer» vuelve un paso", () => {
  it("dos correcciones seguidas se deshacen de a una, y lo sumado en medio no se pierde", async () => {
    await enable(true)
    const { fx, segment, notes } = await session()
    const [note] = (await segment({ drafts: [{ kind: "nota", payload: { reason: "Dolor de muela", illnessDuration: "tres días" } }] })).suggestions
    const correct = (changes: Record<string, unknown>, said: string) => segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes, said }], transcript: said })
    await correct({ illnessDuration: "una semana" }, "no, en realidad hace una semana")
    // Entre las dos correcciones, una pausa suma al relato.
    await segment({ drafts: [{ kind: "nota", payload: { presentIllness: "Le duele de noche." } }] })
    await correct({ illnessDuration: "dos semanas" }, "perdón, son dos semanas")
    expect((await notes())[0]?.payload["illnessDuration"]).toBe("dos semanas")

    const undo = () => fx.run((tx) => undoDictationVoiceCorrection(tx, ...fx.args, fx.encounter.id, note!.id))
    // Un paso: vuelve a la primera corrección, que sigue deshaciéndose.
    const back = await undo()
    expect(back.payload).toEqual({ reason: "Dolor de muela", illnessDuration: "una semana", presentIllness: "Le duele de noche." })
    expect(back.voice).not.toBeNull()
    // Otro paso: lo dicho primero, con lo sumado en medio.
    const first = await undo()
    expect(first.payload).toEqual({ reason: "Dolor de muela", illnessDuration: "tres días", presentIllness: "Le duele de noche." })
    expect(first.voice).toBeNull()
    await expect(undo()).rejects.toMatchObject({ code: "NO_VOICE_CORRECTION" })
    await enable(false)
  })
})

// QA del 26 nov (clínica, hallazgo 8): «Me corrijo: el dolor de la 36 dura varios minutos…» reemplazó la
// evolución entera (con «hoy le hice una profilaxis») y el repaso al firmar volvía a proponer, marcado,
// el «dolor con el frío que se pasa rápido» que se había corregido.
describe("una corrección cambia solo lo que corrige y el repaso no lo vuelve a proponer", () => {
  it("la evolución conserva lo demás, y lo corregido no vuelve en el repaso", async () => {
    await enable(true)
    const { fx, segment, notes } = await session()
    const [note] = (
      await segment({ drafts: [{ kind: "nota", payload: { evolution: "Hoy le hice una profilaxis. Refiere dolor con el frío en la 36 que se pasa rápido." } }] })
    ).suggestions
    const said = "Me corrijo: el dolor de la 36 dura varios minutos y le despierta de noche"
    await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { evolution: "El dolor de la 36 dura varios minutos y le despierta de noche." }, said }], transcript: said })
    expect((await notes())[0]?.payload["evolution"]).toBe("Hoy le hice una profilaxis. El dolor de la 36 dura varios minutos y le despierta de noche.")
    // Ya confirmada, el repaso relee toda la conversación y Clío vuelve a contar lo que se corrigió.
    await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, note!.id))
    const review = await segment({
      review: true,
      drafts: [{ kind: "nota", payload: { evolution: "Refiere dolor con el frío en la 36 que se pasa rápido." } }],
      transcript: "Refiere dolor con el frío en la 36 que se pasa rápido. Me corrijo: el dolor de la 36 dura varios minutos y le despierta de noche.",
    })
    expect(review.suggestions.filter((item) => item.kind === "nota").map((item) => item.payload)).toEqual([])
    expect((await notes()).map((item) => item.payload)).toEqual([])
    await enable(false)
  })
})

describe("varias consultas pendientes de antes de este cambio", () => {
  it("al confirmarlas, el tiempo no se junta con «;»: queda el último con lo de antes", async () => {
    await enable(true)
    const { fx } = await session()
    // Dos tarjetas de consulta como las dejaba el dictado antes (auditor, C2): se guardan tal cual.
    const rows = await ownerDb
      .insert(encounterDictationSuggestion)
      .values(
        [{ illnessDuration: "dos meses", presentIllness: "Le sangra la encía de abajo cuando come." }, { illnessDuration: "como tres meses" }].map((payload) => ({
          organizationId: ORG,
          patientId: fx.patient.id,
          encounterId: fx.encounter.id,
          professionalUserId: fx.actor,
          kind: "nota" as const,
          payload,
          sourceText: "",
          status: "lista",
        })),
      )
      .returning()
    for (const row of rows) await fx.run((tx) => confirmDictationSuggestion(tx, ...fx.args, fx.encounter.id, row.id))
    const [saved] = await ownerDb.select().from(encounter).where(eq(encounter.id, fx.encounter.id))
    expect(saved?.illnessDuration).toBe("como tres meses (antes: dos meses)")
    await enable(false)
  })
})

describe("una respuesta no es una corrección (QA del 21 nov, H7 y hallazgo 6 de desarrollo)", () => {
  it("«hace como dos semanas» tras «¿desde cuándo?» se suma: sin «corregido por voz» ni un «antes» que no existía", async () => {
    await enable(true)
    const { segment, notes } = await session()
    const [note] = (await segment({ drafts: [{ kind: "nota", payload: { reason: "Dolor de muela", presentIllness: "Le duele con el frío." } }], transcript: "me duele una muela con el frio" })).suggestions
    // Clío lo manda como corrección de la consulta, con la frase de la respuesta.
    const said = "hace como dos semanas y anoche no me dejo dormir"
    const reply = await segment({
      drafts: [],
      corrections: [{ suggestionId: note!.id, changes: { illnessDuration: "como dos semanas", presentIllness: "Le duele con el frío. Anoche no la dejó dormir." }, said }],
      transcript: said,
    })
    expect(reply.corrected).toEqual([])
    expect(reply.added).toEqual([note!.id])
    const [after] = await notes()
    expect(after?.voice).toBeNull()
    expect(after?.payload).toEqual({ reason: "Dolor de muela", illnessDuration: "como dos semanas", presentIllness: "Le duele con el frío. Anoche no la dejó dormir." })
    await enable(false)
  })

  it("H2: lo que dice quien examina no pisa el motivo del paciente ni deja un «antes dijo» falso (QA del 22 nov)", async () => {
    await enable(true)
    const { segment, notes } = await session()
    await segment({
      drafts: [{ kind: "nota", payload: { reason: "dolor de una muela de abajo a la izquierda", illnessDuration: "dos semanas" }, sourceText: "me duele una muela de abajo a la izquierda" }],
      transcript: "me duele una muela de abajo a la izquierda cuando tomo algo frio hace como dos semanas",
    })
    // Pausa 10, el examen de la doctora: Clío la ordenó como otra consulta con otro motivo y otro tiempo.
    const exam = "la 36 tiene caries profunda oclusal que llega a pulpa dolor al frio que se queda pulpitis irreversible de la 36"
    await segment({ drafts: [{ kind: "nota", payload: { reason: "dolor al frío que se queda", illnessDuration: "un rato" }, sourceText: "dolor al frio que se queda" }], transcript: exam })
    const [note] = await notes()
    expect(note?.payload).toMatchObject({ reason: "dolor de una muela de abajo a la izquierda", illnessDuration: "dos semanas" })
    expect(note?.summary).not.toContain("antes dijo")
    // Quien se corrige sí lo cambia, con su «antes dijo».
    await segment({ drafts: [{ kind: "nota", payload: { illnessDuration: "un mes" }, sourceText: "ya es un mes" }], transcript: "no, perdón, ya es un mes" })
    const [after] = await notes()
    expect(after?.payload).toMatchObject({ reason: "dolor de una muela de abajo a la izquierda", illnessDuration: "un mes" })
    expect(after?.summary).toContain("(antes dijo «dos semanas»)")
    await enable(false)
  })

  it("una pausa que corrige y suma lo mismo a la vez no lo repite en el relato", async () => {
    await enable(true)
    const { segment, notes } = await session()
    const [note] = (await segment({ drafts: [{ kind: "nota", payload: { presentIllness: "Le duele al masticar." } }], transcript: "le duele al masticar" })).suggestions
    const said = "y dice que el dolor le dura varios minutos"
    await segment({
      drafts: [{ kind: "nota", payload: { presentIllness: "Le duele por varios minutos." }, sourceText: said }],
      corrections: [{ suggestionId: note!.id, changes: { presentIllness: "Le duele al masticar. El dolor le dura varios minutos." }, said }],
      transcript: said,
    })
    // Antes: «…El dolor le dura varios minutos. Le duele por varios minutos.»
    expect((await notes())[0]?.payload["presentIllness"]).toBe("Le duele al masticar. El dolor le dura varios minutos.")
    await enable(false)
  })
})

// QA del 23 nov (verificador 2): el tiempo corregido decía «corregido por voz, antes otro texto en
// tiempo de enfermedad», sin lo que decía.
describe("«corregido por voz» dice lo que decía", () => {
  it("el tiempo corregido dice «antes dijo «dos semanas»»", async () => {
    await enable(true)
    const { segment, notes } = await session()
    const [note] = (await segment({ drafts: [{ kind: "nota", payload: { reason: "Dolor de muela", illnessDuration: "dos semanas" } }], transcript: "hace dos semanas" })).suggestions
    const said = "no perdon ya es un mes"
    expect((await segment({ drafts: [], corrections: [{ suggestionId: note!.id, changes: { illnessDuration: "un mes" }, said }], transcript: said })).corrected).toEqual([note!.id])
    const [after] = await notes()
    expect(after?.payload["illnessDuration"]).toBe("un mes")
    expect(after?.voice?.before).toBe("dijo «dos semanas»")
    await enable(false)
  })
})
