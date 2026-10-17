// Libro de Reclamaciones virtual de odentIA (Perú): datos del proveedor, textos de la norma y la dirección
// de la API. Norma: Ley 29571 (Código de Protección y Defensa del Consumidor) y su reglamento del Libro de
// Reclamaciones (D.S. 011-2011-PCM, modificado por D.S. 006-2014-PCM y D.S. 101-2022-PCM).
//
// Es la única página de la web que llama a la API (excepción a ADR 0046): la hoja se guarda en el servidor
// y su copia llega al correo del consumidor.

/**
 * Datos del proveedor que encabezan la hoja (Anexo I). Única constante de la web; el correo que envía la
 * API lee `CONSUMER_COMPLAINT_PROVIDER` de `packages/services/src/consumer-complaints.ts`: cambian juntas.
 * Mientras tengan marcadores, la página va sin indexar.
 */
export const COMPLAINTS_PROVIDER = {
  legalName: "[Por completar: razón social]",
  ruc: "[Por completar: RUC]",
  address: "[Por completar: domicilio]",
} as const

/** ¿Falta algún dato real del proveedor? Entonces la página no se indexa. */
export const providerPending = Object.values(COMPLAINTS_PROVIDER).some((v) =>
  v.startsWith("[Por completar"),
)

/** Plazo máximo de respuesta (D.S. 101-2022-PCM). */
export const RESPONSE_DAYS = 15

/** Límites que también aplica el servidor (`CONSUMER_COMPLAINT_LIMITS`). */
export const LIMITS = { detail: 3000, request: 1500, itemDescription: 500 } as const

export const DOCUMENT_TYPES = [
  { value: "DNI", label: "DNI" },
  { value: "CE", label: "Carné de extranjería" },
  { value: "PASAPORTE", label: "Pasaporte" },
] as const

export const KINDS = [
  {
    value: "reclamo",
    label: "Reclamo",
    hint: "Disconformidad relacionada con los productos o servicios.",
  },
  {
    value: "queja",
    label: "Queja",
    hint: "Malestar o descontento respecto a la atención al público.",
  },
] as const

export const CURRENCIES = [
  { value: "PEN", label: "S/ (soles)" },
  { value: "USD", label: "USD (dólares)" },
] as const

const domain = import.meta.env.VITE_BASE_DOMAIN || "odentia.localhost"
const port = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

/** La API vive en api.<dominio>, como el panel en app.<dominio> (ver `site.ts`). */
export const complaintsApiUrl = `https://api.${domain}${port}/api/public/libro-de-reclamaciones`
