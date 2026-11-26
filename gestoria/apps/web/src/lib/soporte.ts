import type { MySupportState, SupportAccess } from "./api"

/**
 * Las palabras de soporte de gestorIA mirando una tienda (ADR 0214 y 0219), las mismas en la
 * franja, la caja de la tienda, Equipo y «El acceso terminó»: las horas siempre «3:10 p. m.» y sin
 * «venció» ni «No lo dejaste».
 */

const HOUR = new Intl.DateTimeFormat("es-PE", { hour: "numeric", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short" })

/** «3:10 p. m.» */
export function hourOf(iso: string | Date): string {
  return HOUR.format(new Date(iso))
}

/** «25 nov» (sin el punto de la abreviatura, que corta la frase). */
export function dayOf(iso: string | Date): string {
  return DAY.format(new Date(iso)).replace(/\.$/, "")
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** «las 3:10 p. m.» o «la 1:10 p. m.»: la una es singular. */
function articleHour(iso: string | Date): string {
  const hour = hourOf(iso)
  return `${hour.startsWith("1:") ? "la" : "las"} ${hour}`
}

/** Hoy, «las 3:10 p. m.»; otro día, «el 26 nov a las 3:10 p. m.». */
export function atTime(iso: string | Date, now = new Date()): string {
  return sameDay(new Date(iso), now) ? articleHour(iso) : `el ${dayOf(iso)} a ${articleHour(iso)}`
}

/** Cierra la frase con su punto; «p. m.» ya lo trae. */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`
}

/** La franja de quien mira: qué tienda, hasta cuándo y que no cambia nada. */
export function stripMessage(storeName: string, until: string, now = new Date()): string {
  return `Solo mirar · Estás viendo ${storeName} como soporte de gestorIA, hasta ${sentence(atTime(until, now))} No puedes cambiar nada.`
}

/** Lo que pasó con la entrada, con su motivo y su hora, para «El acceso terminó». */
export function endedMessage(
  state: Extract<MySupportState, { state: "terminado" }>,
  now = new Date(),
): string {
  const when = sameDay(new Date(state.at), now)
    ? `A ${articleHour(state.at)}`
    : `El ${dayOf(state.at)} a ${articleHour(state.at)}`
  switch (state.reason) {
    case "tiempo":
      return `${when}: se terminó el tiempo.`
    case "salio":
      return `${when}: saliste.`
    case "quitado":
      return `${when}: ${state.byName ?? "alguien de la tienda"} terminó tu acceso.`
    case "rechazado":
      return `${when}: la tienda dijo que no.`
    case "sin_respuesta":
      return `${when}: la tienda no respondió a tiempo.`
  }
}

/**
 * Una entrada de soporte como la ve la tienda: la línea principal y, debajo, lo que la explica
 * (para qué y quién la aceptó). `meId` dice «tú» a quien la respondió o la sacó.
 */
export function supportLine(
  row: SupportAccess,
  meId: string,
  now = new Date(),
): { title: string; detail: string | null } {
  const who = row.staffName
  const answered =
    row.answeredBy && row.status !== "por_aceptar" && row.status !== "rechazado"
      ? row.answeredBy === meId
        ? "Lo aceptaste tú."
        : row.answeredByName
          ? `Lo aceptó ${row.answeredByName}.`
          : null
      : null
  const detail = [row.reason ? sentence(`Para: ${row.reason}`) : null, answered]
    .filter(Boolean)
    .join(" ")
  const line = (title: string) => ({ title, detail: detail || null })
  if (row.status === "por_aceptar")
    return line(`${who} pide mirar tu tienda ${row.minutes} minutos`)
  if (row.status === "vigente" && row.expiresAt)
    return line(
      row.usedAt
        ? `${who} está mirando tu tienda desde ${atTime(row.usedAt, now)}, hasta ${atTime(row.expiresAt, now)}`
        : `${who} puede mirar tu tienda hasta ${atTime(row.expiresAt, now)} · todavía no entró`,
    )
  const ending = row.ending
  const asked = row.requestedAt ? ` el ${dayOf(row.requestedAt)}` : ""
  if (!ending) return line(who)
  if (ending.reason === "rechazado")
    return line(
      `${who} pidió mirar tu tienda${asked} · ${
        ending.by === meId
          ? "dijiste que no"
          : `${ending.byName ?? "alguien de tu equipo"} dijo que no`
      }`,
    )
  if (ending.reason === "sin_respuesta")
    return line(`${who} pidió mirar tu tienda${asked} · nadie respondió a tiempo`)
  if (!row.usedAt)
    return line(
      `${who} podía mirar tu tienda hasta el ${dayOf(ending.at)} a ${articleHour(ending.at)} · no entró`,
    )
  const end =
    ending.reason === "tiempo"
      ? `se terminó el tiempo a ${articleHour(ending.at)}`
      : ending.reason === "salio"
        ? `salió a ${articleHour(ending.at)}`
        : ending.by === meId
          ? `terminaste el acceso a ${articleHour(ending.at)}`
          : `${ending.byName ?? "alguien de tu equipo"} terminó el acceso a ${articleHour(ending.at)}`
  return line(`${who} miró tu tienda el ${dayOf(row.usedAt)} a ${articleHour(row.usedAt)} · ${end}`)
}
