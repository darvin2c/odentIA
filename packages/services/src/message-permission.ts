import type { Db } from "@odentia/db"
import { automationConsent, type ConsentPurpose } from "@odentia/db/schema/automation"
import { and, eq } from "drizzle-orm"

/**
 * La regla de si se le puede escribir a una persona, en un módulo propio para
 * que la usen sin ciclos el envío automático, la ruta de cada mensaje
 * (`automation-routing.ts`) y la regla de las plantillas (`channel-templates.ts`).
 */

/**
 * ¿Se le puede escribir este tipo de mensaje sin que haya escrito primero?
 * Una sola regla (ADR 0030 y 0040): con «ningún mensaje» no sale nada; los
 * avisos de lo que pasó salen siempre; recordatorios y seguimiento salen salvo
 * que los haya apagado (un «no» guardado antes cuenta como baja) y novedades
 * solo con su sí.
 */
export async function mayWriteFirst(
  tx: Db,
  orgId: string,
  contactId: string,
  purpose: ConsentPurpose,
): Promise<boolean> {
  if ((await consentStatusOf(tx, orgId, contactId, "avisos")) === "revoked") return false
  if (purpose === "avisos") return true
  const status = await consentStatusOf(tx, orgId, contactId, purpose)
  return purpose === "novedades" ? status === "granted" : status !== "revoked"
}

export async function consentStatusOf(
  tx: Db,
  orgId: string,
  contactId: string,
  purpose: ConsentPurpose,
): Promise<string | null> {
  const [row] = await tx
    .select({ status: automationConsent.status })
    .from(automationConsent)
    .where(
      and(
        eq(automationConsent.organizationId, orgId),
        eq(automationConsent.contactId, contactId),
        eq(automationConsent.purpose, purpose),
      ),
    )
    .limit(1)
  return row?.status ?? null
}

/**
 * ¿Acepta lo que WhatsApp cuenta como promoción? Es la misma regla que las
 * novedades: solo con su sí (ADR 0040, «la categoría manda»).
 */
export async function acceptsPromotions(tx: Db, orgId: string, contactId: string): Promise<boolean> {
  return mayWriteFirst(tx, orgId, contactId, "novedades")
}
