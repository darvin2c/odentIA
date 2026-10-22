/**
 * Dónde se hizo o se vio algo (ADR 0079), como `bodySite` de HL7 FHIR: un
 * sistema de códigos, un código y sus calificadores. Las tablas comunes guardan
 * el sitio así y cada producto dice qué sistemas y códigos valen; odontología
 * usa ISO 3950 (`@odentia/dental`). Sin sitio, los tres vacíos.
 */
export interface BodySite {
  system: string | null
  code: string | null
  qualifiers: readonly string[]
}

export const NO_SITE: BodySite = { system: null, code: null, qualifiers: [] }
