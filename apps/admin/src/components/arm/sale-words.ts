/**
 * Cómo se dice la venta del ARM en la administración: las palabras de cada
 * código que entrega el servidor (`admin-clients.ts`, `admin-sales.ts`) y las
 * fechas de Lima. Los códigos son los de `packages/db/src/schema/admin-arm.ts`;
 * la administración no depende de la base, así que se repiten aquí con sus
 * palabras, las mismas del servidor (`CLIENT_STAGE_WORDS`, `LOST_REASON_WORDS`,
 * `CLIENT_ORIGIN_WORDS`). Si cambia uno, cambia el otro.
 */
import { CLIENT_STAGE_NAMES, type ClientStageName } from "../../lib/list-search"
import { supportDay, supportTime } from "../../lib/support-words"

/** Las etapas son las de la dirección de Clientes (`CLIENT_STAGE_NAMES`), una sola lista. */
export const CLIENT_STAGES = CLIENT_STAGE_NAMES
export type ClientStage = ClientStageName

export const STAGE_WORDS: Record<ClientStage, string> = {
  contacto: "Contacto",
  presentacion_agendada: "Presentación agendada",
  presentacion_hecha: "Presentación hecha",
  propuesta: "Propuesta",
  entro: "Entró",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

/** El hecho que pone a la venta en su etapa (lienzo del Embudo, «Por qué una tarjeta cambia de columna»). */
export const STAGE_FACT: Record<ClientStage, string> = {
  contacto: "La venta está abierta y todavía no hay nada más.",
  presentacion_agendada: "Hay una presentación por venir.",
  presentacion_hecha: "Se anotó que la presentación se hizo.",
  propuesta: "Se envió una propuesta vigente o tiene una invitación.",
  entro: "La clínica creó su cuenta.",
  no_por_ahora: "Se decidió «No por ahora».",
  perdido: "Se decidió que se perdió.",
}

export const CLIENT_ORIGINS = [
  "web",
  "referido",
  "evento",
  "whatsapp",
  "redes",
  "busqueda",
  "otro",
] as const
export type ClientOrigin = (typeof CLIENT_ORIGINS)[number]
export const ORIGIN_WORDS: Record<ClientOrigin, string> = {
  web: "Web",
  referido: "Referido",
  evento: "Evento",
  whatsapp: "WhatsApp directo",
  redes: "Redes o anuncio",
  busqueda: "Salimos a buscarla",
  otro: "Otro",
}

export const LOST_REASONS = [
  "precio",
  "sigue_con_lo_que_usa",
  "no_es_el_momento",
  "no_respondio",
  "le_falta_una_funcion",
  "no_es_una_clinica",
  "otro",
] as const
export type LostReason = (typeof LOST_REASONS)[number]
export const LOST_REASON_WORDS: Record<LostReason, string> = {
  precio: "Precio",
  sigue_con_lo_que_usa: "Sigue con lo que usa",
  no_es_el_momento: "No es el momento",
  no_respondio: "No respondió",
  le_falta_una_funcion: "Le falta una función",
  no_es_una_clinica: "No es una clínica",
  otro: "Otro",
}

export const ACTIVITY_KINDS = [
  "llamada",
  "whatsapp",
  "correo",
  "reunion",
  "presentacion",
  "propuesta",
  "nota",
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_WORDS: Record<ActivityKind, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  correo: "Correo",
  reunion: "Reunión",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  nota: "Nota",
}

export const ACTIVITY_DIRECTIONS = ["salio", "entro"] as const
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number]
export const DIRECTION_WORDS: Record<ActivityDirection, string> = {
  salio: "La buscamos nosotros",
  entro: "Nos buscó la clínica",
}

export const TASK_KINDS = [
  "llamar",
  "escribir",
  "presentacion",
  "propuesta",
  "alta",
  "cobro",
  "otro",
] as const
export type TaskKind = (typeof TASK_KINDS)[number]
export const TASK_WORDS: Record<TaskKind, string> = {
  llamar: "Llamar",
  escribir: "Escribir",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  alta: "Alta",
  cobro: "Cobro",
  otro: "Otra cosa",
}
/** Soporte no ve ni pone tareas de cobro (lo dice el servidor): no se le ofrecen. */
export const SUPPORT_TASK_KINDS: readonly TaskKind[] = TASK_KINDS.filter((kind) => kind !== "cobro")

export const CONTACT_ROLES = ["decide", "usa", "paga"] as const
export type ContactRole = (typeof CONTACT_ROLES)[number]
export const ROLE_WORDS: Record<ContactRole, string> = {
  decide: "Decide",
  usa: "La usa",
  paga: "Paga",
}

export const CLIENT_PROFESSIONALS = ["1", "2-3", "4-9", "10+"] as const
export const PROFESSIONALS_WORDS: Record<(typeof CLIENT_PROFESSIONALS)[number], string> = {
  "1": "1",
  "2-3": "2 a 3",
  "4-9": "4 a 9",
  "10+": "10 o más",
}
export const CLIENT_TOOLS = ["nada", "cuaderno_excel", "otro_software"] as const
export const TOOL_WORDS: Record<(typeof CLIENT_TOOLS)[number], string> = {
  nada: "Nada",
  cuaderno_excel: "Cuaderno o Excel",
  otro_software: "Otro programa",
}

export const PROPOSAL_STATUSES = [
  "borrador",
  "por_aprobar",
  "enviada",
  "aceptada",
  "no_aceptada",
  "vencida",
  "reemplazada",
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export const PROPOSAL_STATUS_WORDS: Record<ProposalStatus, string> = {
  borrador: "Borrador",
  por_aprobar: "Pide aprobación",
  enviada: "Enviada",
  aceptada: "Aceptada",
  no_aceptada: "No aceptada",
  vencida: "Vencida",
  reemplazada: "Reemplazada",
}

/** El estado en palabras; una reemplazada dice por cuál: «Reemplazada por la v3». */
export function proposalStatusWords(proposal: {
  displayStatus: ProposalStatus
  replacedBy?: number | null
}): string {
  if (proposal.displayStatus === "reemplazada" && proposal.replacedBy != null)
    return `Reemplazada por la v${proposal.replacedBy}`
  return PROPOSAL_STATUS_WORDS[proposal.displayStatus]
}
export const BILLING_CYCLES = ["mensual", "quincenal"] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]
export const CYCLE_WORDS: Record<BillingCycle, string> = {
  mensual: "Cada mes",
  quincenal: "Cada quince días",
}

/** Las etapas de la invitación, las de la lista de espera (`waitlistStage`). */
export const WAITLIST_STAGE_WORDS: Record<string, string> = {
  por_revisar: "Por revisar",
  invitada: "Invitada",
  invitacion_vencida: "Invitación vencida",
  entro: "Entró",
  paga: "Paga",
  descartada: "Descartada",
}

/* ---------- Fechas de Lima ---------- */

const LIMA = "America/Lima"
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: LIMA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const timeKeyFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: LIMA,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** El día de Lima de un instante, `YYYY-MM-DD`: el «hoy» de la administración. */
export const limaDay = (date: Date = new Date()): string => dayKeyFormat.format(date)
/** La hora de Lima de un instante, `HH:MM`. */
export const limaTime = (iso: string): string => timeKeyFormat.format(new Date(iso))

/** Un día de Lima más `days` días, `YYYY-MM-DD` (a mediodía UTC: ningún cambio de hora lo corre). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * El instante de un día y una hora de Lima. Lima no cambia de hora (UTC−5 desde
 * 1994), así que el desfase es fijo; el servidor vuelve a comprobar que la hora
 * sea de ese mismo día de Lima.
 */
export function limaInstant(day: string, time: string): string {
  return new Date(`${day}T${time}:00-05:00`).toISOString()
}

/** «jue 12 nov» de un día de Lima. */
export const dayWords = (day: string): string => supportDay(`${day}T17:00:00Z`)

/** «hoy», «mañana», «ayer» o «jue 12 nov», con la hora si la hay: «hoy, 10:00». */
export function dueWords(dueOn: string, dueAt: string | null, today: string = limaDay()): string {
  const day =
    dueOn === today
      ? "hoy"
      : dueOn === addDays(today, 1)
        ? "mañana"
        : dueOn === addDays(today, -1)
          ? "ayer"
          : dayWords(dueOn)
  return dueAt ? `${day}, ${supportTime(dueAt)}` : day
}

/** «1 día», «5 días». */
export const daysWords = (days: number): string =>
  days === 0 ? "hoy" : `${days} ${days === 1 ? "día" : "días"}`

/** Lo que dice un porcentaje en puntos básicos: 1250 → «12,5 %». */
export const percentWords = (bps: number): string =>
  `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(bps / 100)} %`
