import { type Db, withOrgContext } from "@odentia/db"
import { collectOrgPushes, forgetPushSubscription, type PushDelivery, pushSubscribedOrgs } from "@odentia/services"
import webpush from "web-push"
import { shouldSkipSaasOrg } from "./saas-billing.js"

const PARALLEL_SENDS = 8

/** Lo mínimo de un envío: dice si el equipo ya no existe (el servicio de push respondió 404 o 410). */
export interface PushSender {
  send(delivery: PushDelivery): Promise<{ gone: boolean }>
}

export interface PushWorkerDeps {
  ownerDb: Db
  appDb: Db
  sender: PushSender
  now?: Date
}

export interface PushTickResult {
  sent: number
  gone: number
  uncertain: number
}

/** El envío real con las claves VAPID (RFC 8292). El `topic` hace que el servicio de push guarde solo el último de cada tipo. */
export function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushSender {
  return {
    async send(delivery) {
      try {
        await webpush.sendNotification(
          { endpoint: delivery.endpoint, keys: { p256dh: delivery.p256dh, auth: delivery.auth } },
          JSON.stringify(delivery.message),
          { TTL: delivery.ttlSeconds, urgency: delivery.urgency, topic: delivery.message.tag, vapidDetails: vapid, timeout: 10_000 },
        )
        return { gone: false }
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // 404/410: el equipo ya no existe. 403: se suscribió con otras claves VAPID (RFC 8292);
        // olvidarlo hace que la campana lo muestre apagado y la persona lo vuelva a activar.
        if (status === 404 || status === 410 || status === 403) return { gone: true }
        throw error
      }
    },
  }
}

/**
 * Una vuelta de los avisos en el equipo: por cada clínica con equipos
 * suscritos, anota lo que toca avisar y después lo envía. Lo que falla no se
 * reintenta (lo dice Inicio igual); el equipo que ya no existe se olvida.
 * Una clínica en pausa comercial no recibe avisos.
 */
export async function runPushTick(deps: PushWorkerDeps): Promise<PushTickResult> {
  const result: PushTickResult = { sent: 0, gone: 0, uncertain: 0 }
  for (const orgId of await pushSubscribedOrgs(deps.ownerDb)) {
    if (await shouldSkipSaasOrg(deps.ownerDb, orgId)) continue
    let deliveries: PushDelivery[]
    try {
      deliveries = await withOrgContext(deps.appDb, orgId, (tx) => collectOrgPushes(tx, orgId, deps.now))
    } catch (error) {
      console.error(`worker: avisos en el equipo sin armar (${orgId})`, error)
      continue
    }
    const send = async (delivery: PushDelivery) => {
      try {
        const { gone } = await deps.sender.send(delivery)
        if (gone) {
          await withOrgContext(deps.appDb, orgId, (tx) => forgetPushSubscription(tx, orgId, delivery.subscriptionId))
          result.gone += 1
        } else result.sent += 1
      } catch (error) {
        console.error(`worker: aviso en el equipo incierto (${orgId})`, error)
        result.uncertain += 1
      }
    }
    // Varios a la vez, con tope: un servicio de push lento no deja esperando a los demás.
    for (let start = 0; start < deliveries.length; start += PARALLEL_SENDS) {
      await Promise.all(deliveries.slice(start, start + PARALLEL_SENDS).map(send))
    }
  }
  return result
}
