import {
  AGENT_ADDRESSES,
  AGENT_EMOJIS,
  AGENT_TONES,
  type AgentAddress,
  type AgentEmojis,
  type AgentTone,
  type TeamHours,
} from "@gestoria/db"
import { z } from "zod"
import { addDays, dayIn, startOfDay, weekdayOf } from "../hora.js"
import { MAX_ORDER_CENTS, type Quote } from "../precio.js"

/**
 * Lo que la tienda elige para Sofi (tablero 8 de «gestorIA · Configuración, de nuevo»; ADR 0234):
 * cómo habla, qué puede ofrecer, cuándo pasa el chat a una persona y el horario del equipo. Cada
 * opción tiene su frase fija, escrita aquí: la tienda elige, nunca le escribe instrucciones. Lo que
 * el modelo recibe de cada opción es esa frase; lo que puede ofrecer lo frena además cotizar
 * (`offerNotAllowed`), y el monto que pasa a una persona, armar_pedido.
 */

export interface AgentChoices {
  tone: AgentTone
  address: AgentAddress
  emojis: AgentEmojis
  offerShipping: boolean
  offerDiscount: boolean
  offerGift: boolean
  offerSecond: boolean
  handoffUpset: boolean
  handoffOverCents: number | null
  teamHours: TeamHours | null
  afterHoursSells: boolean
}

/** Lo de una tienda que todavía no eligió nada: lo del tablero 8. */
export const DEFAULT_CHOICES: AgentChoices = {
  tone: "cercana",
  address: "tu",
  emojis: "pocos",
  offerShipping: true,
  offerDiscount: true,
  offerGift: true,
  offerSecond: false,
  handoffUpset: true,
  handoffOverCents: null,
  teamHours: null,
  afterHoursSells: true,
}

/** Lo elegido, de la fila de `store_agent`; lo de siempre si la tienda no eligió nada. */
export function choicesOf(row: AgentChoices | null | undefined): AgentChoices {
  if (!row) return DEFAULT_CHOICES
  const picked = {} as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_CHOICES)) picked[key] = row[key as keyof AgentChoices]
  return picked as unknown as AgentChoices
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Elige la hora")

export const teamHoursInput = z
  .object({
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Elige al menos un día")
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    from: hhmm,
    to: hhmm,
  })
  .refine((hours) => hours.from < hours.to, {
    message: "La hora de cierre va después de la de apertura",
    path: ["to"],
  })

export const choicesInput = z.object({
  tone: z.enum(AGENT_TONES),
  address: z.enum(AGENT_ADDRESSES),
  emojis: z.enum(AGENT_EMOJIS),
  offerShipping: z.boolean(),
  offerDiscount: z.boolean(),
  offerGift: z.boolean(),
  offerSecond: z.boolean(),
  handoffUpset: z.boolean(),
  handoffOverCents: z
    .number()
    .int()
    .min(1, "Escribe el monto")
    .max(MAX_ORDER_CENTS, "Ese monto es demasiado grande")
    .nullable(),
  teamHours: teamHoursInput.nullable(),
  afterHoursSells: z.boolean(),
})

/* ------------------------------------------------------------------ cómo habla */

/**
 * Cómo lo dice cada tono, sin importes: el modelo no copia un precio de un ejemplo. Los ejemplos
 * son de la mitad de una charla: uno que abre con un saludo la hace saludar en cada mensaje, y uno
 * que abre con «¡Sí!», decir que sí antes de lo que sea.
 */
const TONE_WORDS: Record<AgentTone, string> = {
  cercana:
    "Cercana: cálida y con entusiasmo, como una amiga que sabe de lo que vende. Por ejemplo: «Es el que más sale, Ana, ¡te va a encantar!»",
  formal:
    "Amable y formal: respetuosa y ordenada, sin confianzas ni bromas. Por ejemplo: «Le comento, Ana, que es nuestro modelo más vendido.»",
  directa:
    "Directa: lo justo, el dato primero y una pregunta para avanzar. Por ejemplo: «Lo tengo en tu talla. ¿Te lo envío?»",
}
const ADDRESS_WORDS: Record<AgentAddress, string> = {
  tu: "Tratas a la clienta de tú.",
  usted: "Tratas a la clienta de usted, siempre, aunque ella te tutee.",
}
const EMOJI_WORDS: Record<AgentEmojis, string> = {
  ninguno: "No usas emojis.",
  pocos: "Puedes usar un emoji de vez en cuando, nunca más de uno por mensaje.",
}

/** Las frases fijas de cómo habla, para lo que lee Sofi. */
export const styleFacts = (c: Pick<AgentChoices, "tone" | "address" | "emojis">) => [
  `- Tono: ${TONE_WORDS[c.tone]}`,
  `- ${ADDRESS_WORDS[c.address]}`,
  `- ${EMOJI_WORDS[c.emojis]}`,
]

/** Cómo habla, en palabras de la tienda: lo que dice «Por qué» en la prueba. */
const TONE_NAMES: Record<AgentTone, string> = {
  cercana: "cercana",
  formal: "amable y formal",
  directa: "directa",
}
export const styleWords = (c: Pick<AgentChoices, "tone" | "address" | "emojis">) =>
  `${TONE_NAMES[c.tone]}, de ${c.address === "tu" ? "tú" : "usted"}, ${c.emojis === "ninguno" ? "sin emojis" : "con pocos emojis"}`

/* ---------------------------------------------------------------- qué ofrece */

export type OfferKind = "envio" | "descuento" | "regalo" | "segundo"

export const OFFER_NAMES: Record<OfferKind, string> = {
  envio: "envío gratis o más barato",
  descuento: "un descuento",
  regalo: "un regalo",
  segundo: "una rebaja por llevar dos o más",
}

/**
 * Qué cede una cotización: el envío que pone la tienda (no el gratis por monto, que es su regla),
 * un regalo, o una rebaja del precio. La rebaja es «segundo» si lleva dos o más y la tienda no
 * deja descuentos sueltos.
 */
export function offerKindsOf(
  q: Pick<
    Quote,
    | "deliveryCents"
    | "deliveryListCents"
    | "deliveryFreeByPolicy"
    | "giftCents"
    | "discountCents"
    | "lines"
  >,
  choices: Pick<AgentChoices, "offerDiscount">,
): OfferKind[] {
  const kinds: OfferKind[] = []
  if (!q.deliveryFreeByPolicy && q.deliveryCents < q.deliveryListCents) kinds.push("envio")
  if (q.discountCents > 0) {
    const units = q.lines.filter((l) => !l.gift).reduce((n, l) => n + l.quantity, 0)
    kinds.push(!choices.offerDiscount && units >= 2 ? "segundo" : "descuento")
  }
  if (q.giftCents > 0) kinds.push("regalo")
  return kinds
}

/** Lo que la tienda no deja ofrecer en esta cotización, o null si todo está permitido. */
export function offerNotAllowed(kinds: OfferKind[], choices: AgentChoices): OfferKind | null {
  const allowed = allowedOffers(choices)
  return kinds.find((kind) => !allowed.includes(kind)) ?? null
}

/**
 * Lo que dice cotizar cuando la tienda no deja esa oferta. Si la clienta la pidió, Sofi no abre
 * con «¡Sí!» para después decir que no: la clienta lee un sí a lo que pidió.
 */
export function notAllowedWords(kind: OfferKind, choices: AgentChoices): string {
  const allowed = allowedOffers(choices)
  return `La tienda no deja ofrecer ${OFFER_NAMES[kind]}. Si te lo pidió, díselo de entrada, con amabilidad y sin abrir con «¡Sí!» ni «¡Claro!». ${
    allowed.length
      ? `Puedes ofrecer: ${allowed.map((k) => OFFER_NAMES[k]).join("; ")}.`
      : "No ofreces nada: vende con el valor del producto, a su precio."
  }`
}

export function allowedOffers(c: AgentChoices): OfferKind[] {
  return (
    [
      ["envio", c.offerShipping],
      ["descuento", c.offerDiscount],
      ["regalo", c.offerGift],
      ["segundo", c.offerSecond && !c.offerDiscount],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([kind]) => kind)
}

/* ------------------------------------------------------------- el horario */

const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

/** «9 a. m.», «7:30 p. m.»: como lo dice la tienda. */
export function hourWords(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number]
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "a. m." : "p. m."}`
}

/** «lunes a sábado», «lunes, miércoles y viernes», «todos los días». */
export function daysWords(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return "todos los días"
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1)
  if (contiguous && sorted.length >= 3)
    return `${DAY_NAMES[sorted[0]! - 1]} a ${DAY_NAMES[sorted.at(-1)! - 1]}`
  const names = sorted.map((d) => DAY_NAMES[d - 1]!)
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

export const hoursWords = (h: TeamHours) =>
  `${daysWords(h.days)}, de ${hourWords(h.from)} a ${hourWords(h.to)}`

/** El momento en que el equipo cierra ese día (para decir cuándo vuelve, visto desde ahí). */
export function closingOf(hours: TeamHours, timeZone: string, day: string): Date {
  const [h, m] = hours.to.split(":").map(Number) as [number, number]
  return new Date(startOfDay(timeZone, day).getTime() + (h * 60 + m) * 60_000)
}

/** La hora de la tienda («HH:MM») en ese momento. */
function timeIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)
}

/**
 * Si el equipo atiende ahora y, si no, cuándo vuelve: «hoy desde las 9 a. m.», «mañana desde las
 * 9 a. m.» o «el lunes desde las 9 a. m.». Sin horario, siempre atiende (no se dice cuándo).
 */
export function teamNow(
  hours: TeamHours | null,
  timeZone: string,
  now: Date,
): { open: boolean; back: string | null } {
  if (!hours) return { open: true, back: null }
  const today = dayIn(timeZone, now)
  const isoDay = (day: string) => weekdayOf(day) + 1
  const time = timeIn(timeZone, now)
  if (hours.days.includes(isoDay(today)) && time >= hours.from && time < hours.to)
    return { open: true, back: null }
  const from = hourWords(hours.from)
  if (hours.days.includes(isoDay(today)) && time < hours.from)
    return { open: false, back: `hoy desde las ${from}` }
  for (let ahead = 1; ahead <= 7; ahead++) {
    const day = addDays(today, ahead)
    if (!hours.days.includes(isoDay(day))) continue
    return {
      open: false,
      back:
        ahead === 1
          ? `mañana desde las ${from}`
          : `el ${DAY_NAMES[isoDay(day) - 1]} desde las ${from}`,
    }
  }
  return { open: false, back: null }
}
