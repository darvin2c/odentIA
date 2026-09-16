/**
 * Dominio clínico puro del odontograma (NTS 188-MINSA/DGIESP-2022).
 * Sin dependencias de ejecución; apto para navegador, API y servicios.
 */
export * from "./anatomy.js"
export * from "./catalog.js"
export * from "./findings.js"
export { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "./tags.js"
export * from "./treatment-templates.js"
export type {
  FindingColorKind,
  FindingDefinition,
  FindingDetails,
  FindingInput,
  FindingRecord,
  FindingScope,
  FindingVariant,
  Surface,
  ToothType,
} from "./types.js"
