import {
  type Db,
  PUSH_KINDS,
  type PushKind,
  pushChoice,
  pushDevice,
  withPerson,
} from "@gestoria/db"
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import webpush from "web-push"
import { z } from "zod"
import { SOFI_ACTOR } from "./agente.js"
import type { Person } from "./cuenta.js"
import { formatMoney } from "./dinero.js"
import { pad } from "./pedidos.js"
import { can, type StorePermission, type StoreSeat } from "./permisos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los avisos al celular (lienzo «gestorIA como odentIA», tablero 15; ADR 0229): gestorIA se
 * instala desde el navegador y avisa con la app cerrada, como ya avisa odentIA (ADR 0177), por
 * push web y no por WhatsApp: no cuesta nada.
 *
 * - No es otra bandeja: avisa que llegó algo nuevo de lo que ya está en Pedidos (y, cuando
 *   lleguen, en «Te toca» y en la Bandeja). Cada aviso abre la pantalla que lo resuelve, y el
 *   siguiente del mismo tipo reemplaza al anterior (`tag` en el celular, `Topic` en el servicio).
 * - A cada rol lo suyo: cada tipo lo recibe quien tiene su permiso (`PUSH_KIND_INFO`), mirado al
 *   enviar; quien deja la tienda deja de recibirlos. Cada persona elige cuáles, entre esos, y vale
 *   en todos sus celulares. Lo que hizo la misma persona no se le avisa: ya lo sabe.
 * - Dice quién y cuánto: en una tienda es lo que hace falta para saber si se abre ya.
 * - El sistema anota antes de enviar: un envío que falla o queda en duda no se repite (lo nuevo
 *   sigue en la pantalla); un celular que el servicio de push ya no conoce se olvida.
 */

/** De qué avisa cada tipo, quién lo puede recibir y si le llega sin elegirlo. */
export const PUSH_KIND_INFO: Record<
  PushKind,
  {
    label: string
    hint: string
    needs: StorePermission
    /** Sin elegir nada: a quién le llega. Los pedidos de Sofi, por omisión, a quien ve lo de toda la tienda. */
    byDefault: (seat: StoreSeat) => boolean
  }
> = {
  pagos: {
    label: "Pagos por confirmar",
    hint: "Cuando una clienta manda su captura.",
    needs: "pagos.confirmar",
    byDefault: () => true,
  },
  chats: {
    label: "Chats que esperan a una persona",
    hint: "Cuando Sofi pasa un chat al equipo.",
    needs: "ventas.atender",
    byDefault: () => true,
  },
  no_entregado: {
    label: "Lo que no se entregó",
    hint: "Cuando una entrega vuelve sin entregarse.",
    needs: "entregas",
    byDefault: () => true,
  },
  sofi_pedido: {
    label: "Pedidos que armó Sofi",
    hint: "Para enterarte de cada venta.",
    needs: "ventas.atender",
    byDefault: (seat) => can(seat, "reportes.ver"),
  },
  dinero: {
    label: "Lo de dinero",
    hint: "Cuando entra un pago por link.",
    needs: "reportes.ver",
    byDefault: () => true,
  },
}

/** Lo que un rol puede recibir, en el orden en que se muestra. */
export function kindsFor(seat: StoreSeat): PushKind[] {
  if (!can(seat, "avisos.recibir")) return []
  return PUSH_KINDS.filter((kind) => can(seat, PUSH_KIND_INFO[kind].needs))
}

/** Lo que le llega: lo que eligió (o lo de su rol por omisión), siempre dentro de lo que su rol puede. */
export function activeKinds(seat: StoreSeat, chosen: readonly string[] | null): Set<PushKind> {
  const allowed = kindsFor(seat)
  return new Set(
    chosen === null
      ? allowed.filter((kind) => PUSH_KIND_INFO[kind].byDefault(seat))
      : allowed.filter((kind) => chosen.includes(kind)),
  )
}

/* ------------------------------------------------------------------ el celular */

/**
 * Los servicios de push de los navegadores: Chrome, Edge y Android (FCM), Safari (Apple), Firefox
 * (Mozilla) y Edge en Windows (WNS). El servidor hace un POST a la dirección que manda el
 * navegador: cualquier otra no se acepta, para que nadie lo use para llegar a otro servidor. Es la
 * misma lista de las clínicas (`packages/services/src/push.ts`), que gestorIA no importa.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
]

const endpoint = z
  .string()
  .max(1000)
  .refine((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return false
    }
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      PUSH_HOSTS.some((host) => host.test(url.hostname))
    )
  }, "La dirección de este celular no es válida")

export const deviceInput = z.object({ endpoint })
/** Una clave P-256 sin comprimir (65 bytes) y el secreto de 16 bytes, en base64url (RFC 8291). */
export const subscribeInput = deviceInput.extend({
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86,87}=?$/, "Las claves de este celular no son válidas"),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/, "Las claves de este celular no son válidas"),
  }),
})

/** Celulares por persona: más que eso es un error o un abuso, y cada vuelta los recorre todos. */
export const DEVICES_PER_PERSON = 10

/**
 * Este celular recibe los avisos de quien lo activa, de todas sus tiendas. Si recibía los de otra
 * persona (un celular prestado sin cerrar sesión), pasa a quien lo activa ahora, pero solo desde
 * ese mismo navegador, el único que tiene sus claves: con la dirección sola nadie se queda con
 * los avisos de otro. Ese paso lo hace el sistema (el dueño de la base), porque la persona no ve
 * los celulares ajenos.
 */
export async function saveDevice(
  appDb: Db,
  ownerDb: Db,
  person: Person,
  input: z.infer<typeof subscribeInput>,
) {
  const { endpoint: url, keys } = input
  const [taken] = await ownerDb
    .select({ userId: pushDevice.userId, p256dh: pushDevice.p256dh, auth: pushDevice.auth })
    .from(pushDevice)
    .where(eq(pushDevice.endpoint, url))
  if (taken && taken.userId !== person.userId) {
    if (taken.p256dh !== keys.p256dh || taken.auth !== keys.auth)
      throw new StoreError(
        409,
        "DEVICE_TAKEN",
        "Este celular ya recibe los avisos de otra persona. Que cierre su sesión aquí y vuelve a intentar.",
      )
    await ownerDb
      .delete(pushDevice)
      .where(and(eq(pushDevice.endpoint, url), eq(pushDevice.userId, taken.userId)))
  }
  await withPerson(appDb, person, async (tx) => {
    await tx
      .insert(pushDevice)
      .values({ userId: person.userId, endpoint: url, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: pushDevice.endpoint,
        set: { p256dh: keys.p256dh, auth: keys.auth },
      })
    // Con más celulares que el tope, se olvidan los más antiguos de esa persona.
    const kept = tx
      .select({ id: pushDevice.id })
      .from(pushDevice)
      .where(eq(pushDevice.userId, person.userId))
      .orderBy(desc(pushDevice.createdAt), desc(pushDevice.id))
      .limit(DEVICES_PER_PERSON)
    await tx
      .delete(pushDevice)
      .where(and(eq(pushDevice.userId, person.userId), notInArray(pushDevice.id, kept)))
  })
  return { active: true }
}

/** Si este celular recibe hoy los avisos de quien mira (otra persona pudo activarlo después). */
export async function deviceState(appDb: Db, person: Person, input: z.infer<typeof deviceInput>) {
  const rows = await withPerson(appDb, person, (tx) =>
    tx
      .select({ id: pushDevice.id })
      .from(pushDevice)
      .where(and(eq(pushDevice.userId, person.userId), eq(pushDevice.endpoint, input.endpoint))),
  )
  return { active: rows.length > 0 }
}

/** «Apagar en este celular», también al cerrar sesión. Solo el de quien lo pide. */
export async function removeDevice(appDb: Db, person: Person, input: z.infer<typeof deviceInput>) {
  await withPerson(appDb, person, (tx) =>
    tx
      .delete(pushDevice)
      .where(and(eq(pushDevice.userId, person.userId), eq(pushDevice.endpoint, input.endpoint))),
  )
  return { active: false }
}

/* --------------------------------------------- Configuración › Avisos al celular */

export const choicesInput = z.object({
  kinds: z.array(z.enum(PUSH_KINDS, { error: "Elige avisos de la lista" })).max(PUSH_KINDS.length),
})

async function choicesIn(tx: Db, storeId: string, person: Person, seat: StoreSeat) {
  const [row] = await tx
    .select({ kinds: pushChoice.kinds })
    .from(pushChoice)
    .where(and(eq(pushChoice.storeId, storeId), eq(pushChoice.userId, person.userId)))
  const active = activeKinds(seat, row?.kinds ?? null)
  const [devices] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(pushDevice)
    .where(eq(pushDevice.userId, person.userId))
  return {
    kinds: kindsFor(seat).map((kind) => ({
      kind,
      label: PUSH_KIND_INFO[kind].label,
      hint: PUSH_KIND_INFO[kind].hint,
      on: active.has(kind),
    })),
    /** En cuántos celulares los recibe: lo que elige vale en todos. */
    devices: devices?.count ?? 0,
  }
}

/** Qué le llega a quien mira, de esta tienda: solo lo que su rol puede resolver. */
export async function storeChoices(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "avisos.recibir", (tx, seat) =>
    choicesIn(tx, storeId, person, seat),
  )
}

/** Guarda lo que elige: vale en todos sus celulares. Lo que su rol no resuelve no se puede elegir. */
export async function saveChoices(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof choicesInput>,
) {
  return inStore(appDb, person, storeId, "avisos.recibir", async (tx, seat) => {
    const allowed = kindsFor(seat)
    const outside = input.kinds.find((kind) => !allowed.includes(kind))
    if (outside)
      throw new StoreError(
        403,
        "FORBIDDEN",
        `Tu rol en esta tienda no recibe «${PUSH_KIND_INFO[outside].label}»`,
      )
    const kinds = allowed.filter((kind) => input.kinds.includes(kind))
    await tx
      .insert(pushChoice)
      .values({ storeId, userId: person.userId, kinds })
      .onConflictDoUpdate({
        target: [pushChoice.storeId, pushChoice.userId],
        set: { kinds, updatedAt: sql`now()` },
      })
    return choicesIn(tx, storeId, person, seat)
  })
}

/* ------------------------------------------------------------------ el envío */

/** Lo que muestra el celular. `tag` hace que el siguiente del mismo tipo reemplace al anterior. */
export interface PushMessage {
  title: string
  body: string
  tag: string
  href: string
  icon: string
}

export interface PushDelivery {
  deviceId: string
  endpoint: string
  p256dh: string
  auth: string
  message: PushMessage
  /**
   * El `Topic` del servicio de push (RFC 8030): con el celular apagado, guarda solo el último de
   * cada tipo. Hasta 32 caracteres de base64url.
   */
  topic: string
  /** Cuánto lo guarda el servicio de push si el celular está apagado: un aviso viejo confunde. */
  ttlSeconds: number
  urgency: "high" | "normal"
}

/** El ícono de gestorIA (`apps/web/public/pwa/`): el logo de la tienda no tiene forma ni tamaño fijos. */
export const PUSH_ICON = "/pwa/gestoria-192.png"

const HOUR = 3600

/** Un paso de un pedido que puede avisarse, con lo que dice el aviso. */
export interface OrderStep {
  seq: number
  action: string
  actorUserId: string | null
  detail: Record<string, unknown>
  orderId: string
  number: number
  customerName: string
  totalCents: number
  state: string
}

/** Lo que se avisa de un paso de un pedido y de qué tipo es. */
export interface OrderPush {
  kind: PushKind
  title: string
  body: string
  ttlSeconds: number
  urgency: "high" | "normal"
}

/** Lo que se avisa de un paso de un pedido; null si ese paso no se avisa. */
export function orderPush(step: OrderStep, currency: string): OrderPush | null {
  const money = (cents: unknown) => formatMoney(typeof cents === "number" ? cents : 0, currency)
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback
  const who = step.customerName
  switch (step.action) {
    case "comprobante":
      return {
        kind: "pagos",
        title: `${who} envió su ${text(step.detail.medio, "pago")} de ${money(step.detail.monto)}`,
        body: `Ver y confirmar · Pedido ${pad(step.number)}`,
        ttlSeconds: 6 * HOUR,
        urgency: "high",
      }
    case "pago_link":
      // Un link que no coincide espera a una persona; uno que coincide ya está pagado: solo informa.
      if (step.detail.porRevisar)
        return {
          kind: "pagos",
          title: `El pago por link de ${who} no coincide`,
          body: `${money(step.detail.monto)} · Ver y revisar · Pedido ${pad(step.number)}`,
          ttlSeconds: 6 * HOUR,
          urgency: "high",
        }
      return {
        kind: "dinero",
        title: "Entró un pago por link",
        body: `${who}, ${money(step.detail.monto)} · Pedido ${pad(step.number)}`,
        ttlSeconds: 24 * HOUR,
        urgency: "normal",
      }
    case "no_entregado":
      return {
        kind: "no_entregado",
        title: `No se entregó el ${pad(step.number)} de ${who}`,
        body: `${text(step.detail.motivo, "Volvió sin entregar")} · vuelve a salir el ${text(step.detail.dia, "día elegido")}`,
        ttlSeconds: 6 * HOUR,
        urgency: "high",
      }
    case "creado":
      if (step.actorUserId !== SOFI_ACTOR) return null
      return {
        kind: "sofi_pedido",
        title: "Sofi armó un pedido",
        body: `${who} · ${money(step.totalCents)}${step.state === "por_pagar" ? " · por pagar" : ""}`,
        ttlSeconds: 6 * HOUR,
        urgency: "normal",
      }
    default:
      return null
  }
}

/** Lo que dice el aviso de los chats que esperan: el más nuevo, o cuántos si son varios. */
export function chatsPush(fresh: { customerName: string | null; reason: string | null }[]) {
  const [first] = fresh
  if (!first) return null
  if (fresh.length > 1)
    return { title: `${fresh.length} chats esperan a una persona`, body: "Abrir y atender" }
  return {
    title: `${first.customerName ?? "Un cliente"} pide hablar con una persona`,
    body: first.reason ?? "Abrir y atender",
  }
}

/**
 * El `Topic` de un tipo en una tienda: sin datos de la persona y dentro de lo que acepta el
 * servicio de push (32 caracteres de base64url).
 */
export function pushTopic(kind: PushKind | "listo", storeId: string): string {
  return `${kind.replace(/_/g, "-")}-${storeId.replace(/-/g, "").slice(0, 12)}`.slice(0, 32)
}

/** Los pasos de un pedido que avisan algo, para no leer los demás. */
const STEP_ACTIONS = ["comprobante", "pago_link", "no_entregado", "creado"]
/** Lo más que se lee de una tienda por vuelta: lo demás, en la siguiente. */
const STEPS_PER_ROUND = 500

/**
 * Lo que toca enviar ahora, en todas las tiendas con alguien que tenga un celular activado. Lo
 * anota en la misma transacción, antes de enviar: si el envío falla o queda en duda, no se
 * repite. La primera vez que mira a una persona en una tienda no avisa lo que ya estaba.
 */
export async function collectPushes(ownerDb: Db, now: Date = new Date()): Promise<PushDelivery[]> {
  return ownerDb.transaction(async (raw) => {
    const tx = raw as unknown as Db
    const devices = await tx.execute<{
      id: string
      userId: string
      endpoint: string
      p256dh: string
      auth: string
      welcomedAt: string | null
    }>(sql`select d.id, d.user_id as "userId", d.endpoint, d.p256dh, d.auth,
        d.welcomed_at::text as "welcomedAt"
      from push_device d join account_copy a on a.user_id = d.user_id and a.state = 'activa'
      order by d.created_at for update of d skip locked`)
    if (devices.length === 0) return []
    const users = [...new Set(devices.map((device) => device.userId))]
    const seats = await tx.execute<{
      storeId: string
      userId: string
      role: StoreSeat
      storeName: string
      currency: string
      hasChoice: boolean
      kinds: string[] | null
      lastEventSeq: string | null
      chatsSeen: string[] | null
    }>(sql`select m.store_id as "storeId", m.user_id as "userId", m.role, s.name as "storeName",
        s.currency, (c.store_id is not null) as "hasChoice", c.kinds,
        c.last_event_seq::text as "lastEventSeq", c.chats_seen as "chatsSeen"
      from store_member m join store s on s.id = m.store_id
        left join push_choice c on c.store_id = m.store_id and c.user_id = m.user_id
      where m.user_id in (${sql.join(
        users.map((user) => sql`${user}`),
        sql`, `,
      )})
      order by m.store_id`)
    const storesOf = new Map<string, number>()
    for (const seat of seats) storesOf.set(seat.userId, (storesOf.get(seat.userId) ?? 0) + 1)
    const devicesOf = (userId: string) => devices.filter((device) => device.userId === userId)
    const deliveries: PushDelivery[] = []
    const send = (
      userId: string,
      message: Omit<PushMessage, "icon">,
      topic: string,
      ttlSeconds: number,
      urgency: PushDelivery["urgency"],
    ) => {
      for (const device of devicesOf(userId))
        deliveries.push({
          deviceId: device.id,
          endpoint: device.endpoint,
          p256dh: device.p256dh,
          auth: device.auth,
          message: { ...message, icon: PUSH_ICON },
          topic,
          ttlSeconds,
          urgency,
        })
    }

    // «Listo»: una vez por celular, para que se vea que funciona.
    const fresh = devices.filter((device) => !device.welcomedAt)
    for (const device of fresh)
      deliveries.push({
        deviceId: device.id,
        endpoint: device.endpoint,
        p256dh: device.p256dh,
        auth: device.auth,
        message: {
          title: "Listo",
          body: "Los avisos de gestorIA llegarán a este celular.",
          tag: "listo",
          href: "/",
          icon: PUSH_ICON,
        },
        topic: "listo",
        ttlSeconds: HOUR,
        urgency: "normal",
      })
    if (fresh.length > 0)
      await tx
        .update(pushDevice)
        .set({ welcomedAt: now })
        .where(
          inArray(
            pushDevice.id,
            fresh.map((device) => device.id),
          ),
        )

    for (const seat of seats) {
      const waiting = await tx.execute<{
        id: string
        customerName: string | null
        reason: string | null
      }>(sql`select id, customer_name as "customerName", waiting_reason as reason
        from conversation
        where store_id = ${seat.storeId} and channel <> 'prueba' and handler = 'persona'
          and waiting_reason is not null
        order by updated_at desc limit 50`)
      const waitingIds = waiting.map((chat) => chat.id)
      const chatsArray = sql`${`{${waitingIds.join(",")}}`}::uuid[]`

      // La primera vez: desde aquí. Lo que ya estaba no se avisa. También si todos sus celulares
      // son nuevos: quien los apagó y vuelve a activarlos semanas después no recibe lo de antes,
      // porque mientras no tuvo ninguno el sistema no avanzó su cursor.
      const startsNow = devicesOf(seat.userId).every((device) => !device.welcomedAt)
      if (!seat.hasChoice || seat.lastEventSeq === null || startsNow) {
        await tx.execute(sql`insert into push_choice (store_id, user_id, last_event_seq, chats_seen)
          values (${seat.storeId}, ${seat.userId},
            (select coalesce(max(seq), 0) from order_event where store_id = ${seat.storeId}),
            ${chatsArray})
          on conflict (store_id, user_id) do update
            set last_event_seq = excluded.last_event_seq, chats_seen = excluded.chats_seen`)
        continue
      }

      const kinds = activeKinds(seat.role, seat.kinds)
      const where = (storesOf.get(seat.userId) ?? 0) > 1 ? ` · ${seat.storeName}` : ""
      const steps = await tx.execute<{
        seq: string
        action: string
        actorUserId: string | null
        detail: Record<string, unknown>
        orderId: string
        number: number
        customerName: string
        totalCents: number
        state: string
      }>(sql`select e.seq::text as seq, e.action, e.actor_user_id as "actorUserId", e.detail,
          o.id as "orderId", o.number, o.customer_name as "customerName",
          o.total_cents as "totalCents", o.state
        from order_event e join sale_order o on o.store_id = e.store_id and o.id = e.order_id
        where e.store_id = ${seat.storeId} and e.seq > ${seat.lastEventSeq}::bigint
          and e.action in (${sql.join(
            STEP_ACTIONS.map((action) => sql`${action}`),
            sql`, `,
          )})
          -- Los de «Probar a Sofi» no avisan.
          and not o.test
        order by e.seq limit ${STEPS_PER_ROUND}`)
      // Lo más nuevo de cada tipo: el siguiente del mismo tipo reemplaza al anterior.
      const latest = new Map<PushKind, OrderPush & { orderId: string }>()
      for (const step of steps) {
        // Lo que hizo la misma persona no se le avisa: ya lo sabe.
        if (step.actorUserId === seat.userId) continue
        const push = orderPush({ ...step, seq: Number(step.seq) }, seat.currency)
        if (push && kinds.has(push.kind)) latest.set(push.kind, { ...push, orderId: step.orderId })
      }
      for (const [kind, push] of latest)
        send(
          seat.userId,
          {
            title: push.title,
            body: `${push.body}${where}`,
            tag: `${kind}:${seat.storeId}`,
            href: `/tiendas/${seat.storeId}/pedidos?pedido=${push.orderId}`,
          },
          pushTopic(kind, seat.storeId),
          push.ttlSeconds,
          push.urgency,
        )

      // Los chats que esperan a una persona y no esperaban la vez anterior.
      const seen = new Set(seat.chatsSeen ?? [])
      const chats = chatsPush(
        waiting
          .filter((chat) => !seen.has(chat.id))
          .map((chat) => ({ customerName: chat.customerName, reason: chat.reason })),
      )
      if (chats && kinds.has("chats"))
        send(
          seat.userId,
          {
            ...chats,
            body: `${chats.body}${where}`,
            tag: `chats:${seat.storeId}`,
            // La Bandeja todavía no existe: abre la tienda.
            href: `/tiendas/${seat.storeId}`,
          },
          pushTopic("chats", seat.storeId),
          2 * HOUR,
          "high",
        )

      const lastSeq = steps.at(-1)?.seq ?? seat.lastEventSeq
      await tx
        .update(pushChoice)
        .set({
          lastEventSeq: sql`${lastSeq}::bigint`,
          chatsSeen: sql`${chatsArray}`,
        })
        .where(and(eq(pushChoice.storeId, seat.storeId), eq(pushChoice.userId, seat.userId)))
    }
    return deliveries
  })
}

/** Lo mínimo de un envío: dice si el celular ya no existe (el servicio respondió 404, 410 o 403). */
export interface PushSender {
  send(delivery: PushDelivery): Promise<{ gone: boolean }>
}

/** Las claves VAPID (RFC 8292) del servidor de gestorIA. Sin ellas no se ofrecen los avisos. */
export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** `mailto:` o `https:`: a quién escribir si un servicio de push tiene un problema. */
  subject: string
}

/** El envío real con las claves VAPID, cifrado para cada celular (RFC 8291). */
export function webPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(delivery) {
      try {
        await webpush.sendNotification(
          { endpoint: delivery.endpoint, keys: { p256dh: delivery.p256dh, auth: delivery.auth } },
          JSON.stringify(delivery.message),
          {
            TTL: delivery.ttlSeconds,
            urgency: delivery.urgency,
            topic: delivery.topic,
            vapidDetails: vapid,
            timeout: 10_000,
          },
        )
        return { gone: false }
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // 404/410: el celular ya no existe. 403: se suscribió con otras claves VAPID; olvidarlo
        // hace que Configuración lo muestre apagado y la persona lo vuelva a activar.
        if (status === 404 || status === 410 || status === 403) return { gone: true }
        throw error
      }
    },
  }
}

const PARALLEL_SENDS = 8

/**
 * Una vuelta de los avisos al celular: anota lo que toca y después lo envía, varios a la vez con
 * tope. Lo que falla no se reintenta (sigue en la pantalla); el celular que ya no existe se olvida.
 */
export async function runPushRound(ownerDb: Db, sender: PushSender, now: Date = new Date()) {
  const result = { sent: 0, gone: 0, uncertain: 0 }
  const deliveries = await collectPushes(ownerDb, now)
  const deliver = async (delivery: PushDelivery) => {
    try {
      const { gone } = await sender.send(delivery)
      if (gone) {
        await ownerDb.delete(pushDevice).where(eq(pushDevice.id, delivery.deviceId))
        result.gone += 1
      } else result.sent += 1
    } catch (error) {
      console.error("gestoria-api: un aviso al celular quedó en duda", error)
      result.uncertain += 1
    }
  }
  for (let start = 0; start < deliveries.length; start += PARALLEL_SENDS)
    await Promise.all(deliveries.slice(start, start + PARALLEL_SENDS).map(deliver))
  return result
}
