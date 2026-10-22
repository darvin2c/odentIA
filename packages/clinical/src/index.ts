/**
 * Dominio clínico puro y común a todos los productos: identidad, diagnósticos,
 * consentimientos, dinero y lo que cambia con el país de la clínica
 * (`country-profiles`, ADR 0036). Lo dental está en `@odentia/dental` (ADR 0079).
 * Apto para navegador, API y servicios; sin dependencias de servidor.
 */
export * from "./catalogs.js"
export { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "./tags.js"
export * from "./vitals.js"
export * from "./medications.js"
export * from "./allergens.js"
export * from "./country-profiles.js"
export * from "./identity.js"
export * from "./diagnoses.js"
export * from "./documents.js"
export * from "./dicom-demo.js"
export * from "./dicom-samples.js"
export * from "./consent.js"
export * from "./money.js"
export * from "./procedure-coding.js"
export * from "./budget-words.js"
export * from "./patient-registration.js"
export * from "./postal-address.js"
export * from "./inventory-units.js"
