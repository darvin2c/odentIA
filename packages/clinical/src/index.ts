/**
 * Dominio clínico puro: odontograma, identidad, consentimientos y lo que
 * cambia con el país de la clínica (`country-profiles`, ADR 0036).
 * Apto para navegador, API y servicios; sin dependencias de servidor.
 */
export * from "./anatomy.js"
export * from "./catalog.js"
export * from "./catalogs.js"
export * from "./findings.js"
export * from "./treated-findings.js"
export * from "./signed-odontogram.js"
export { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "./tags.js"
export * from "./treatment-templates.js"
export * from "./vitals.js"
export * from "./medications.js"
export * from "./country-profiles.js"
export * from "./identity.js"
export * from "./diagnoses.js"
export * from "./documents.js"
export * from "./dicom-demo.js"
export * from "./dicom-samples.js"
export * from "./cbct-demo.js"
export * from "./consent.js"
export * from "./money.js"
export * from "./budget-words.js"
export * from "./patient-registration.js"
export * from "./periodontal.js"
export * from "./inventory-units.js"
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
  ValidateFindingOptions,
} from "./types.js"
