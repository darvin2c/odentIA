import type { ClinicalProduct } from "@odentia/clinical"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"

/**
 * El plan de lista de un producto (ADR 0093): con él abre y se cuenta una
 * clínica de ese producto que no tiene plan propio. Uno como mucho por
 * producto (`saas_plan_default_uidx`).
 */
export const defaultPlanOf = (product: ClinicalProduct) =>
  and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true), eq(saasPlan.product, product))
