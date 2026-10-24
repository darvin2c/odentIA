import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { DENTAL_AGENT_TEXTS } from "./dental/agent-texts.js"
import { dentalHooks } from "./dental/hooks.js"
import { ServiceError } from "./errors.js"
import { HELP_TOPICS, type HelpTopic } from "./help-guide.js"
import { orgProduct } from "./locale.js"
import { MEDICAL_AGENT_TEXTS } from "./medical/agent-texts.js"
import { MEDICAL_HELP_TOPICS } from "./medical/help.js"
import { medicalHooks } from "./medical/hooks.js"
import type { ProductAgentTexts } from "./product-agent.js"
import type { ProductDictation, ProductHooks } from "./product-hooks.js"

/**
 * El único lugar de lo común que conoce los productos (ADR 0079): qué hace
 * cada uno en cada momento.
 */
const HOOKS: Record<ClinicalProduct, ProductHooks> = {
  dental: dentalHooks,
  medical: medicalHooks,
}

/** Lo que hace el producto de esta clínica en cada momento de lo común. */
export async function productHooks(tx: Db, orgId: string): Promise<ProductHooks> {
  return HOOKS[await orgProduct(tx, orgId)]
}

/** Lo que Clío dicta en esta clínica; null si su producto no dicta. */
export async function productDictation(tx: Db, orgId: string): Promise<ProductDictation | null> {
  return (await productHooks(tx, orgId)).dictation
}

/**
 * Clío dicta con el prompt, el formato y el extractor de su producto (ADR
 * 0079). En una clínica de un producto sin dictado no dicta.
 */
export async function requireDictatingProduct(tx: Db, orgId: string): Promise<ProductDictation> {
  const dictation = await productDictation(tx, orgId)
  if (!dictation) throw new ServiceError("CLINICAL_ASSISTANT_UNAVAILABLE", 409, "Clío aún no dicta en esta clínica")
  return dictation
}

const AGENT_TEXTS: Record<ClinicalProduct, ProductAgentTexts> = {
  dental: DENTAL_AGENT_TEXTS,
  // Los de latidIA (entrega 9 del issue 229): se miden antes de abrir consultorios reales.
  medical: MEDICAL_AGENT_TEXTS,
}

/** Las palabras del producto en lo que lee el modelo (ADR 0079). */
export function agentTextsFor(product: ClinicalProduct): ProductAgentTexts {
  return AGENT_TEXTS[product]
}

/** Las palabras del producto de esta clínica en lo que lee el modelo. */
export async function productAgentTexts(tx: Db, orgId: string): Promise<ProductAgentTexts> {
  return agentTextsFor(await orgProduct(tx, orgId))
}

const HELP: Record<ClinicalProduct, readonly HelpTopic[]> = { dental: HELP_TOPICS, medical: MEDICAL_HELP_TOPICS }

/** La guía de la Ayuda del producto de esta clínica: sus pantallas con sus palabras. */
export async function productHelpTopics(tx: Db, orgId: string): Promise<readonly HelpTopic[]> {
  return HELP[await orgProduct(tx, orgId)]
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
