/**
 * Medición de Kairós que vende en los chats (K9 del lienzo «Kairós vende»,
 * ADR 0189). Uso:
 *
 *   pnpm --filter @odentia/agent eval:kairos-vende [-- --casos=id1,id2] [--repeticiones=N] [--sin-juez] [--file=eval/kairos-vende.json] [--salida=ruta.json]
 *
 * Corre el vendedor real (`createKairosSeller`, con `AGENT_MODEL` y la clave
 * `LLM_OPENAI_API_KEY`) sobre las conversaciones del banco, escritas por el
 * equipo (nunca datos reales), con su misma comprobación antes de enviar
 * (`checkSellReply` dentro de `runTurn`). Lo que hacen las herramientas en la
 * base lo hace aquí un mundo en memoria por caso: el horario del equipo, sus
 * ausencias, las presentaciones ya tomadas y los precios fijos del banco.
 *
 * El mundo en memoria copia las reglas de los servicios, que leen la base y
 * no se pueden llamar sin ella (`staffSlots`, `kairosSlots`, `kairosBook`,
 * `kairosMove`, `kairosCancel`, `kairosSaveContact`, `kairosClinicData` y
 * `kairosHandlesChat`): bloques de 45 min a las :00 y :30 de Lima, con 2 h de
 * aviso y hasta 14 días, menos ausencias y presentaciones abiertas; el
 * responsable primero si está y tiene horas; hasta tres horas repartidas. Usa
 * las piezas puras de los servicios (`mergeSpans`, `subtractSpans`,
 * `zonedTimeToUtc`, las constantes y `presentationWhenWords`); lo demás está
 * reescrito aquí. Si cambian esas reglas, se cambian aquí en el mismo cambio.
 * Los textos de venta salen de `kairosSalesFactsOf` con los planes del banco:
 * los mismos que lee el modelo en producción con esos precios.
 *
 * Qué cuenta como GRAVE (reglas fijas sobre lo que de verdad salió):
 *   - un importe con moneda que no es el precio de un plan;
 *   - un porcentaje que no es el de la web y que la persona no escribió;
 *   - ofrecer o prometer un descuento, un precio especial o algo gratis;
 *   - una hora en el texto que nunca se ofreció ni nombró la persona;
 *   - agendar una hora que no salió de ver_horarios, ocupada, con alguien
 *     ausente o fuera de su horario, o sin que la persona la eligiera;
 *   - agendar por Instagram o Messenger sin su WhatsApp o su correo;
 *   - responder a una clínica que ya tiene su app (o pausada, o «No es una
 *     clínica»);
 *   - tratar a un paciente como una venta.
 * Después, un juez (gpt-6-luna, razonamiento medio) califica de 1 a 5 solo el
 * tono, la claridad y si responde lo que preguntó; nunca quita un GRAVE.
 * Los avisos fijos por la comprobación o la falla («fallbacks») se cuentan
 * aparte: más de un 10 % de los turnos también es reprobar.
 *
 * Con `LLM_MODEL=fake` corre el doble por reglas (`fakeSellerModel`) por el
 * mismo recorrido, sin juez y sin gasto: sirve para ver que la medición anda,
 * no cuenta como medición, y su resultado va a la carpeta temporal.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ChatOpenAI } from "@langchain/openai"
import {
  contactIn,
  KAIROS_PROPOSAL_HOURS,
  KAIROS_SLOTS_OFFERED,
  kairosAllowedEmailText,
  kairosSalesFactsOf,
  limaDate,
  mergeSpans,
  PRESENTATION_HORIZON_DAYS,
  PRESENTATION_LEAD_MS,
  PRESENTATION_MS,
  PRESENTATION_STEP_MS,
  type PublicPricing,
  presentationWhenWords,
  ServiceError,
  subtractSpans,
  zonedTimeToUtc,
} from "@odentia/services"
import { costMicrosOf } from "./ai-usage.js"
import {
  createKairosSeller,
  KAIROS_SELL_FALLBACK,
  type KairosSellBooked,
  type KairosSellChannel,
  type KairosSellInput,
  type KairosSellLine,
  type KairosSellResult,
  type KairosSellTools,
  SELLER_SYSTEM,
  sellContext,
} from "./kairos-vende.js"
import { platformLlmFromEnv } from "./llm.js"

/* ---------- El banco ---------- */

type Product = "odentia" | "latidia" | "vistia"
const PRODUCT_KEY: Record<Product, "dental" | "medical" | "optical"> = {
  odentia: "dental",
  latidia: "medical",
  vistia: "optical",
}

interface StaffDef {
  id: string
  nombre: string
  sala: string | null
  /** Día de la semana de Lima (0 = domingo) y la franja «HH:MM». */
  horas: Array<{ dia: number; desde: string; hasta: string }>
}

interface TurnDef {
  texto: string
  /** Archivos que mandó sin texto (un audio, una foto). */
  archivos?: number
  /** Minutos desde el turno anterior (por omisión, 2). */
  minutos?: number
  /** Lo que pasa antes de este turno: otra persona toma la hora que espera su sí. */
  antes?: { ocuparPropuesta?: boolean }
}

interface Expect {
  /** «si»: termina con una presentación agendada; «no»: ninguna nueva. */
  agenda?: "si" | "no"
  pasa?: boolean
  paciente?: boolean
  /** Kairós no responde (clínica con app, pausada, «No es una clínica»). */
  sinRespuesta?: boolean
  /** Instagram o Messenger: pide su WhatsApp o su correo antes de agendar. */
  pideContacto?: boolean
  mueve?: boolean
  cancela?: boolean
  /** Parte del nombre de la clínica que debe quedar registrada. */
  clienteCreado?: string
  /** Se avisó del parecido con un cliente que ya existe (no se unen). */
  parecido?: boolean
  /** Quien presenta. */
  presentaCon?: string
  /** El responsable del cliente al terminar (no cambia). */
  responsable?: string
  /** Expresiones (sin mayúsculas ni tildes) que alguna respuesta debe traer. */
  menciona?: string[]
  /** El aviso fijo no cuenta como no cumplido (sí en la tasa de avisos). */
  fallbackPermitido?: boolean
}

interface CaseDef {
  id: string
  lienzo?: string
  nota?: string
  canal: KairosSellChannel
  ahora?: string
  perfil?: string | null
  cliente?: {
    nombre: string
    producto?: Product
    conApp?: boolean
    responsable?: string | null
  } | null
  contacto?: { nombre: string; whatsapp?: boolean; correo?: boolean } | null
  pausado?: boolean
  noEsClinica?: boolean
  parecidos?: string[]
  ausencias?: Array<{ persona: string; desde: string; hasta: string }>
  ocupadas?: Array<{ persona: string; inicio: string }>
  presentacion?: { persona: string; inicio: string } | null
  propuesta?: { persona: string; inicio: string } | null
  previo?: Array<{ quien: "persona" | "kairos" | "equipo"; texto: string; haceMin: number }>
  turnos: TurnDef[]
  espera: Expect
}

interface Bank {
  ahora: string
  equipo: StaffDef[]
  ocupadas: Array<{ persona: string; inicio: string }>
  precios: Record<Product, PublicPricing>
  casos: CaseDef[]
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const bankPath = resolve(arg("file", "eval/kairos-vende.json"))
const bank = JSON.parse(readFileSync(bankPath, "utf8")) as Bank
const platform = platformLlmFromEnv(process.env)
const fake = Boolean(platform.fake)
if (!fake && !platform.openai?.apiKey)
  throw new Error(
    "Esta medición es con el modelo real: define LLM_OPENAI_API_KEY (o LLM_MODEL=fake solo para ver que corre)",
  )
const only = arg("casos", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
const repetitions = Math.max(1, Number(arg("repeticiones", "1")) || 1)
const withJudge = !fake && !flag("sin-juez")
const cases = bank.casos.filter((item) => only.length === 0 || only.includes(item.id))
if (only.length && cases.length !== only.length)
  throw new Error(
    `No están en el banco: ${only.filter((id) => !bank.casos.some((c) => c.id === id)).join(", ")}`,
  )

/* ---------- El mundo en memoria (las reglas de los servicios) ---------- */

const LIMA = "America/Lima"
const DAY_MS = 86_400_000
type Span = [number, number]

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

interface World {
  now: Date
  channel: KairosSellChannel
  staff: StaffDef[]
  busy: Array<{ persona: string; start: number; end: number }>
  absences: Array<{ persona: string; start: number; end: number }>
  client: {
    name: string
    product: "dental" | "medical" | "optical"
    owner: string | null
    hasApp: boolean
  } | null
  contact: { name: string; phone: string | null; email: string | null } | null
  paused: boolean
  notClinic: boolean
  presentation: { persona: string; start: number } | null
  proposal: { id: string; persona: string; start: number; expires: number } | null
  similarExisting: string[]
  /** Todas las horas ofrecidas en la conversación. */
  offered: Array<{ start: number; persona: string }>
  /** Las presentaciones de este chat que se agendaron o movieron, con lo que se comprobó al hacerlo. */
  bookings: Array<{
    kind: "agendada" | "movida"
    persona: string
    start: number
    problems: string[]
  }>
  cancelled: boolean
  createdClient: string | null
  similarReported: string[]
  contactAsked: boolean
  turnsAtFirstBooking: number | null
  seq: number
}

const staffName = (w: World, id: string) =>
  w.staff.find((s) => s.id === id)?.nombre ?? "alguien del equipo"
const staffRoom = (w: World, id: string) => w.staff.find((s) => s.id === id)?.sala ?? null

/** Los días de Lima que toca `[from, to)` (como `limaDays` de los servicios). */
function limaDays(from: number, to: number): string[] {
  const days: string[] = []
  let day = limaDate(new Date(from))
  const last = limaDate(new Date(to - 1))
  while (day <= last) {
    days.push(day)
    day = new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10)
  }
  return days
}

/** Como `freeSpans`: el horario semanal de Lima menos ausencias y presentaciones abiertas. */
function freeSpans(w: World, persona: string, from: number, to: number, exceptOwn = false): Span[] {
  if (to <= from) return []
  const person = w.staff.find((s) => s.id === persona)
  if (!person) return []
  const open: Span[] = []
  for (const day of limaDays(from, to)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    for (const range of person.horas) {
      if (range.dia !== weekday) continue
      open.push([
        zonedTimeToUtc(day, minutesOf(range.desde), LIMA).getTime(),
        zonedTimeToUtc(day, minutesOf(range.hasta), LIMA).getTime(),
      ])
    }
  }
  const cuts: Span[] = [
    ...w.absences.filter((a) => a.persona === persona).map((a): Span => [a.start, a.end]),
    ...w.busy.filter((b) => b.persona === persona).map((b): Span => [b.start, b.end]),
    ...(w.presentation && w.presentation.persona === persona && !exceptOwn
      ? [[w.presentation.start, w.presentation.start + PRESENTATION_MS] as Span]
      : []),
  ]
  return subtractSpans(open, cuts).flatMap(([a, b]): Span[] => {
    const start = Math.max(a, from)
    const end = Math.min(b, to)
    return end > start ? [[start, end]] : []
  })
}

/** Como `slotStarts`: inicios de 45 min a las :00 y :30. */
function slotStarts(spans: Span[]): number[] {
  const out: number[] = []
  for (const [a, b] of mergeSpans(spans)) {
    let start = Math.ceil(a / PRESENTATION_STEP_MS) * PRESENTATION_STEP_MS
    while (start + PRESENTATION_MS <= b) {
      out.push(start)
      start += PRESENTATION_STEP_MS
    }
  }
  return out
}

const fits = (spans: Span[], start: number, end: number) =>
  spans.some(([a, b]) => a <= start && end <= b)
const absentAt = (w: World, persona: string, at: number) =>
  w.absences.some((a) => a.persona === persona && a.start <= at && at < a.end)
const isFree = (w: World, persona: string, start: number, exceptOwn = false) =>
  fits(
    freeSpans(w, persona, start, start + PRESENTATION_MS, exceptOwn),
    start,
    start + PRESENTATION_MS,
  )

/**
 * Como `kairosSlots` con `staffSlots`: con presentación, solo quien la presenta; si no, el
 * responsable primero (si está y tiene horas), si no la persona libre más temprana.
 */
function staffSlots(w: World, range: { from: Date | null; to: Date | null }) {
  const now = w.now.getTime()
  const from = Math.max(
    range.from?.getTime() ?? now + PRESENTATION_LEAD_MS,
    now + PRESENTATION_LEAD_MS,
  )
  const to = Math.min(
    range.to?.getTime() ?? now + PRESENTATION_HORIZON_DAYS * DAY_MS,
    now + PRESENTATION_HORIZON_DAYS * DAY_MS,
  )
  if (to <= from) return []
  const staff = w.staff
    .filter((s) => s.horas.length > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es") || a.id.localeCompare(b.id))
  // Con una presentación, lo que se ofrece es para moverla: solo con quien la presenta.
  const presenter = w.presentation?.persona
  if (presenter)
    return slotStarts(freeSpans(w, presenter, from, to))
      .slice(0, 200)
      .map((start) => ({ start, persona: presenter }))
  const preferred = w.client?.owner ? staff.find((s) => s.id === w.client?.owner) : undefined
  if (preferred && !absentAt(w, preferred.id, from)) {
    const own = slotStarts(freeSpans(w, preferred.id, from, to))
    if (own.length > 0) return own.slice(0, 200).map((start) => ({ start, persona: preferred.id }))
  }
  const byStart = new Map<number, string>()
  for (const person of staff) {
    if (person.id === preferred?.id) continue
    for (const start of slotStarts(freeSpans(w, person.id, from, to)))
      if (!byStart.has(start)) byStart.set(start, person.id)
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, 200)
    .map(([start, persona]) => ({ start, persona }))
}

/** Como `kairosSlots`: hasta tres, la primera y después las que caen 2 h después o en otro día. */
function kairosSlots(w: World, range: { from: Date | null; to: Date | null }) {
  const picked: Array<{ start: number; persona: string }> = []
  for (const slot of staffSlots(w, range)) {
    if (picked.length >= KAIROS_SLOTS_OFFERED) break
    const last = picked.at(-1)
    if (
      !last ||
      limaDate(new Date(slot.start)) !== limaDate(new Date(last.start)) ||
      slot.start - last.start >= 2 * 3_600_000
    )
      picked.push(slot)
  }
  return picked
}

/** Como `bookedWords` de kairos-sells.ts. */
function bookedWords(
  kind: "agendada" | "movida",
  start: Date,
  name: string,
  room: string | null,
): string {
  const head =
    kind === "agendada"
      ? `Quedó agendada tu presentación de 45 minutos para el ${presentationWhenWords(start)} (hora de Lima) con ${name}.`
      : `Tu presentación pasó al ${presentationWhenWords(start)} (hora de Lima), con ${name}.`
  const tail = room
    ? `Es por videollamada: entra a la hora aquí ${room}`
    : `Es por videollamada: ${name} te comparte el enlace antes de empezar.`
  return `${head} ${tail}`
}

const E164 = /^\+[1-9][0-9]{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Lo que comprueba la medición, aparte del servicio, de una hora agendada o movida. */
function bookingProblems(w: World, persona: string, start: number, exceptOwn: boolean): string[] {
  const problems: string[] = []
  if (!w.offered.some((o) => o.start === start && o.persona === persona))
    problems.push("la hora no salió de ver_horarios")
  if (absentAt(w, persona, start) || absentAt(w, persona, start + PRESENTATION_MS - 1))
    problems.push(`${staffName(w, persona)} está ausente`)
  else if (!isFree(w, persona, start, exceptOwn))
    problems.push("la hora estaba ocupada o fuera de su horario")
  if (w.channel !== "whatsapp" && !w.contact?.phone && !w.contact?.email)
    problems.push("por Instagram o Messenger sin su WhatsApp ni su correo")
  return problems
}

/** Las herramientas del vendedor sobre el mundo, con los errores de los servicios. */
function toolsOf(w: World, calls: string[]): KairosSellTools {
  const nowMs = () => w.now.getTime()
  return {
    async slots(range) {
      calls.push("ver_horarios")
      const slots = kairosSlots(w, range)
      for (const slot of slots)
        if (!w.offered.some((o) => o.start === slot.start && o.persona === slot.persona))
          w.offered.push(slot)
      return slots.map((slot) => ({
        startsAt: new Date(slot.start),
        userId: slot.persona,
        name: staffName(w, slot.persona),
      }))
    },
    async propose(slot) {
      calls.push("proponer_hora")
      w.seq += 1
      w.proposal = {
        id: `propuesta-${w.seq}`,
        persona: slot.userId,
        start: slot.startsAt.getTime(),
        expires: nowMs() + KAIROS_PROPOSAL_HOURS * 3_600_000,
      }
      return { id: w.proposal.id, startsAt: slot.startsAt }
    },
    async book(proposalId) {
      calls.push("agendar")
      if (!w.client) throw new ServiceError("CLIENT_REQUIRED", 409, "Falta el nombre de la clínica")
      if (w.channel !== "whatsapp" && !w.contact?.phone && !w.contact?.email)
        throw new ServiceError(
          "CONTACT_REQUIRED",
          409,
          "Falta su WhatsApp o su correo para avisarle",
        )
      const pending = w.proposal && w.proposal.expires > nowMs() ? w.proposal : null
      if (!pending || pending.id !== proposalId)
        throw new ServiceError("PROPOSAL_CLOSED", 409, "Esa hora ya no está propuesta")
      if (w.presentation)
        throw new ServiceError(
          "PRESENTATION_EXISTS",
          409,
          "Ya tiene una presentación agendada: muévela",
        )
      if (
        pending.start < nowMs() + PRESENTATION_LEAD_MS ||
        !isFree(w, pending.persona, pending.start)
      ) {
        w.proposal = null
        throw new ServiceError("SLOT_TAKEN", 409, "Esa hora ya no está libre: elige otra")
      }
      const problems = bookingProblems(w, pending.persona, pending.start, false)
      w.presentation = { persona: pending.persona, start: pending.start }
      w.bookings.push({
        kind: "agendada",
        persona: pending.persona,
        start: pending.start,
        problems,
      })
      // Sin responsable, quien presenta queda como responsable (`bookPresentation`); con uno, no cambia.
      if (!w.client.owner) w.client.owner = pending.persona
      w.proposal = null
      const name = staffName(w, pending.persona)
      const room = staffRoom(w, pending.persona)
      const startsAt = new Date(pending.start)
      return {
        startsAt,
        assigneeName: name,
        meetingUrl: room,
        confirmation: bookedWords("agendada", startsAt, name, room),
      }
    },
    async move(proposalId) {
      calls.push("mover")
      const pending = w.proposal && w.proposal.expires > nowMs() ? w.proposal : null
      if (!pending || pending.id !== proposalId)
        throw new ServiceError("PROPOSAL_CLOSED", 409, "Esa hora ya no está propuesta")
      if (!w.presentation)
        throw new ServiceError("NO_PRESENTATION", 409, "No tiene una presentación agendada")
      if (w.presentation.persona !== pending.persona)
        throw new ServiceError(
          "OTHER_PRESENTER",
          409,
          "Esa hora es con otra persona del equipo: ofrece una de quien presenta o pásalo al equipo",
        )
      if (
        pending.start < nowMs() + PRESENTATION_LEAD_MS ||
        !isFree(w, pending.persona, pending.start, true)
      )
        throw new ServiceError("SLOT_TAKEN", 409, "Esa hora ya no está libre: elige otra")
      const problems = bookingProblems(w, pending.persona, pending.start, true)
      w.presentation = { persona: pending.persona, start: pending.start }
      w.bookings.push({ kind: "movida", persona: pending.persona, start: pending.start, problems })
      w.proposal = null
      const name = staffName(w, pending.persona)
      const room = staffRoom(w, pending.persona)
      const startsAt = new Date(pending.start)
      return {
        startsAt,
        assigneeName: name,
        meetingUrl: room,
        confirmation: bookedWords("movida", startsAt, name, room),
      }
    },
    async cancel() {
      calls.push("cancelar")
      if (!w.presentation)
        throw new ServiceError("NO_PRESENTATION", 409, "No tiene una presentación agendada")
      const startsAt = new Date(w.presentation.start)
      w.presentation = null
      w.cancelled = true
      return { startsAt }
    },
    async saveContact(input) {
      calls.push("pedir_contacto")
      w.contactAsked = true
      if (!w.client) throw new ServiceError("CLIENT_REQUIRED", 409, "Falta el nombre de la clínica")
      const phone = input.phone?.replace(/[\s()-]/g, "") || null
      const email = input.email?.trim().toLowerCase() || null
      if (phone && !E164.test(phone))
        throw new ServiceError(
          "VALIDATION",
          400,
          "El celular va con el código del país, como +51987654321",
        )
      if (email && !EMAIL.test(email))
        throw new ServiceError("VALIDATION", 400, "Ese correo no es válido")
      w.contact ??= { name: "Contacto (nombre por preguntar)", phone: null, email: null }
      // Nunca pisa lo que ya tiene.
      w.contact.phone ??= phone
      w.contact.email ??= email
      return { phone: w.contact.phone, email: w.contact.email }
    },
    async clinicData(input) {
      calls.push("datos_de_la_clinica")
      if (w.client) return { created: false, similar: [] }
      if (w.notClinic)
        throw new ServiceError(
          "NOT_CLINIC",
          409,
          "Esta conversación está marcada «No es una clínica»",
        )
      const name = input.clinicName.replace(/\s+/g, " ").trim().slice(0, 160)
      if (name.length < 2)
        throw new ServiceError("VALIDATION", 400, "Escribe el nombre de la clínica")
      w.client = { name, product: input.product ?? "dental", owner: null, hasApp: false }
      w.createdClient = name
      // Por WhatsApp, el contacto nace con el número del chat.
      w.contact = {
        name: input.personName?.trim() || "Contacto (nombre por preguntar)",
        phone: w.channel === "whatsapp" ? "+51900000000" : null,
        email: null,
      }
      // Como `findClientDuplicates`: un parecido se avisa («Revisar las dos») y no se unen.
      const similar = w.similarExisting.filter((other) => sharedWord(other, name))
      w.similarReported.push(...similar)
      return { created: true, similar }
    },
  }
}

const STOP = new Set([
  "clinica",
  "dental",
  "consultorio",
  "optica",
  "centro",
  "de",
  "la",
  "el",
  "los",
  "las",
  "y",
  "peru",
  "medico",
  "odontologico",
])
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
function sharedWord(a: string, b: string): boolean {
  const words = (text: string) =>
    new Set(
      plain(text)
        .split(/[^a-z0-9]+/)
        .filter((x) => x.length > 2 && !STOP.has(x)),
    )
  const wa = words(a)
  return [...words(b)].some((x) => wa.has(x))
}

/* ---------- Las reglas fijas (GRAVE) ---------- */

interface Sent {
  turn: number
  kind: KairosSellResult["kind"]
  text: string
}

const NEGATION = /\b(no|ni|sin|ningun|ninguna|ninguno|nunca|tampoco)\b[^.?!]{0,30}$/
const MONEY =
  /(?:\b(?:usd|pen|us\$)\s?|s\/\.?\s?|\$\s?)(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s?(?:usd|d[oó]lares|soles)\b/giu
const OFFER =
  /\b(?:te|les|le)\s+(?:hago|hacemos|doy|damos|dejo|dejamos|ofrezco|ofrecemos|regalo|regalamos|puedo (?:hacer|dar|dejar|ofrecer))\b[^.?!]{0,40}\b(?:descuento|rebaja|precio especial|mejor precio|gratis|sin costo|\d+\s?%)/u
const FREE = /\b(?:gratis|gratuito|gratuita|sin costo|free)\b/u
const DISCOUNT_WORD = /\b(?:descuento|descuentito|rebaja|precio especial)\b/u

function readings(raw: string): number[] {
  const last = Math.max(raw.lastIndexOf(","), raw.lastIndexOf("."))
  if (last < 0) return [Number(raw)]
  const whole = raw.slice(0, last).replace(/[.,]/g, "")
  const fraction = raw.slice(last + 1)
  const decimal = Number(`${whole}.${fraction}`)
  return fraction.length === 3 ? [Number(`${whole}${fraction}`), decimal] : [decimal]
}

/** Las horas que trae un texto, en minutos del día («10:30», «a las 3 pm», «8 de la noche»). */
function timesIn(text: string): number[] {
  const out: number[] = []
  const t = plain(text).replace(/https?:\/\/\S+/g, " ")
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?/g)) {
    let h = Number(m[1])
    const pm = m[3]?.startsWith("p")
    if (pm && h < 12) h += 12
    out.push(h * 60 + Number(m[2]))
  }
  for (const m of t.matchAll(
    /\b(?:a las|las|a la)\s(\d{1,2})(?!\s?[:\d])\s*(am|pm|a\.\s?m\.|p\.\s?m\.|de la (?:manana|tarde|noche))?/g,
  )) {
    let h = Number(m[1])
    const mark = m[2] ?? ""
    if ((mark.startsWith("p") || mark.includes("tarde") || mark.includes("noche")) && h < 12)
      h += 12
    out.push(h * 60)
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(am|pm|a\.\s?m\.|p\.\s?m\.)/g)) {
    let h = Number(m[1])
    if (m[2]?.startsWith("p") && h < 12) h += 12
    out.push(h * 60)
  }
  return out
}

const limaMinutes = (ms: number) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LIMA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms))
  return minutesOf(parts)
}

interface Grave {
  rule: string
  text: string
}

function graveRules(
  c: CaseDef,
  w: World,
  sent: Sent[],
  personText: string,
  allowed: { amounts: Array<{ value: number }>; percents: number[] },
  knownTimes: number[],
  gateClosed: boolean,
): { graves: Grave[]; suspicions: Grave[] } {
  const graves: Grave[] = []
  const suspicions: Grave[] = []
  const personPlain = plain(personText)
  const personPercents = [
    ...personPlain.matchAll(/(\d+(?:[.,]\d+)?)\s?%|(\d+)\s?por ?ciento/g),
  ].map((m) => Number((m[1] ?? m[2] ?? "").replace(",", ".")))
  const personTimes = timesIn(personText)
  if (gateClosed && sent.length > 0)
    graves.push({ rule: "respondió a una conversación que no le toca", text: sent[0]?.text ?? "" })
  for (const s of sent) {
    if (s.text === KAIROS_SELL_FALLBACK || s.text.endsWith(KAIROS_SELL_FALLBACK)) continue
    const bare = s.text.replace(/https?:\/\/\S+/g, " ")
    const low = plain(bare)
    for (const m of bare.matchAll(MONEY)) {
      const raw = m[1] ?? m[2] ?? ""
      if (!readings(raw).some((v) => allowed.amounts.some((a) => Math.abs(a.value - v) < 0.0005)))
        graves.push({
          rule: "importe que no es el precio de un plan",
          text: `${m[0].trim()} — «${s.text}»`,
        })
    }
    for (const m of low.matchAll(/(\d+(?:[.,]\d+)?)\s?%|(\d+)\s?por ?ciento/g)) {
      const v = Number((m[1] ?? m[2] ?? "").replace(",", "."))
      if (allowed.percents.includes(v)) continue
      ;(personPercents.includes(v) ? suspicions : graves).push({
        rule: "porcentaje que no es el de la web",
        text: `${m[0]} — «${s.text}»`,
      })
    }
    const offer = OFFER.exec(low)
    if (offer && !NEGATION.test(low.slice(0, offer.index)))
      graves.push({ rule: "ofrece un descuento o algo gratis", text: `${offer[0]} — «${s.text}»` })
    for (const re of [FREE, DISCOUNT_WORD]) {
      const m = re.exec(low)
      if (!m || offer) continue
      if (NEGATION.test(low.slice(0, m.index))) continue
      ;(re === FREE ? graves : suspicions).push({
        rule: re === FREE ? "promete algo gratis" : "nombra un descuento",
        text: `${m[0]} — «${s.text}»`,
      })
    }
    for (const minutes of timesIn(bare)) {
      if (knownTimes.includes(minutes)) continue
      ;(personTimes.includes(minutes) ? suspicions : graves).push({
        rule: personTimes.includes(minutes)
          ? "repite una hora que pidió la persona y no se ofreció"
          : "hora que no se ofreció",
        text: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} — «${s.text}»`,
      })
    }
    if (
      c.espera.paciente &&
      s.kind === "respondio" &&
      /presentaci|precio|plan|usd|agend|demo/.test(low)
    )
      graves.push({ rule: "trató a un paciente como una venta", text: s.text })
  }
  for (const b of w.bookings)
    for (const p of b.problems)
      graves.push({
        rule: `agendó mal: ${p}`,
        text: `${presentationWhenWords(new Date(b.start))} con ${staffName(w, b.persona)}`,
      })
  if (c.espera.paciente && w.bookings.length)
    graves.push({ rule: "agendó a un paciente", text: "" })
  if (c.espera.agenda === "no" && w.bookings.some((b) => b.kind === "agendada"))
    graves.push({
      rule: "agendó sin que la persona eligiera esa hora",
      text: presentationWhenWords(new Date(w.bookings[0]?.start ?? 0)),
    })
  return { graves, suspicions }
}

/* ---------- Lo esperado (no cumplido, sin ser grave) ---------- */

function misses(c: CaseDef, w: World, sent: Sent[], gateClosed: boolean): string[] {
  const e = c.espera
  const out: string[] = []
  const kinds = sent.map((s) => s.kind)
  const fellBack = kinds.includes("fallo")
  const excused = (what: string) => (fellBack && e.fallbackPermitido ? null : what)
  const push = (what: string | null) => what && out.push(what)
  const replies = sent.map((s) => plain(s.text)).join("\n")
  if (e.sinRespuesta && !gateClosed) push("debía no responder")
  if (e.agenda === "si" && !w.bookings.length) push(excused("no agendó"))
  if (e.pasa && !kinds.includes("paso")) push(excused("no lo pasó al equipo"))
  if (e.paciente && !kinds.includes("paciente")) push(excused("no lo trató como paciente"))
  if (e.pideContacto && !w.contactAsked && !/whatsapp|correo/.test(replies))
    push(excused("no pidió su WhatsApp o su correo"))
  if (e.mueve && !w.bookings.some((b) => b.kind === "movida"))
    push(excused("no movió la presentación"))
  if (e.cancela && !w.cancelled) push(excused("no canceló"))
  if (
    e.clienteCreado &&
    !(w.createdClient && plain(w.createdClient).includes(plain(e.clienteCreado)))
  )
    push(excused(`no registró «${e.clienteCreado}»`))
  if (e.parecido && w.similarReported.length === 0) push(excused("no avisó del cliente parecido"))
  if (e.presentaCon && w.presentation?.persona !== e.presentaCon)
    push(excused(`no presenta ${e.presentaCon}`))
  if (e.responsable && w.client?.owner !== e.responsable)
    push(`el responsable pasó a ${w.client?.owner ?? "nadie"}`)
  for (const want of e.menciona ?? [])
    if (!new RegExp(want).test(replies)) push(excused(`no dijo /${want}/`))
  if (!e.fallbackPermitido && fellBack) out.push("cayó en el aviso fijo")
  return out
}

/* ---------- El juez (solo tono, claridad y si responde lo que preguntó) ---------- */

const judgeModel = withJudge
  ? new ChatOpenAI({
      model: "gpt-6-luna",
      apiKey: platform.openai?.apiKey,
      useResponsesApi: true,
      timeout: 120_000,
      maxRetries: 2,
      modelKwargs: { reasoning: { effort: "medium" } },
      ...(platform.openai?.baseUrl ? { configuration: { baseURL: platform.openai.baseUrl } } : {}),
    })
  : null

interface Verdict {
  tono: number
  claridad: number
  responde: number
  comentario: string
}

const judgeTotals = { input: 0, cached: 0, output: 0, micros: 0, noCost: 0, calls: 0 }

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("")
  return ""
}

async function judge(c: CaseDef, transcript: string): Promise<Verdict | null> {
  if (!judgeModel) return null
  const prompt = `Eres un auditor exigente de cómo escribe Kairós, el asistente comercial de Sallca (hace odentIA, latidIA y vistIA, software para clínicas dentales, consultorios médicos y ópticas). Kairós responde por WhatsApp, Instagram o Messenger a quien todavía no usa su app: cuenta qué es, da los precios vigentes y agenda una presentación de 45 minutos. Español de Perú, de tú, cálido, claro, de 1 a 4 frases, sin emojis.

Califica de 1 a 5, sin indulgencia (3 = aceptable con fallas, 5 = como el mejor vendedor humano):
- tono: cálido, profesional, natural, de tú; sin sonar a robot ni a vendedor insistente.
- claridad: corto, fácil de entender, con un paso siguiente claro.
- responde: contesta lo que la persona preguntó o pidió en cada mensaje (si no puede, lo dice y ofrece qué sigue).
No juzgues si los precios, las horas o las reglas son correctos: eso lo revisan reglas fijas. Los avisos fijos («Gracias por escribir. Alguien del equipo te responde pronto.», «Eso lo ve alguien del equipo…», el de pacientes) y la confirmación de lo agendado los escribe el sistema: júzgalos solo por si eran oportunos.
Lo que se esperaba en esta conversación (de quien escribió el caso): ${c.nota ?? JSON.stringify(c.espera)}

Conversación:
${transcript}

Devuelve solo un JSON: {"tono": n, "claridad": n, "responde": n, "comentario": "una línea"}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await judgeModel.invoke(prompt)
      const meta = (reply.usage_metadata ?? {}) as {
        input_tokens?: number
        output_tokens?: number
        input_token_details?: { cache_read?: number }
      }
      judgeTotals.calls += 1
      judgeTotals.input += meta.input_tokens ?? 0
      judgeTotals.cached += meta.input_token_details?.cache_read ?? 0
      judgeTotals.output += meta.output_tokens ?? 0
      const cost = costMicrosOf({
        model: "gpt-6-luna",
        inputTokens: meta.input_tokens ?? null,
        cachedInputTokens: meta.input_token_details?.cache_read ?? null,
        outputTokens: meta.output_tokens ?? null,
      })
      if (cost === null) judgeTotals.noCost += 1
      else judgeTotals.micros += cost
      const json = /\{[\s\S]*\}/.exec(contentText(reply.content))?.[0]
      if (!json) continue
      const parsed = JSON.parse(json) as Verdict
      if (
        [parsed.tono, parsed.claridad, parsed.responde].every(
          (n) => typeof n === "number" && n >= 1 && n <= 5,
        )
      )
        return parsed
    } catch (error) {
      console.error(
        `  juez de ${c.id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      )
    }
  }
  return null
}

/* ---------- La corrida ---------- */

const sellerTotals = { input: 0, cached: 0, output: 0, micros: 0, noCost: 0, calls: 0 }
const seller = createKairosSeller({
  platform,
  onUse: (u) => {
    sellerTotals.calls += 1
    sellerTotals.input += u.inputTokens
    sellerTotals.cached += u.cachedTokens
    sellerTotals.output += u.outputTokens
    if (u.costMicros === null) sellerTotals.noCost += 1
    else sellerTotals.micros += u.costMicros
  },
})

const at = (iso: string) => new Date(iso).getTime()

function worldOf(c: CaseDef): World {
  const product = c.cliente?.producto ? PRODUCT_KEY[c.cliente.producto] : "dental"
  return {
    now: new Date(c.ahora ?? bank.ahora),
    channel: c.canal,
    staff: bank.equipo,
    busy: [...bank.ocupadas, ...(c.ocupadas ?? [])].map((b) => ({
      persona: b.persona,
      start: at(b.inicio),
      end: at(b.inicio) + PRESENTATION_MS,
    })),
    absences: (c.ausencias ?? []).map((a) => ({
      persona: a.persona,
      start: at(a.desde),
      end: at(a.hasta),
    })),
    client: c.cliente
      ? {
          name: c.cliente.nombre,
          product,
          owner: c.cliente.responsable ?? null,
          hasApp: Boolean(c.cliente.conApp),
        }
      : null,
    contact: c.contacto
      ? {
          name: c.contacto.nombre,
          phone: c.contacto.whatsapp ? "+51900000001" : null,
          email: c.contacto.correo ? "contacto@example.com" : null,
        }
      : null,
    paused: Boolean(c.pausado),
    notClinic: Boolean(c.noEsClinica),
    presentation: c.presentacion
      ? { persona: c.presentacion.persona, start: at(c.presentacion.inicio) }
      : null,
    proposal: c.propuesta
      ? {
          id: "propuesta-0",
          persona: c.propuesta.persona,
          start: at(c.propuesta.inicio),
          expires: at(c.ahora ?? bank.ahora) + KAIROS_PROPOSAL_HOURS * 3_600_000,
        }
      : null,
    similarExisting: c.parecidos ?? [],
    offered: c.propuesta ? [{ start: at(c.propuesta.inicio), persona: c.propuesta.persona }] : [],
    bookings: [],
    cancelled: false,
    createdClient: null,
    similarReported: [],
    contactAsked: false,
    turnsAtFirstBooking: null,
    seq: 0,
  }
}

/** Como `kairosHandlesChat` (sin el interruptor general, que la medición da por prendido). */
const gateClosed = (w: World) => w.paused || w.notClinic || Boolean(w.client?.hasApp)

interface CaseResult {
  id: string
  lienzo: string | null
  repeticion: number
  turnos: number
  turnosCorridos: number
  avisos: number
  avisosPorque: string[]
  resultados: string[]
  graves: Grave[]
  sospechas: Grave[]
  noCumplio: string[]
  juez: Verdict | null
  conversacion: Array<{ quien: string; texto: string }>
  caracteresPorPaso: number[]
}

async function runCase(c: CaseDef, repetition: number): Promise<CaseResult> {
  const w = worldOf(c)
  const history: KairosSellLine[] = (c.previo ?? []).map((line) => ({
    who: line.quien,
    at: new Date(w.now.getTime() - line.haceMin * 60_000),
    text: line.texto,
  }))
  const raw: Array<{ text: string; at: Date }> = (c.previo ?? [])
    .filter((l) => l.quien === "persona")
    .map((l) => ({ text: l.texto, at: new Date(w.now.getTime() - l.haceMin * 60_000) }))
  const sent: Sent[] = []
  const transcript: Array<{ quien: string; texto: string }> = (c.previo ?? []).map((l) => ({
    quien: l.quien === "persona" ? "PERSONA" : l.quien === "kairos" ? "KAIRÓS" : "EQUIPO",
    texto: l.texto,
  }))
  const fallbackWhy: string[] = []
  const outcomes: string[] = []
  const promptChars: number[] = []
  let omitted = 0
  let ran = 0
  let closedGate = false
  const knownTimes = new Set<number>()
  for (const [index, turn] of c.turnos.entries()) {
    if (index > 0) w.now = new Date(w.now.getTime() + (turn.minutos ?? 2) * 60_000)
    if (turn.antes?.ocuparPropuesta && w.proposal)
      // Otra clínica se ganó esa hora un momento antes (caso 3).
      w.busy.push({
        persona: w.proposal.persona,
        start: w.proposal.start,
        end: w.proposal.start + PRESENTATION_MS,
      })
    const allowed = kairosAllowedEmailText(turn.texto, { adminOnly: true })
    omitted += allowed.omitted
    const files = turn.archivos ?? 0
    const text =
      [
        allowed.lines.join(" "),
        files > 0
          ? `(mandó ${files === 1 ? "un archivo" : `${files} archivos`} que no puedes ver)`
          : "",
      ]
        .filter(Boolean)
        .join(" ") || "(un mensaje sin texto)"
    history.push({ who: "persona", at: new Date(w.now), text })
    raw.push({ text: turn.texto, at: new Date(w.now) })
    transcript.push({
      quien: "PERSONA",
      texto: turn.texto || `(${files} archivo${files === 1 ? "" : "s"}, sin texto)`,
    })
    if (gateClosed(w)) {
      closedGate = true
      outcomes.push("sin respuesta")
      continue
    }
    if (w.proposal && w.proposal.expires <= w.now.getTime()) w.proposal = null
    let leftContact: { phone: string | null; email: string | null } = { phone: null, email: null }
    for (const message of [...raw].reverse()) {
      const found = contactIn(message.text)
      if (found.phone || found.email) {
        leftContact = found
        break
      }
    }
    const sales = kairosSalesFactsOf(
      w.client?.product ?? "dental",
      bank.precios[productOfKey(w.client?.product ?? "dental")],
    )
    const input: KairosSellInput = {
      channel: w.channel,
      now: new Date(w.now),
      firstReply: !history.some((line) => line.who === "kairos"),
      product: sales,
      client: w.client ? { name: w.client.name } : null,
      contact: w.contact
        ? {
            name: w.contact.name,
            hasPhone: Boolean(w.contact.phone),
            hasEmail: Boolean(w.contact.email),
          }
        : null,
      displayName: c.perfil ?? null,
      history: [...history],
      omitted,
      leftContact,
      proposal: w.proposal
        ? {
            id: w.proposal.id,
            startsAt: new Date(w.proposal.start),
            assigneeName: staffName(w, w.proposal.persona),
          }
        : null,
      presentation: w.presentation
        ? {
            startsAt: new Date(w.presentation.start),
            assigneeName: staffName(w, w.presentation.persona),
            meetingUrl: staffRoom(w, w.presentation.persona),
          }
        : null,
    }
    promptChars.push(SELLER_SYSTEM.length + sellContext(input).length)
    for (const known of [w.proposal?.start, w.presentation?.start])
      if (known) knownTimes.add(limaMinutes(known))
    const calls: string[] = []
    const result = await seller.answer(input, toolsOf(w, calls))
    ran += 1
    for (const o of w.offered) knownTimes.add(limaMinutes(o.start))
    for (const known of [w.proposal?.start, w.presentation?.start])
      if (known) knownTimes.add(limaMinutes(known))
    outcomes.push(`${result.kind}${calls.length ? ` (${calls.join(", ")})` : ""}`)
    if (result.kind === "fallo") fallbackWhy.push(`t${index + 1}: ${result.why}`)
    sent.push({ turn: index, kind: result.kind, text: result.text })
    history.push({ who: "kairos", at: new Date(w.now.getTime() + 30_000), text: result.text })
    transcript.push({ quien: "KAIRÓS", texto: result.text })
    // Pasar al equipo, paciente o falla pausan la conversación: lo que siga escribiendo lo ve el equipo.
    if (result.kind !== "respondio") {
      w.paused = true
      if (index < c.turnos.length - 1)
        outcomes.push(
          `(${c.turnos.length - index - 1} turno(s) sin correr: la conversación quedó con el equipo)`,
        )
      break
    }
    // El texto de la confirmación también cuenta como hora dada.
    if ((result.booked as KairosSellBooked | null)?.startsAt)
      knownTimes.add(limaMinutes((result.booked as KairosSellBooked).startsAt.getTime()))
  }
  const personText = raw.map((r) => r.text).join("\n")
  const sales = kairosSalesFactsOf(
    w.client?.product ?? "dental",
    bank.precios[productOfKey(w.client?.product ?? "dental")],
  )
  // Los importes de los tres productos valen: el modelo puede comparar, pero nunca inventar.
  const amounts = (Object.keys(bank.precios) as Product[]).flatMap(
    (p) => kairosSalesFactsOf(PRODUCT_KEY[p], bank.precios[p]).amounts,
  )
  const { graves, suspicions } = graveRules(
    c,
    w,
    sent,
    personText,
    { amounts: [...amounts, ...sales.amounts], percents: sales.percents },
    [...knownTimes],
    closedGate && c.espera.sinRespuesta === true,
  )
  const missed = misses(c, w, sent, closedGate)
  const replied = sent.some((s) => s.kind === "respondio")
  const verdict = replied
    ? await judge(c, transcript.map((l) => `${l.quien}: ${l.texto}`).join("\n"))
    : null
  return {
    id: c.id,
    lienzo: c.lienzo ?? null,
    repeticion: repetition,
    turnos: c.turnos.length,
    turnosCorridos: ran,
    avisos: sent.filter((s) => s.kind === "fallo").length,
    avisosPorque: fallbackWhy,
    resultados: outcomes,
    graves,
    sospechas: suspicions,
    noCumplio: missed,
    juez: verdict,
    conversacion: transcript,
    caracteresPorPaso: promptChars,
  }
}

function productOfKey(key: "dental" | "medical" | "optical"): Product {
  return key === "medical" ? "latidia" : key === "optical" ? "vistia" : "odentia"
}

const results: CaseResult[] = []
for (let rep = 1; rep <= repetitions; rep++) {
  for (const c of cases) {
    const result = await runCase(c, rep)
    results.push(result)
    const mark = result.graves.length ? "✗" : result.noCumplio.length || result.avisos ? "△" : "✓"
    const judged = result.juez
      ? ` · juez ${result.juez.tono}/${result.juez.claridad}/${result.juez.responde}`
      : ""
    console.log(
      `${mark} ${c.id}${repetitions > 1 ? ` #${rep}` : ""}: ${result.resultados.join(" → ")}${judged}`,
    )
    for (const g of result.graves) console.log(`    GRAVE ${g.rule}: ${g.text.slice(0, 240)}`)
    for (const s of result.sospechas) console.log(`    sospecha ${s.rule}: ${s.text.slice(0, 200)}`)
    if (result.noCumplio.length) console.log(`    no cumplió: ${result.noCumplio.join("; ")}`)
    for (const why of result.avisosPorque) console.log(`    aviso fijo ${why}`)
  }
}

/* ---------- El resumen ---------- */

const turnsRun = results.reduce((sum, r) => sum + r.turnosCorridos, 0)
const fallbacks = results.reduce((sum, r) => sum + r.avisos, 0)
const graveCases = results.filter((r) => r.graves.length)
const judged = results.filter((r) => r.juez)
const avg = (pick: (v: Verdict) => number) =>
  judged.length ? judged.reduce((sum, r) => sum + pick(r.juez as Verdict), 0) / judged.length : null
const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(2))
const fallbackRate = turnsRun ? fallbacks / turnsRun : 0
const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(4)}`
const chars = results.flatMap((r) => r.caracteresPorPaso)

console.log("")
if (fake)
  console.log(
    "MODELO FALSO (LLM_MODEL=fake): el doble por reglas, sin juez ni gasto. Esto NO cuenta como medición.",
  )
console.log(
  `Vendedor: ${seller.seller === "modelo" ? "gpt-6-luna (AGENT_MODEL)" : "plantilla (fakeSellerModel)"} · ${cases.length} casos × ${repetitions} = ${results.length} corridas, ${turnsRun} turnos con respuesta`,
)
console.log("")
console.log("| Medida | Valor |")
console.log("| --- | --- |")
console.log(
  `| Casos con GRAVE | ${graveCases.length} de ${results.length}${graveCases.length ? ` (${graveCases.map((r) => r.id + (repetitions > 1 ? `#${r.repeticion}` : "")).join(", ")})` : ""} |`,
)
console.log(`| GRAVES en total | ${results.reduce((sum, r) => sum + r.graves.length, 0)} |`)
console.log(
  `| Casos que no cumplieron lo esperado | ${results.filter((r) => r.noCumplio.length).length} |`,
)
console.log(
  `| Avisos fijos (fallbacks) | ${fallbacks} de ${turnsRun} turnos (${(100 * fallbackRate).toFixed(1)} %; meta < 10 %)${fallbackRate >= 0.1 ? " REPRUEBA" : ""} |`,
)
console.log(
  `| Juez (tono / claridad / responde) | ${withJudge ? `${fmt(avg((v) => v.tono))} / ${fmt(avg((v) => v.claridad))} / ${fmt(avg((v) => v.responde))} en ${judged.length} conversaciones` : "sin juez"} |`,
)
console.log(
  `| Gasto del vendedor | ${fake ? "—" : `${usd(sellerTotals.micros)} (${sellerTotals.calls} turnos medidos, ${sellerTotals.input} entrada, ${sellerTotals.cached} de caché, ${sellerTotals.output} salida${sellerTotals.noCost ? `, ${sellerTotals.noCost} sin costo informado` : ""})`} |`,
)
console.log(
  `| Gasto del juez | ${withJudge ? `${usd(judgeTotals.micros)} (${judgeTotals.calls} llamadas, ${judgeTotals.input} entrada, ${judgeTotals.output} salida${judgeTotals.noCost ? `, ${judgeTotals.noCost} sin costo` : ""})` : "—"} |`,
)
console.log(
  `| Prompt por paso (instrucciones + contexto) | ${chars.length ? `${Math.round(chars.reduce((a, b) => a + b, 0) / chars.length)} caracteres de media, unos ${Math.round(chars.reduce((a, b) => a + b, 0) / chars.length / 3.6)} tokens` : "—"} |`,
)
if (graveCases.length) {
  console.log("")
  console.log("GRAVES:")
  for (const r of graveCases)
    for (const g of r.graves)
      console.log(
        `- ${r.id}${repetitions > 1 ? ` #${r.repeticion}` : ""}: ${g.rule} — ${g.text.slice(0, 300)}`,
      )
}

const day = limaDate(new Date())
const out = arg(
  "salida",
  fake
    ? join(tmpdir(), `kairos-vende-${day}-fake.json`)
    : resolve("eval/kairos-vende-mediciones", `${day}.json`),
)
mkdirSync(resolve(out, ".."), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify(
    {
      fecha: new Date().toISOString(),
      vendedor: seller.seller,
      cuenta: !fake,
      banco: bankPath,
      repeticiones: repetitions,
      resumen: {
        corridas: results.length,
        turnos: turnsRun,
        casosConGrave: graveCases.map((r) => `${r.id}#${r.repeticion}`),
        graves: results.reduce((sum, r) => sum + r.graves.length, 0),
        avisos: fallbacks,
        tasaAvisos: fallbackRate,
        juez: withJudge
          ? {
              tono: avg((v) => v.tono),
              claridad: avg((v) => v.claridad),
              responde: avg((v) => v.responde),
              conversaciones: judged.length,
            }
          : null,
        gasto: {
          vendedor: fake ? null : { ...sellerTotals },
          juez: withJudge ? { ...judgeTotals } : null,
          totalMicros: fake ? null : sellerTotals.micros + judgeTotals.micros,
        },
      },
      casos: results,
    },
    null,
    1,
  )}\n`,
)
console.log("")
console.log(`Resultado: ${out}`)
