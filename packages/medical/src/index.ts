/**
 * Dominio médico puro de latidIA (ADR 0079): el examen por sistemas, los
 * signos vitales y los antecedentes médicos del consultorio. Lo común está en `@odentia/clinical`, que
 * nunca importa este paquete; lo médico de los servicios vive en
 * `@odentia/services` (`src/medical/`) y en la app de latidIA.
 */
export * from "./examination.js"
export * from "./history.js"
export * from "./vitals.js"
