/**
 * Dominio óptico puro de vistIA: el catálogo de la óptica, los diagnósticos que
 * van primero, sus imágenes y sus consentimientos. Lo común está en
 * `@odentia/clinical`, que nunca importa este paquete; lo óptico de los servicios
 * vive en `@odentia/services` (`src/optical/`) y en la app de vistIA.
 */
export * from "./catalog.js"
export * from "./consents.js"
export * from "./diagnoses.js"
export * from "./imaging.js"
export * from "./medications.js"
export * from "./professional.js"
