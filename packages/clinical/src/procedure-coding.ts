/**
 * Snapshot congelado de codificaciones en plan/presupuesto/atención.
 * Se copia al indicar/cotizar/ejecutar; el histórico nunca sigue al mapeo vigente.
 */
export interface ProcedureCodingSnapshot {
  system: string
  code: string
  version: string
  display: string
}
