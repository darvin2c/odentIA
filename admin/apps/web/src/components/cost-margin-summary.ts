import type { ClinicCostMargin } from "./cost-margin"

/** Lo que regala odentIA por la Ayuda de una app que es otro sistema, en el mes de Lima. */
export interface AppHelpCost {
  app: string
  /** «Ayuda de gestorIA». */
  label: string
  period: { start: string; end: string }
  calls: number
  costMicros: number
  /** Llamadas sin costo conocido: no están en el total. */
  unpricedCalls: number
}

/** «Costo y margen» de todas, como lo responde el servidor (`getCostMarginOverview`). */
export interface Overview {
  clinics: ClinicCostMargin[]
  /** La Ayuda de cada app: su costo ya está en `costMicros` y `aiMicros`. */
  apps: AppHelpCost[]
  founders: number
  chargedCents: number
  costMicros: number
  aiMicros: number
  storageMicros: number
  fixedMicros: number
  marginPct: number | null
  marginAfterCommissionPct: number | null
}

/**
 * Los totales de las clínicas de un producto, como los suma el servidor. La Ayuda de una app no
 * es de ningún producto de clínicas: con un producto elegido, ni se muestra ni suma.
 */
export function summaryOf(clinics: ClinicCostMargin[]): Overview {
  const charged = clinics.reduce((sum, item) => sum + item.chargedCents, 0)
  const costTotal = clinics.reduce((sum, item) => sum + item.costMicros, 0)
  const commission = clinics.reduce((sum, item) => sum + item.commissionCents, 0)
  const pct = (base: number, spent: number) => (base > 0 ? Math.round((1 - spent / base) * 100) : null)
  return {
    clinics,
    apps: [],
    founders: clinics.filter((item) => item.founder).length,
    chargedCents: charged,
    costMicros: costTotal,
    aiMicros: clinics.reduce((sum, item) => sum + item.aiMicros, 0),
    storageMicros: clinics.reduce((sum, item) => sum + item.storageMicros, 0),
    fixedMicros: clinics.reduce((sum, item) => sum + item.fixedMicros, 0),
    marginPct: pct(charged * 10_000, costTotal),
    marginAfterCommissionPct: pct(charged * 10_000, costTotal + commission * 10_000),
  }
}
