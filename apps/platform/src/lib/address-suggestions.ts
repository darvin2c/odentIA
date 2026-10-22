import { apiFetch } from "./api"
import { API_URL } from "./auth-client"

/**
 * Sugerencias de direcciones (issue 36, ADR 0077): la sede busca en Google y la
 * persona en Geoapify, siempre por el servidor de odentIA. Estos son los tipos
 * y los caminos al servidor; el campo es `AddressStreetField`.
 */
export interface SuggestedAddress {
  line: string | null
  city: string | null
  district: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  /** La ficha del lugar en Google (solo la sede). */
  placeId: string | null
}

export interface AddressSuggestion {
  id: string
  main: string
  secondary: string | null
  /** Un negocio con nombre: la clínica encontrada por cómo aparece en el mapa. */
  isPlace: boolean
  /** La dirección ya armada, si vino con la sugerencia (Geoapify). */
  address: SuggestedAddress | null
}

export interface AddressSuggestions {
  /** false: sin proveedor, sin respuesta o pasado el tope del día: el campo de siempre. */
  available: boolean
  /** La mención que pide el proveedor al pie de la lista. */
  attribution: string | null
  suggestions: AddressSuggestion[]
}

/** Lo elegido, listo para llenar el formulario: la dirección y, si fue un negocio, su nombre. */
export interface AddressPick extends SuggestedAddress {
  placeName: string | null
}

/** De dónde salen las sugerencias: con sesión (equipo) o por la página pública de la clínica. */
export interface AddressSource {
  suggest(input: { text: string; session: string }): Promise<AddressSuggestions>
  /** La dirección de una sugerencia que no la trae (Google). */
  resolve?(input: { id: string; session: string }): Promise<SuggestedAddress | null>
}

/** Para el equipo: la sede (Google) o la dirección de una persona (Geoapify). */
export function staffAddressSource(purpose: "sede" | "paciente"): AddressSource {
  return {
    suggest: ({ text, session }) =>
      apiFetch<{ data: AddressSuggestions }>("/api/address/suggestions", {
        method: "POST",
        body: JSON.stringify({ q: text, for: purpose, session }),
      }).then((res) => res.data),
    resolve: ({ id, session }) =>
      apiFetch<{ data: SuggestedAddress | null }>("/api/address/place", {
        method: "POST",
        body: JSON.stringify({ id, for: purpose, session }),
      }).then((res) => res.data),
  }
}

/** Para la persona en la página pública de su clínica (registro o «Tus datos»). */
export function publicAddressSource(slug: string): AddressSource {
  return {
    suggest: async ({ text, session }) => {
      const response = await fetch(`${API_URL}/api/public/booking/${encodeURIComponent(slug)}/address`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, session }),
      })
      if (!response.ok) return { available: false, attribution: null, suggestions: [] }
      return ((await response.json()) as { data: AddressSuggestions }).data
    },
  }
}
