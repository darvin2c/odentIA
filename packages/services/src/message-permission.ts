import type { Db } from "@odentia/db"
import { automationConsent, type ConsentPurpose } from "@odentia/db/schema/automation"
import { and, eq, type SQL, sql } from "drizzle-orm"
import { MESSAGE_KIND_WORDS } from "./automation-messages.js"

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
  const [row] = await tx.execute<{ ok: boolean }>(sql`select ${mayWriteFirstSql(orgId, sql`${contactId}::uuid`, purpose)} as ok`)
  return row?.ok === true
}

/**
 * La misma regla en SQL, para quien la aplica a muchas personas a la vez
 * («Probar línea» del Administrador). `mayWriteFirst` la ejecuta: no hay una
 * segunda versión que pueda decir otra cosa.
 */
export function mayWriteFirstSql(orgId: string, contactId: SQL, purpose: ConsentPurpose): SQL {
  const status = (of: ConsentPurpose, value: string) => sql`exists (
    select 1 from automation_consent s
    where s.organization_id = ${orgId} and s.contact_id = ${contactId} and s.purpose = ${of} and s.status = ${value})`
  // A quien está en Spam o bloqueado lo automático no le escribe nunca (ADR 0054).
  const screened = sql`exists (select 1 from contact s_scr
    where s_scr.organization_id = ${orgId} and s_scr.id = ${contactId} and s_scr.screen is not null)`
  const all = sql`not ${status("avisos", "revoked")} and not ${screened}`
  if (purpose === "avisos") return sql`(${contactId} is not null and ${all})`
  const own = purpose === "novedades" ? status(purpose, "granted") : sql`not ${status(purpose, "revoked")}`
  return sql`(${contactId} is not null and ${all} and ${own})`
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

/** La puerta para escribirle a alguien (ADR 0042), parte del permiso. Quién decide escribir: odentIA por su cuenta o una persona del equipo. */
export type MessageInitiative = "propia" | "equipo"

export interface GateInput {
  purpose: ConsentPurpose
  initiative: MessageInitiative
}

/** Por qué no se le puede escribir según su permiso, con las palabras para el equipo. */
export function permissionRefusal(purpose: ConsentPurpose): string {
  if (purpose === "novedades") return "La persona no aceptó novedades y promociones"
  if (purpose === "avisos") return "La persona pidió no recibir ningún mensaje de la clínica"
  return `La persona pidió no recibir ${MESSAGE_KIND_WORDS[purpose].title.toLowerCase()}`
}

/**
 * ¿Lo deja salir su permiso por esa vía? Lo que manda el equipo como
 * respuesta a quien acaba de escribir siempre sale; lo demás pasa por
 * `mayWriteFirst`.
 */
export async function permitsMessage(
  tx: Db,
  orgId: string,
  contactId: string,
  input: GateInput & { via: string | null },
): Promise<boolean> {
  if (input.initiative === "equipo" && input.via === "respuesta") return true
  return mayWriteFirst(tx, orgId, contactId, input.purpose)
}

