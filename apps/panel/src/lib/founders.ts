import { z } from "zod"
import { API_URL } from "./auth-client"

/**
 * Fundadores (issue 165): mientras dure el programa, abrir una clínica pide
 * una invitación. El enlace del correo trae `?invitacion=<token>`; aquí se
 * guarda para que sobreviva a verificar el correo (que vuelve a otra
 * pantalla) y viaja en la cabecera `x-odentia-invitation` al crear la
 * organización. El servidor decide: esto solo la lleva.
 */

const KEY = "odentia.founder-invitation"
/** La invitación vale 14 días: no tiene sentido guardarla más. */
const KEEP_MS = 14 * 86_400_000

export const FOUNDER_INVITATION_HEADER = "x-odentia-invitation"

export function rememberInvitation(token: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() }))
  } catch {
    // Sin almacenamiento, el token sigue en la dirección del enlace.
  }
}

export function storedInvitation(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = z.object({ token: z.string().min(1), at: z.number() }).safeParse(JSON.parse(raw))
    if (!parsed.success || Date.now() - parsed.data.at > KEEP_MS) {
      window.localStorage.removeItem(KEY)
      return null
    }
    return parsed.data.token
  } catch {
    return null
  }
}

export function forgetInvitation(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Nada que borrar.
  }
}

const invitationSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  clinicName: z.string(),
  expiresAt: z.string(),
  offer: z.object({
    planName: z.string(),
    currency: z.string(),
    priceCents: z.number(),
    trialCreditCents: z.number(),
    trialDays: z.number(),
    discountPercent: z.number().nullable(),
    guaranteeMonths: z.number().nullable(),
  }),
})
export type FounderInvitation = z.infer<typeof invitationSchema>

/** La invitación vigente detrás del token, o null si venció, se usó o se anuló. */
export async function fetchInvitation(token: string): Promise<FounderInvitation | null> {
  const res = await fetch(`${API_URL}/api/public/founders/invitation/${encodeURIComponent(token)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Error ${res.status}`)
  const body = (await res.json()) as { data?: unknown }
  return invitationSchema.parse(body.data ?? body)
}

export const invitationQuery = (token: string | null) => ({
  queryKey: ["public", "founder-invitation", token],
  queryFn: () => (token ? fetchInvitation(token) : Promise.resolve(null)),
  enabled: Boolean(token),
  staleTime: 60_000,
  retry: false,
})

/** «USD 100», «USD 0,50»: como en la web y los correos. */
export function moneyText(currency: string, cents: number): string {
  const fixed = (Math.round(cents) / 100).toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}
