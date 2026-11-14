/**
 * Lo que la persona va escribiendo en el registro, en su enlace o en «Antes de tu
 * cita», guardado en su propio celular (mesa del 13 nov, entrega 9, decisión 11):
 * si la interrumpen y vuelve, sigue donde iba. Dura hasta que lo envía o hasta 24
 * horas desde que empezó a escribir, lo que pase primero. Nunca va al servidor: ahí
 * lo vería cualquiera que tenga el enlace, que se abre sin código y se reenvía
 * (decisión 9). Desde otro celular, el recorrido empieza en blanco.
 *
 * Cuidados, porque son datos de salud en un teléfono que puede ser compartido
 * (auditor, segunda vuelta; lo legal queda pendiente):
 * - la clave es de esa clínica y de ese enlace (o de esa entrada pública): otro
 *   enlace en el mismo navegador no ve lo de otra persona. El token no se escribe tal
 *   cual en el almacenamiento, solo su huella;
 * - lo vencido se borra al leerlo y cada vez que se abre una de estas páginas;
 * - se guarda solo lo escrito del formulario (texto, opciones): nunca un archivo;
 * - sin almacenamiento (ventana privada, bloqueado, lleno) todo funciona igual y
 *   solo no se guarda: ninguna función de aquí lanza.
 */

/** Cuánto dura lo escrito en el celular: un día. */
export const DEVICE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

const PREFIX = "odentia.borrador."
/** Lo de antes de la entrega 9: el registro guardaba en la pestaña con esta clave. */
const LEGACY_SESSION_PREFIX = "registro:"

/** En qué paso iba: la pantalla (`item`) y «paso 3 de 6». */
export interface DeviceDraftStep {
  item: string
  current: number
  total: number
}

export interface DeviceDraft<T> {
  values: Partial<T>
  step: DeviceDraftStep | null
  /** Cuándo empezó a escribir (ms): de ahí se cuentan las 24 horas. */
  startedAt: number
  /** Hasta cuándo sigue en el celular (ms). */
  expiresAt: number
}

/**
 * La huella de un token (cyrb53, 53 bits en hexadecimal): basta para separar un
 * enlace de otro sin dejar el token escrito en el almacenamiento del celular.
 */
export function tokenPrint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * La clave del borrador: la clínica, qué recorrido (`registro`, `enlace`) y de quién
 * (el token del enlace, o la entrada pública sin token: `qr`, `public_link`). `extra`
 * separa lo que cambia dentro del mismo enlace (la cita para la que responde).
 */
export function deviceDraftKey(parts: {
  clinic: string
  flow: "registro" | "enlace"
  token?: string | null
  entry?: string | null
  extra?: string | null
}): string {
  const who = parts.token ? `t-${tokenPrint(parts.token)}` : `e-${parts.entry ?? "publico"}`
  return `${deviceDraftLinkPrefix(parts.clinic, parts.flow, who)}${parts.extra ? tokenPrint(parts.extra) : "-"}`
}

function deviceDraftLinkPrefix(clinic: string, flow: string, who: string): string {
  return `${PREFIX}${clinic}.${flow}.${who}.`
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Si este navegador deja guardar: la pantalla promete «se guarda en este celular»
 * solo si es verdad (en una ventana privada que lo bloquea, no lo dice).
 */
export function deviceDraftsWork(): boolean {
  const store = storage()
  if (!store) return false
  try {
    const probe = `${PREFIX}prueba`
    store.setItem(probe, "1")
    store.removeItem(probe)
    return true
  } catch {
    return false
  }
}

function remove(store: Storage, key: string): void {
  try {
    store.removeItem(key)
  } catch {
    // Nada que borrar.
  }
}

function parse<T>(text: string | null, now: number): DeviceDraft<T> | "vencido" | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<DeviceDraft<T>> | null
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.startedAt !== "number" ||
      typeof raw.expiresAt !== "number" ||
      !raw.values ||
      typeof raw.values !== "object" ||
      Array.isArray(raw.values)
    )
      return "vencido"
    // Más de un día desde que empezó, o un vencimiento que no cuadra (reloj cambiado): no se repone.
    if (now >= raw.expiresAt || raw.expiresAt - raw.startedAt > DEVICE_DRAFT_TTL_MS) return "vencido"
    const step = raw.step
    const okStep =
      step &&
      typeof step === "object" &&
      typeof step.item === "string" &&
      Number.isInteger(step.current) &&
      Number.isInteger(step.total) &&
      step.current >= 1 &&
      step.total >= step.current
    return { values: raw.values, step: okStep ? step : null, startedAt: raw.startedAt, expiresAt: raw.expiresAt }
  } catch {
    return "vencido"
  }
}

/** Lo guardado con esa clave, si sigue vigente. Lo vencido o dañado se borra aquí mismo. */
export function readDeviceDraft<T>(key: string, now = Date.now()): DeviceDraft<T> | null {
  const store = storage()
  if (!store) return null
  let text: string | null
  try {
    text = store.getItem(key)
  } catch {
    return null
  }
  const draft = parse<T>(text, now)
  if (draft === "vencido") {
    remove(store, key)
    return null
  }
  return draft
}

/**
 * Guarda lo escrito y el paso. Las 24 horas cuentan desde que empezó a escribir, no
 * desde la última tecla: lo de salud no se queda más de un día porque siga tocándolo.
 * Si ya venció con la página abierta, lo que siga escribiendo empieza otro día.
 */
export function writeDeviceDraft<T>(
  key: string,
  values: Partial<T>,
  step: DeviceDraftStep | null,
  now = Date.now(),
): void {
  const store = storage()
  if (!store) return
  const startedAt = readDeviceDraft<T>(key, now)?.startedAt ?? now
  const draft: DeviceDraft<T> = { values, step, startedAt, expiresAt: startedAt + DEVICE_DRAFT_TTL_MS }
  try {
    store.setItem(key, JSON.stringify(draft))
  } catch {
    // Sin espacio o sin permiso: se sigue sin guardar.
  }
}

/** La clave de «Antes de tu cita» (o «Tus datos») de un enlace: también de la cita para la que responde. */
export function personalLinkDraftKey(clinic: string, token: string, appointmentStartsAt: string | null): string {
  return deviceDraftKey({ clinic, flow: "enlace", token, extra: appointmentStartsAt ?? "sin-cita" })
}

export function clearDeviceDraft(key: string): void {
  const store = storage()
  if (store) remove(store, key)
}

/**
 * Borra todo lo de ese enlace en esta clínica (todas sus citas): el enlace ya no
 * sirve, o ya lo envió desde otra pestaña u otro celular.
 */
export function clearDeviceDraftsOfLink(clinic: string, token: string): void {
  const store = storage()
  if (!store) return
  const prefix = deviceDraftLinkPrefix(clinic, "enlace", `t-${tokenPrint(token)}`)
  for (const key of keysOf(store)) if (key.startsWith(prefix)) remove(store, key)
}

function keysOf(store: Storage): string[] {
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key !== null) keys.push(key)
    }
    return keys
  } catch {
    return []
  }
}

/**
 * Al abrir una de estas páginas: borra lo vencido de cualquier enlace o clínica
 * de este navegador, y lo que el registro dejaba en la pestaña antes de la entrega 9.
 */
export function sweepDeviceDrafts(now = Date.now()): void {
  const store = storage()
  if (store) {
    for (const key of keysOf(store)) {
      if (!key.startsWith(PREFIX)) continue
      let text: string | null = null
      try {
        text = store.getItem(key)
      } catch {
        continue
      }
      if (parse(text, now) === "vencido") remove(store, key)
    }
  }
  try {
    const session = typeof window === "undefined" ? null : window.sessionStorage
    if (session) for (const key of keysOf(session)) if (key.startsWith(LEGACY_SESSION_PREFIX)) remove(session, key)
  } catch {
    // Sin la pestaña no hay nada viejo que borrar.
  }
}

/** Lo que dice la pantalla mientras se escribe, solo si este navegador de verdad guarda. */
export const DEVICE_DRAFT_PROMISE = "Lo que escribas se guarda en este celular hasta que lo envíes, por un día."

/**
 * Lo que se le dice al volver, en su tarjeta y en el recorrido (dibujo 16): «Vas en el
 * paso 3 de 6» y hasta cuándo sigue guardado; nunca lo que escribió.
 */
export function draftResumeWords(step: DeviceDraftStep | null, until: string): { title: string; text: string } {
  return {
    title: step ? `Vas en el paso ${step.current} de ${step.total}` : "Lo que escribiste sigue aquí",
    text: `Lo que escribiste sigue guardado en este celular ${until}. Todavía no lo enviaste.`,
  }
}

/**
 * Hasta cuándo sigue guardado, dicho como en el dibujo: «hasta mañana, 2:15 p. m.»,
 * «hasta hoy, 9:40 a. m.»; más lejos (no debería: es un día), con su fecha. Con la hora
 * del celular (sin `timeZone`): lo guardado es de ese celular y se lee en su reloj.
 */
export function draftUntilWords(expiresAt: number, now: number, locale?: string, timeZone?: string): string {
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(expiresAt))
  const until = dayOf(expiresAt)
  if (until === dayOf(now)) return `hasta hoy, ${time}`
  if (until === dayOf(now + DEVICE_DRAFT_TTL_MS)) return `hasta mañana, ${time}`
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(expiresAt))
  return `hasta el ${day}, ${time}`
}
