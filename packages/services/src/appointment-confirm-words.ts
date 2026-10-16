/**
 * Lo que se le contesta a quien confirma citas, con el botón «Confirmar» o
 * escribiéndolo. Un padre que confirma confirma las citas de quienes lleva, y
 * la respuesta dice de quiénes son: «¡Listo! Confirmé las citas de Sofía y
 * Pedro. Te esperamos.». Una sola regla para el botón y para el agente.
 */

export interface ConfirmedItem {
  /** Nombre del paciente de la cita. */
  patientName: string
  /** La cita es de la propia persona que confirma. */
  self: boolean
  /** Se confirmó ahora o ya estaba confirmada. */
  was: "confirmada" | "ya_confirmada"
  /** Cuándo es: los nombres se dicen en el orden de las citas. */
  startsAt?: Date | string
}

/** El nombre de pila: así se le habla a la familia. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

/** «tu cita y las de Sofía y Pedro», «la cita de Sofía», «tus citas». */
function whose(items: ConfirmedItem[]): string {
  const own = items.filter((item) => item.self).length
  const others = [...new Set(items.filter((item) => !item.self).map((item) => firstName(item.patientName)))]
  const othersCount = items.length - own
  if (others.length === 0) return own > 1 ? "tus citas" : "tu cita"
  const theirs = `${othersCount > 1 ? "las" : "la"}`
  if (own === 0) return `${theirs} ${othersCount > 1 ? "citas" : "cita"} de ${joinNames(others)}`
  return `${own > 1 ? "tus citas" : "tu cita"} y ${theirs} de ${joinNames(others)}`
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function confirmationReply(unsorted: ConfirmedItem[]): string {
  const time = (item: ConfirmedItem) => (item.startsAt ? new Date(item.startsAt).getTime() : 0)
  const items = [...unsorted].sort((a, b) => time(a) - time(b))
  const confirmed = items.filter((item) => item.was === "confirmada")
  const already = items.filter((item) => item.was === "ya_confirmada")
  // Solo citas propias: el texto de siempre.
  if (items.every((item) => item.self)) {
    if (confirmed.length === 0)
      return already.length > 1 ? "Tus citas ya estaban confirmadas. ¡Te esperamos!" : "Tu cita ya estaba confirmada. ¡Te esperamos!"
    return items.length > 1 ? "¡Listo! Tus citas quedaron confirmadas. Te esperamos." : "¡Listo! Tu cita quedó confirmada. Te esperamos."
  }
  if (confirmed.length === 0) {
    const plural = already.length > 1
    return `${capitalized(whose(already))} ya ${plural ? "estaban confirmadas" : "estaba confirmada"}. ¡Te esperamos!`
  }
  const done = `¡Listo! Confirmé ${whose(confirmed)}.`
  if (already.length === 0) return `${done} Te esperamos.`
  return `${done} ${capitalized(whose(already))} ya ${already.length > 1 ? "estaban confirmadas" : "estaba confirmada"}. Te esperamos.`
}
