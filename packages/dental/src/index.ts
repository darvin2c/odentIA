/**
 * Dominio dental puro (ADR 0079): odontograma y sus hallazgos (NTS 188),
 * periodontograma, tipos de tratamiento de la biblioteca y lo dental de cada
 * país. Lo común (identidad, diagnósticos, dinero, país) está en
 * `@odentia/clinical`, que nunca importa este paquete.
 */
export * from "./anatomy.js"
export * from "./catalog.js"
export * from "./findings.js"
export * from "./treated-findings.js"
export * from "./signed-odontogram.js"
export * from "./treatment-templates.js"
export * from "./periodontal.js"
export * from "./cbct-demo.js"
export * from "./country.js"
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
