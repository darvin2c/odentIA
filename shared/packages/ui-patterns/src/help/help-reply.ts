import { z } from "zod"

/**
 * Lo que responde Ariadna, la misma en todas las apps (ADR 0146 y 0178): la forma de
 * `POST <api>/help/ask` y de `GET <api>/help/screen`. Cada app lo pide a su servidor y su
 * servidor a Ariadna; el panel común (`HelpButton`) lo muestra igual en todas.
 */

/** Quien responde en la Ayuda, en todas las apps: el botón dice «Ayuda», porque dice para qué sirve. */
export const HELP_NAME = "Ariadna"

const helpAnswer = z.object({
  topicId: z.string(),
  where: z.string(),
  text: z.string(),
  path: z.string().nullable(),
  restriction: z.string().nullable(),
  /** Los videos de esa respuesta, si los tiene; un servidor que aún no los entrega no manda el campo. */
  videos: z
    .array(z.object({ title: z.string(), url: z.string(), minutes: z.number().nullable() }))
    .optional(),
})
export type HelpAnswer = z.infer<typeof helpAnswer>
export type HelpVideo = NonNullable<HelpAnswer["videos"]>[number]

export const helpReply = z.object({
  askId: z.string(),
  kind: z.enum(["guia", "estado", "duda", "nada", "datos", "charla"]),
  say: z.string().nullable().optional(),
  /** `guia` redactada: lo que Ariadna escribió uniendo `answers`. Sin ella (o de un servidor anterior), la guía tal cual. */
  written: z.string().nullable().optional(),
  answers: z.array(helpAnswer),
  blockers: z.array(
    z.object({ text: z.string(), where: z.string().nullable(), path: z.string().nullable() }),
  ),
  /** La duda: respuestas de la guía para elegir; tocar una la pregunta tal cual, sin modelo. */
  choices: z.array(z.object({ question: z.string(), where: z.string() })).default([]),
  /** Lo de las cifras: si puede preguntárselo al agente de las cifras de la app (Argos). */
  argos: z.boolean().default(false),
  /** Lo que cuesta preguntárselo, dicho por el servidor como está hoy. */
  argosNote: z.string().nullable().default(null),
  basedOn: z.string(),
})
export type HelpReply = z.infer<typeof helpReply>
export const helpAskEnvelope = z.object({ data: helpReply })

/** Lo que un envío al equipo de la app lleva sin que la persona lo escriba, con sus valores. */
export const helpAttachments = z.object({
  screen: z.string(),
  role: z.string(),
  /** El lugar de trabajo de quien pregunta: la clínica o la tienda. */
  clinic: z.string().nullable(),
  version: z.string().nullable(),
})
export type HelpAttachments = z.infer<typeof helpAttachments>

export const helpScreenEnvelope = z.object({
  data: z.object({
    title: z.string().nullable(),
    suggestions: z.array(z.string()),
    attached: helpAttachments.optional(),
  }),
})
export type HelpScreen = z.infer<typeof helpScreenEnvelope>["data"]

/** Una pregunta con lo que pasó con ella; la conversación vive en la pestaña, no en el servidor. */
export interface HelpExchange {
  id: number
  question: string
  /** Dónde se preguntó: la conversación sigue al navegar y lo que se envía después dice esa pantalla. */
  screen: string
  attached: HelpAttachments | undefined
  /** Nula mientras se espera (o si no se pudo): la pregunta se ve desde que se envía. */
  reply: HelpReply | null
  /** Por qué no se pudo responder; con «Intentar de nuevo». */
  error: string | null
  /** Cuándo llegó la respuesta: una pregunta de seguimiento solo se entiende con una reciente. */
  answeredAt: number | null
  /** Lo que la persona dijo de la respuesta, si ya lo dijo. */
  helpful?: boolean
  /** Ya la envió al equipo de la app, o dijo que no. */
  sent?: "enviada" | "no"
  /** Dijo que ninguna era lo que buscaba (en la duda o entre los textos de una redactada): se ofrece enviarla. */
  noneFits?: boolean
  /** La redactada no sirvió y eligió uno de sus textos de origen: se muestra tal cual. */
  picked?: number
}

/** La pregunta anterior que viaja con una de seguimiento («¿y cómo la creo?»). */
export interface HelpPrevious {
  question: string
  where: string | null
}

/** Pasado este tiempo, una pregunta ya no es de seguimiento: viaja sola. */
export const FOLLOW_UP_MS = 10 * 60_000

/**
 * Lo anterior que acompaña a la pregunta nueva, sin ningún control: solo si lo
 * último que se respondió fue una respuesta de verdad (`guia` o `estado`), es
 * reciente y la persona no dijo que no le sirvió. Tras una duda, un «no está»,
 * las cifras o un saludo no viaja nada: arrastraría un tema que no se respondió.
 */
export function previousOf(
  exchanges: ReadonlyArray<Pick<HelpExchange, "question" | "reply" | "answeredAt" | "helpful">>,
  now: number,
): HelpPrevious | undefined {
  const last = exchanges.findLast((item) => item.reply !== null)
  if (!last?.reply || last.answeredAt === null) return undefined
  if (last.reply.kind !== "guia" && last.reply.kind !== "estado") return undefined
  if (last.helpful === false || now - last.answeredAt >= FOLLOW_UP_MS) return undefined
  return { question: last.question, where: last.reply.answers[0]?.where || null }
}

/** Lo que el aviso del lector de pantalla dice de una respuesta. */
export function spokenReply(reply: HelpReply): string {
  if (reply.kind === "guia")
    return reply.written ?? reply.answers.map((answer) => answer.text).join(" ")
  if (reply.kind === "estado")
    return `Esto es lo que falta ahora: ${reply.blockers.map((blocker) => blocker.text).join(" ")}`
  return reply.say ?? "Esto no está en la guía, y no quiero inventarlo."
}

/** Videos a la vista por pregunta: dos como mucho, sumando los de todos sus textos. */
const VIDEOS_SHOWN = 2
const videosOf = (answer: HelpAnswer) =>
  (answer.videos ?? []).filter((video) => /^https:\/\//i.test(video.url))
/** Los videos que se muestran: los de un texto (`at`) sin pasar el tope de la pregunta, o los de todos juntos. */
export function shownVideos(answers: readonly HelpAnswer[], at?: number): HelpVideo[] {
  // Un mismo video puede estar unido a dos respuestas que se muestran juntas: sale una vez.
  const once = (videos: HelpVideo[]) =>
    videos.filter((video, index) => videos.findIndex((other) => other.url === video.url) === index)
  if (at === undefined) return once(answers.flatMap(videosOf)).slice(0, VIDEOS_SHOWN)
  const before = once(answers.slice(0, at).flatMap(videosOf))
  const answer = answers[at]
  if (!answer) return []
  return once(videosOf(answer))
    .filter((video) => !before.some((other) => other.url === video.url))
    .slice(0, Math.max(0, VIDEOS_SHOWN - before.length))
}

/**
 * Abre la Ayuda desde fuera de su botón (el menú «⋯» del teléfono). Con
 * `detail.support` abre ya el mensaje a soporte con ese texto escrito, para que
 * la persona lo lea, lo complete y lo envíe ella (`openSupportRequest`).
 */
export const OPEN_HELP_EVENT = "odentia:abrir-ayuda"

/** Le pasa a la Ayuda una pregunta que no se escribió en ella (el buscador rápido). */
export const ASK_HELP_EVENT = "odentia:preguntar-ayuda"

/** Abre la Ayuda con un mensaje a soporte ya escrito; no se envía solo. */
export function openSupportRequest(text: string) {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { support: text } }))
}
