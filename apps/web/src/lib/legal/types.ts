// Forma de los documentos legales de la web (términos, privacidad, cookies, encargo, subencargados y
// aviso legal). El texto vive en un módulo por documento dentro de esta carpeta y lo pinta
// src/components/pages/LegalPage.astro.
//
// Dentro de cualquier texto:
// - «[texto](/ruta)» es un enlace (rutas internas, mailto: o https:).
// - «[Por completar: …]» y «[Por confirmar: …]» son marcadores visibles de datos que faltan; mientras un
//   documento tenga alguno, la página va con noindex.
import { privacyEmail } from "../site"

/** Un bloque de una sección: párrafo, subtítulo, lista, tabla o recuadro destacado. */
export type LegalBlock =
  | string
  | { h: string }
  | { list: string[]; ordered?: boolean }
  | { table: { caption: string; head: string[]; rows: string[][] } }
  | { note: string }

export type LegalSection = {
  /** Ancla de la sección (sin «#»). */
  id: string
  title: string
  blocks: LegalBlock[]
}

export type LegalDoc = {
  path: string
  title: string
  /** Metadescripción para buscadores. */
  description: string
  /** Párrafos breves antes del índice: de qué trata el documento y a quién aplica. */
  intro: string[]
  sections: LegalSection[]
}

/** Fecha de la versión vigente de todos los documentos legales. */
export const LEGAL_UPDATED = "26 de octubre de 2026"
export const LEGAL_UPDATED_ISO = "2026-10-26"

/** Datos del titular; lo pendiente conserva el mismo marcador en todos los documentos. */
export const TITULAR = {
  razonSocial: "SALLCA GROUP E.I.R.L.",
  ruc: "20603338741",
  domicilio: "Av. Mariscal Andrés de Santa Cruz 176, Urb. Fundo Oyague, Jesús María, Lima",
  correoPrivacidad: privacyEmail,
} as const

const PENDIENTE = /\[Por (completar|confirmar)/

/** Verdadero si el documento conserva algún marcador «[Por completar…]» o «[Por confirmar…]». */
export function hasPending(doc: LegalDoc): boolean {
  return PENDIENTE.test(JSON.stringify(doc))
}
