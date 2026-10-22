import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { dentalHooks } from "./dental/hooks.js"
import { orgProduct } from "./locale.js"
import { NO_PRODUCT_HOOKS, type ProductHooks } from "./product-hooks.js"

/**
 * El único lugar de lo común que conoce los productos (ADR 0079): qué hace
 * cada uno en cada momento. La app médica aún no tiene momentos propios.
 */
const HOOKS: Record<ClinicalProduct, ProductHooks> = {
  dental: dentalHooks,
  medical: NO_PRODUCT_HOOKS,
}

/** Lo que hace el producto de esta clínica en cada momento de lo común. */
export async function productHooks(tx: Db, orgId: string): Promise<ProductHooks> {
  return HOOKS[await orgProduct(tx, orgId)]
}
