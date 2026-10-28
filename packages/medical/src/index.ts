/**
 * Dominio médico puro de latidIA (ADR 0079): el examen por sistemas, los
 * signos vitales, los antecedentes médicos, la receta, las imágenes y el
 * catálogo del consultorio. Lo común está en `@odentia/clinical`, que nunca importa este
 * paquete; lo médico de los servicios vive en `@odentia/services`
 * (`src/medical/`) y en la app de latidIA.
 */
export * from "./catalog.js"
export * from "./consents.js"
export * from "./diagnoses.js"
export * from "./examination.js"
export * from "./history.js"
export * from "./imaging.js"
export * from "./medications.js"
export * from "./prescribing.js"
export * from "./professional.js"
export * from "./vitals.js"
