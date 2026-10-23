import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { DENTAL_AGENT_TEXTS } from "./dental/agent-texts.js"
import { dentalHooks } from "./dental/hooks.js"
import { ServiceError } from "./errors.js"
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

/**
 * Clío dicta con el prompt, el formato y el extractor de su producto (ADR
 * 0079): hoy solo el de odentIA. En una clínica de otro producto no dicta.
 */
export async function requireDictatingProduct(tx: Db, orgId: string): Promise<void> {
  if (!(await productHooks(tx, orgId)).dictates)
    throw new ServiceError("CLINICAL_ASSISTANT_UNAVAILABLE", 409, "Clío aún no dicta en esta clínica")
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

/**
 * Lo que los productos agregan al servicio y a la biblioteca (ADR 0079; odentIA:
 * lo que deja en la pieza y cuántas caras admite). Todos comparten el catálogo
 * de servicios, así que se elige con sus columnas: un servicio de otro
 * producto no tiene nada y no lo puede registrar (`checkServiceFinding`).
 */
export {
  checkServiceFinding,
  libraryServiceFinding,
  saveServiceFinding,
  type ServiceLeaves,
  serviceLeavesFinding,
  type TemplateDental as TemplateProduct,
  templateDentalColumns as templateProductColumns,
} from "./dental/service-finding.js"
