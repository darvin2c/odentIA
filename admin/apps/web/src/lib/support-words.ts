/**
 * Cómo se dicen la espera de un caso de soporte y sus fechas: una sola forma
 * para la cola y para Inicio, así el primer caso dice lo mismo en los dos.
 * Las horas se leen en Lima, como el resto de la administración, en 24 h.
 */

const LIMA = "America/Lima"

const dayFormat = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA, weekday: "short", day: "numeric", month: "short" })
const timeFormat = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: LIMA, year: "numeric", month: "2-digit", day: "2-digit" })

const clean = (text: string) => text.replaceAll(".", "").replace(",", "")

/** «mié 11 nov». */
export const supportDay = (iso: string): string => clean(dayFormat.format(new Date(iso)))
/** «15:30». */
export const supportTime = (iso: string): string => timeFormat.format(new Date(iso))
/** «mié 11 nov, 15:30». */
export const supportDayTime = (iso: string): string => `${supportDay(iso)}, ${supportTime(iso)}`

const dayKey = (date: Date): string => dayKeyFormat.format(date)

/** «hace 5 horas», «hace 2 días»: cuánto pasó desde `iso`. */
export function agoWords(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return "hace un momento"
  if (minutes < 60) return `hace ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} ${hours === 1 ? "hora" : "horas"}`
  const days = Math.floor(hours / 24)
  return `hace ${days} ${days === 1 ? "día" : "días"}`
}

/** Días enteros desde `iso`. */
export const daysSince = (iso: string, now: Date = new Date()): number =>
  Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)

/** «Responder hasta hoy, mié 11 nov» o «Responder hasta el vie 13 nov»; `urgent` si es hoy o ya pasó. */
export function answerByWords(iso: string, now: Date = new Date()): { text: string; urgent: boolean } {
  const due = dayKey(new Date(iso))
  const today = dayKey(now)
  if (due === today) return { text: `Responder hasta hoy, ${supportDay(iso)}`, urgent: true }
  return { text: `Responder hasta el ${supportDay(iso)}`, urgent: due < today }
}

/** «Acceso autorizado hasta las 15:30» (o hasta otro día, si no es hoy). */
export function accessUntilWords(iso: string, now: Date = new Date()): string {
  return dayKey(new Date(iso)) === dayKey(now)
    ? `Acceso autorizado hasta las ${supportTime(iso)}`
    : `Acceso autorizado hasta el ${supportDayTime(iso)}`
}

/**
 * Lo que nos espera, en una línea: «Espera desde hace 2 días · Responder hasta
 * hoy, mié 11 nov»; con un acceso vigente, «Acceso autorizado hasta las
 * 15:30». `urgent` (el rojo) solo para lo vencido o lo de hoy.
 */
export function supportWaitWords(
  row: { waitingSince: string; answerBy: string | null; accessUntil: string | null },
  now: Date = new Date(),
): { text: string; urgent: boolean } {
  if (row.accessUntil) return { text: accessUntilWords(row.accessUntil, now), urgent: false }
  const waiting = `Espera desde ${agoWords(row.waitingSince, now)}`
  if (!row.answerBy) return { text: waiting, urgent: false }
  const answer = answerByWords(row.answerBy, now)
  return { text: `${waiting} · ${answer.text}`, urgent: answer.urgent }
}

const END_WORDS: Record<string, string> = {
  quitado: "Lo quitaron",
  reemplazado: "Lo reemplazó otro acceso",
  vencido: "Venció",
  caso_resuelto: "Se cerró al resolver el caso",
  sin_quien_lo_dio: "Se cerró: quien lo dio ya no administra la clínica",
}

/**
 * El acceso de soporte, en palabras: qué mira («como Odontólogo» o «la
 * configuración») y su estado («vigente hasta las 15:30», «lo quitaron el…»).
 */
export function grantWords(
  grant: {
    expiresAt: string
    revokedAt: string | null
    active: boolean
    scope?: string
    viewRoleLabel?: string | null
    endReason?: string | null
    staffName?: string | null
  },
  now: Date = new Date(),
): string {
  const what = grant.scope === "rol" && grant.viewRoleLabel ? `Mirar como ${grant.viewRoleLabel}` : "La configuración"
  const whom = grant.staffName ? ` · para ${grant.staffName}` : ""
  if (grant.revokedAt)
    return `${what}${whom} · ${END_WORDS[grant.endReason ?? "quitado"] ?? "Terminó"} el ${supportDayTime(grant.revokedAt)}`
  if (grant.active)
    return dayKey(new Date(grant.expiresAt)) === dayKey(now)
      ? `${what}${whom} · vigente hasta las ${supportTime(grant.expiresAt)}`
      : `${what}${whom} · vigente hasta el ${supportDayTime(grant.expiresAt)}`
  return `${what}${whom} · venció el ${supportDayTime(grant.expiresAt)}`
}

/** El tipo de caso, como lo lee el equipo: «acceso» es entrar a su cuenta (el valor guardado no cambia). */
export const SUPPORT_KIND_LABEL = {
  pregunta: "Pregunta",
  problema: "Problema",
  acceso: "Entrar a su cuenta",
  cobro: "Cobro",
} as const
