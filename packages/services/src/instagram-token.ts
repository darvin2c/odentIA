import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { channelConnection } from "@odentia/db/schema/crm"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { decryptConfig, encryptJson } from "./secrets.js"
import { upsertWorkspaceNotification } from "./workspace.js"

/**
 * Instagram conectado a mano (Instagram Login, «con tu propia app»): su clave
 * dura 60 días. La vuelta diaria la renueva cada 7, así nunca llega a vencer;
 * solo avisa si Instagram no la renovó. Las conectadas con Facebook usan la
 * clave de la página, que no vence.
 */
export const INSTAGRAM_RENEW_EVERY_MS = 7 * 24 * 3_600_000
/** Instagram no renueva una clave de menos de 24 horas. */
const INSTAGRAM_MIN_AGE_MS = 24 * 3_600_000

/** Las de todas las clínicas que toca renovar, con su clave. */
export async function listInstagramTokensDue(
  ownerDb: Db,
  secretsKey: Buffer,
  now = new Date(),
): Promise<Array<{ orgId: string; connectionId: string; token: string }>> {
  const rows = await ownerDb
    .select({
      orgId: channelConnection.organizationId,
      connectionId: channelConnection.id,
      configEncrypted: channelConnection.configEncrypted,
      updatedAt: channelConnection.updatedAt,
    })
    .from(channelConnection)
    .leftJoin(saasSubscription, eq(saasSubscription.organizationId, channelConnection.organizationId))
    .where(
      and(
        eq(channelConnection.provider, "instagram"),
        eq(channelConnection.status, "active"),
        isNull(channelConnection.signup),
        // Una demo no: sus claves son de ejemplo.
        or(isNull(saasSubscription.isDemo), eq(saasSubscription.isDemo, false)),
      ),
    )
  return rows.flatMap((row) => {
    let config: Record<string, unknown>
    try {
      config = decryptConfig(secretsKey, row.configEncrypted)
    } catch {
      return []
    }
    const token = config["accessToken"]
    if (typeof token !== "string" || !token || typeof config["pageAccessToken"] === "string") return []
    const renewed = typeof config["tokenRenewedAt"] === "string" ? Date.parse(config["tokenRenewedAt"]) : Number.NaN
    // Sin fecha propia: la clave tiene, como mucho, la edad de la conexión.
    const since = Number.isFinite(renewed) ? renewed : row.updatedAt.getTime()
    const age = now.getTime() - since
    if (age < INSTAGRAM_MIN_AGE_MS || (Number.isFinite(renewed) && age < INSTAGRAM_RENEW_EVERY_MS)) return []
    return [{ orgId: row.orgId, connectionId: row.connectionId, token }]
  })
}

/** Guarda la clave renovada, si nadie pegó otra mientras tanto. Devuelve si la guardó. */
export async function saveRenewedInstagramToken(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  oldToken: string,
  newToken: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ configEncrypted: channelConnection.configEncrypted })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row) return false
  const config = decryptConfig(secretsKey, row.configEncrypted)
  if (config["accessToken"] !== oldToken) return false
  await tx
    .update(channelConnection)
    .set({
      configEncrypted: encryptJson(secretsKey, { ...config, accessToken: newToken, tokenRenewedAt: new Date().toISOString() }),
      updatedAt: new Date(),
    })
    .where(eq(channelConnection.id, connectionId))
  return true
}

/**
 * Instagram no renovó la clave: la campana avisa a quien administra. Se retira
 * sola cuando se renueva o se pega otra (la conexión cambia).
 */
export async function noteInstagramRenewFailed(tx: Db, orgId: string, connectionId: string): Promise<void> {
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  for (const { userId } of admins) {
    await upsertWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `renovar-instagram:${connectionId}:${userId}`,
      subject: `renovar-instagram:${connectionId}`,
      title: "Instagram no pudo renovar su clave",
      body: "La clave de Instagram vence a los 60 días y no se pudo renovar. Para que los mensajes sigan llegando, conecta Instagram con Facebook o pega una clave nueva en Configuración › Integraciones › Instagram.",
      href: "/settings/integrations/instagram",
      permission: "settings.write",
    })
  }
}
