/**
 * Lo que la pantalla de entrar recuerda de la última persona que entró desde
 * este navegador (decisión 6 del lienzo de acceso): nombre, clínica y correo
 * para saludarla y pedirle solo la contraseña. Nunca la contraseña ni datos de
 * pacientes. «¿No eres tú?» lo borra. Si el navegador no deja guardar, no pasa
 * nada: se pide todo.
 */
export type RememberedUser = {
  firstName: string
  name: string
  email: string
  clinic?: string | undefined
}

const KEY = "odentia.ultimo-acceso"

export function readRememberedUser(): RememberedUser | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<RememberedUser>
    if (typeof v.email !== "string" || !v.email || typeof v.name !== "string") return null
    return {
      email: v.email,
      name: v.name,
      firstName:
        typeof v.firstName === "string" && v.firstName ? v.firstName : (v.name.split(" ")[0] ?? ""),
      clinic: typeof v.clinic === "string" && v.clinic ? v.clinic : undefined,
    }
  } catch {
    return null
  }
}

export function rememberUser(user: RememberedUser): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(user))
  } catch {
    // Sin almacenamiento la próxima vez se pide el correo; nada más.
  }
}

export function forgetUser(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Igual que arriba.
  }
}

/** «Buenos días» de 5 a 12, «Buenas tardes» de 12 a 19 y «Buenas noches» el resto, en la hora del equipo. */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return "Buenos días"
  if (h >= 12 && h < 19) return "Buenas tardes"
  return "Buenas noches"
}

/** «CR» para Carmen Ruiz. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase()
}
