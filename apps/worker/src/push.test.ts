import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { pushSubscription } from "@odentia/db/schema/workspace"
import { type PushDelivery, savePushSubscription, workspaceAccessFor } from "@odentia/services"
import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { type PushSender, runPushTick } from "./push.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const keys = (n: string) => ({
  endpoint: `https://push.example.com/send/${n}`,
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
})

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: "p-rita", name: "Rita", email: "rita@push.test", emailVerified: true },
    { id: "p-ana", name: "Ana", email: "ana@push.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-p-rita", userId: "p-rita", organizationId: "org_a", role: "reception", createdAt: new Date() },
    { id: "m-p-ana", userId: "p-ana", organizationId: "org_a", role: "reception", createdAt: new Date() },
  ])
  await withOrgContext(appDb, "org_a", async (tx) => {
    await savePushSubscription(tx, "org_a", "p-rita", workspaceAccessFor("reception"), keys("vivo"))
    await savePushSubscription(tx, "org_a", "p-ana", workspaceAccessFor("reception"), keys("borrado"))
  })
})

it("envía lo anotado, olvida el equipo que ya no existe y no repite lo que quedó en duda", async () => {
  const seen: PushDelivery[] = []
  let failing = true
  const sender: PushSender = {
    async send(delivery) {
      seen.push(delivery)
      // Al enviar, «Listo» ya está anotado: un envío dudoso no se repite.
      const [row] = await ownerDb.select({ welcomedAt: pushSubscription.welcomedAt }).from(pushSubscription).where(eq(pushSubscription.id, delivery.subscriptionId))
      expect(row?.welcomedAt).not.toBeNull()
      if (delivery.endpoint.endsWith("/borrado")) return { gone: true }
      if (failing) throw new Error("se cortó la red")
      return { gone: false }
    },
  }
  expect(await runPushTick({ ownerDb, appDb, sender })).toEqual({ sent: 0, gone: 1, uncertain: 1 })
  expect(seen.map((d) => d.message.tag)).toEqual(["listo", "listo"])
  const left = await ownerDb.select({ endpoint: pushSubscription.endpoint }).from(pushSubscription)
  expect(left).toEqual([{ endpoint: keys("vivo").endpoint }])
  // El «Listo» que quedó en duda no se manda otra vez.
  failing = false
  expect(await runPushTick({ ownerDb, appDb, sender })).toEqual({ sent: 0, gone: 0, uncertain: 0 })
})
