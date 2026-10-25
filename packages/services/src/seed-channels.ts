// Seed del dominio canales Meta: conexiones demo Messenger e Instagram para la
// org indicada. Idempotente por displayName: si ya existen, no duplica.
// Las demos se crean con validateExternal:false (sin red) y se desactivan
// explícitamente: requieren credenciales propias en la UI antes de usarse,
// nunca aparecen en /usable ni el worker intenta enviar por ellas.
import type { Db } from "@odentia/db"
import { createConnection, listConnections, setConnectionStatus } from "./connections.js"

export async function seedChannels(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
  secretsKey: Buffer,
  deps: { fetch: typeof fetch },
): Promise<void> {
  const existing = await listConnections(tx, input.orgId)
  const byName = new Map(existing.map((c) => [c.displayName, c] as const))
  const messenger = byName.get("Messenger Dental Smile") ?? (await createConnection(
    tx,
    input.orgId,
    secretsKey,
    {
      channel: "messenger",
      provider: "messenger",
      displayName: "Messenger Dental Smile",
      config: { pageId: "seed-page", pageAccessToken: "seed-dev", appSecret: "seed-dev" },
    },
    { fetch: deps.fetch, validateExternal: false },
  ))
  if (messenger.status !== "disabled") {
    await setConnectionStatus(tx, input.orgId, messenger.id, "disabled")
  }
  const instagram = byName.get("Instagram Dental Smile") ?? (await createConnection(
    tx,
    input.orgId,
    secretsKey,
    {
      channel: "instagram",
      provider: "instagram",
      displayName: "Instagram Dental Smile",
      config: { instagramId: "seed-ig", accessToken: "seed-dev", appSecret: "seed-dev" },
    },
    { fetch: deps.fetch, validateExternal: false },
  ))
  if (instagram.status !== "disabled") {
    await setConnectionStatus(tx, input.orgId, instagram.id, "disabled")
  }
}
