import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { DENTAL_AGENT_TEXTS } from "./dental/agent-texts.js"
import { dentalHooks } from "./dental/hooks.js"
import { orgProduct } from "./locale.js"
import { NO_AGENT_TEXTS, type ProductAgentTexts } from "./product-agent.js"
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

const AGENT_TEXTS: Record<ClinicalProduct, ProductAgentTexts> = {
  dental: DENTAL_AGENT_TEXTS,
  // La app médica aún no tiene sus textos: se escriben y se miden con ella.
  medical: NO_AGENT_TEXTS,
}

/** Las palabras del producto en lo que lee el modelo (ADR 0079). */
export function agentTextsFor(product: ClinicalProduct): ProductAgentTexts {
  return AGENT_TEXTS[product]
}

/** Las palabras del producto de esta clínica en lo que lee el modelo. */
export async function productAgentTexts(tx: Db, orgId: string): Promise<ProductAgentTexts> {
  return agentTextsFor(await orgProduct(tx, orgId))
}
