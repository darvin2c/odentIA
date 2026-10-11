import { ApiError } from "./api"
import { API_URL } from "./auth-client"

export interface BookingAppointment {
  startsAt: string
  endsAt: string
  timeZone: string
  durationMin: number
  branchId: string
  cancelled: boolean
  /** Aún se puede cambiar de horario o cancelar desde el enlace. */
  canChange: boolean
  branchName: string
  branchAddress: string | null
  dentistName: string
  serviceName: string | null
}

export interface BookingLinkView {
  status: "abierto" | "usado" | "vencido"
  clinicName: string
  patientFirstName: string | null
  needsRegistration: boolean
  service: { name: string; durationMin: number | null } | null
  branches: Array<{ id: string; name: string; address: string | null; timeZone: string; defaultMinutes: number }>
  branchId: string | null
  expiresAt: string
  appointment: BookingAppointment | null
}

export interface BookingSlot {
  startsAt: string
  endsAt: string
  dentistUserId: string
  dentistName: string
  chairId: string | null
}

/** Página pública: sin sesión ni cabecera de organización; lo único que identifica es el enlace. */
async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!response.ok) {
    let shape: { code?: string; message?: string; request_id?: string } = {}
    try {
      shape = ((await response.json()) as { error?: typeof shape }).error ?? {}
    } catch {
      // respuesta no-JSON: sin detalle
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}

const base = (slug: string) => `${API_URL}/api/public/booking/${encodeURIComponent(slug)}`

export function fetchBookingLink(slug: string, token: string): Promise<{ data: BookingLinkView }> {
  return publicFetch(`${base(slug)}?token=${encodeURIComponent(token)}`)
}

export function fetchBookingSlots(
  slug: string,
  token: string,
  range: { branchId: string; from: string; to: string },
): Promise<{ data: { slots: BookingSlot[]; timeZone: string; truncated: boolean } }> {
  const query = new URLSearchParams({ token, branchId: range.branchId, from: range.from, to: range.to })
  return publicFetch(`${base(slug)}/slots?${query.toString()}`)
}

/** Abre el registro de pacientes para quien aún no lo es; devuelve el enlace con el que se pide y se envía el formulario. */
export function startBookingRegistration(slug: string, token: string): Promise<{ data: { registrationToken: string } }> {
  return publicFetch(`${base(slug)}/registration`, { method: "POST", body: JSON.stringify({ token }) })
}

export function reserveBooking(
  slug: string,
  input: { token: string; branchId: string; startsAt: string; dentistUserId: string; chairId?: string },
): Promise<{ data: BookingAppointment }> {
  return publicFetch(`${base(slug)}/reserve`, { method: "POST", body: JSON.stringify(input) })
}

/** Cambia de horario la cita ya reservada con el enlace. */
export function changeBooking(
  slug: string,
  input: { token: string; startsAt: string; dentistUserId: string; chairId?: string },
): Promise<{ data: BookingAppointment }> {
  return publicFetch(`${base(slug)}/change`, { method: "POST", body: JSON.stringify(input) })
}

/** Cancela la cita ya reservada con el enlace. */
export function cancelBooking(slug: string, token: string): Promise<{ data: BookingAppointment }> {
  return publicFetch(`${base(slug)}/cancel`, { method: "POST", body: JSON.stringify({ token }) })
}
