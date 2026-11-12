import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"

/*
 * Lo que la cola de soporte y la lista de espera leen de la dirección. Cada
 * clave va siempre, con `undefined` si su valor no sirve: TanStack Router junta
 * la búsqueda cruda de la dirección con la de la ruta (`{ ...cruda, ...ruta }`),
 * así que una clave que se omite deja pasar el valor crudo («?estado=todos») y
 * la pantalla lo mandaba a la API, que respondía 400.
 */

export const SUPPORT_STATUSES = ["abierto", "en_atencion", "esperando_clinica", "resuelto"] as const
export type SupportStatusFilter = (typeof SUPPORT_STATUSES)[number]
export const SUPPORT_KINDS = ["pregunta", "problema", "acceso", "cobro"] as const
export type SupportKindFilter = (typeof SUPPORT_KINDS)[number]

export interface SupportSearch {
  /** El caso abierto: lo usa también el enlace del aviso por correo. */
  caso?: string | undefined
  clinica?: string | undefined
  tipo?: SupportKindFilter | undefined
  quien?: "mios" | "sin" | undefined
  /** Sin estado: los que no están resueltos. */
  estado?: SupportStatusFilter | undefined
  pestana?: "conocimiento" | "metricas" | undefined
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : undefined
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

export function supportSearchOf(search: Record<string, unknown>): SupportSearch {
  return {
    caso: text(search.caso),
    clinica: text(search.clinica),
    tipo: oneOf(SUPPORT_KINDS, search.tipo),
    quien: oneOf(["mios", "sin"] as const, search.quien),
    estado: oneOf(SUPPORT_STATUSES, search.estado),
    pestana: oneOf(["conocimiento", "metricas"] as const, search.pestana),
  }
}

/**
 * Las etapas las calcula el servidor al leer (nadie las mueve a mano): la
 * invitación que vence pasa sola a «Invitación vencida» y la clínica con un
 * pago confirmado, a «Paga».
 */
export const WAITLIST_STAGES = ["por_revisar", "invitada", "invitacion_vencida", "entro", "paga", "descartada"] as const
export type WaitlistStageName = (typeof WAITLIST_STAGES)[number]
export type WaitlistStageFilter = WaitlistStageName | "todas"
export const WAITLIST_STAGE_FILTERS: readonly WaitlistStageFilter[] = [...WAITLIST_STAGES, "todas"]
export const isWaitlistStageFilter = (value: unknown): value is WaitlistStageFilter =>
  typeof value === "string" && (WAITLIST_STAGE_FILTERS as readonly string[]).includes(value)

export interface WaitlistSearch {
  /** Sin etapa: «Por revisar». */
  etapa?: WaitlistStageFilter | undefined
  producto?: ClinicalProduct | undefined
  q?: string | undefined
  solicitud?: string | undefined
  /** El nombre de antes de `etapa`: se lee y no se vuelve a escribir. */
  estado?: undefined
}

export function waitlistSearchOf(search: Record<string, unknown>): WaitlistSearch {
  // `estado` es el nombre de antes: un enlace guardado con «?estado=entro» abre esa etapa.
  const etapa = isWaitlistStageFilter(search.etapa) ? search.etapa : isWaitlistStageFilter(search.estado) ? search.estado : undefined
  return {
    etapa: etapa === "por_revisar" ? undefined : etapa,
    producto: isClinicalProduct(search.producto) ? search.producto : undefined,
    // Un enlace con «?q=987654321» llega como número: también es una búsqueda.
    q: (typeof search.q === "string" && search.q) || typeof search.q === "number" ? String(search.q) : undefined,
    solicitud: typeof search.solicitud === "string" ? search.solicitud : undefined,
    estado: undefined,
  }
}
