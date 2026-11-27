import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  accountCopy,
  type Db,
  type PaymentLinkMode,
  saleOrder,
  storeEvent,
  storePaymentLink,
  storePaymentLinkAttempt,
  storePaymentLinkTrial,
  storePaymentMethod,
} from "@gestoria/db"
import { and, count, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { fractionDigits } from "./dinero.js"
import type { LinkPayment } from "./link-de-pago.js"
import { type LinkDeps, linkNotificationURL, storeRow } from "./pedidos.js"
import { openSecret, sealSecret } from "./secretos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * La pasarela de la tienda en Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6; ADR
 * 0232): se conecta entrando a la cuenta de Mercado Pago (OAuth con PKCE), sin copiar llaves.
 * Empieza en modo prueba: un link de S/ 1 que se paga con la tarjeta de prueba y queda pagado solo,
 * como un pedido. «Cobrar de verdad» vuelve a pedir permiso con las credenciales reales. En modo
 * prueba ningún pedido se cobra por link y Sofi no lo ofrece: el modo queda guardado y cada pedido
 * lo dice.
 *
 * Las credenciales van cifradas (`secretos.ts`) y nunca vuelven al navegador. El token se renueva
 * solo antes de vencer (`renewPaymentLinks`). Si Mercado Pago avisa que la tienda quitó el permiso
 * (`mp-connect`), se comprueba con su API antes de creerlo.
 */

/** Lo que vale un intento de conectar: lo que vale el código de Mercado Pago. */
export const ATTEMPT_MINUTES = 10
/** Se renueva cuando le queda menos que esto (el token de Mercado Pago dura 180 días). */
export const RENEW_BEFORE_DAYS = 30

const base64url = (bytes: Buffer) => bytes.toString("base64url")
const sha256 = (text: string) => createHash("sha256").update(text).digest()

/** Cómo está la pasarela: si se puede usar, en qué modo, y la fila con sus credenciales. */
export async function linkStateIn(tx: Db, storeId: string, now = new Date()) {
  const [row] = await tx
    .select()
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  if (!row) return null
  const state: "conectada" | "vencida" | "sin_permiso" = row.revokedAt
    ? "sin_permiso"
    : row.expiresAt && row.expiresAt.getTime() <= now.getTime()
      ? "vencida"
      : "conectada"
  return { row, state, usable: state === "conectada", mode: row.mode }
}

/** Se cobran pedidos por link: conectada, al día y cobrando de verdad. */
export function chargesOrders(link: Awaited<ReturnType<typeof linkStateIn>>): boolean {
  return Boolean(link?.usable && link.mode === "real")
}

/**
 * Al cambiar o quitar la cuenta del link, los links ya creados de los pedidos por pagar dejan de
 * valer: eran de la otra cuenta, y sus pagos no se podrían leer. Se vuelve a crear uno.
 */
export async function forgetOpenLinks(tx: Db, storeId: string) {
  await tx
    .update(saleOrder)
    .set({ linkUrl: null, linkRef: null, linkExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.state, "por_pagar")))
}

/** Los links enviados que todavía se pueden pagar: al desconectar, ya no se confirmarán solos. */
async function openLinksIn(tx: Db, storeId: string, now: Date) {
  const [row] = await tx
    .select({ n: count() })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        eq(saleOrder.state, "por_pagar"),
        isNotNull(saleOrder.linkUrl),
        or(isNull(saleOrder.linkExpiresAt), gt(saleOrder.linkExpiresAt, now)),
      ),
    )
  return Number(row?.n ?? 0)
}

function unavailable(): StoreError {
  return new StoreError(
    409,
    "LINK_UNAVAILABLE",
    "Conectar Mercado Pago todavía no está disponible en gestorIA.",
  )
}

/** Lo que ve la pantalla: nunca el token, solo cómo está, el modo y la cuenta a medias. */
export async function paymentLinkStatus(
  appDb: Db,
  person: Person,
  storeId: string,
  deps: LinkDeps,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const link = await linkStateIn(tx, storeId, now)
    const [by] = link
      ? await tx
          .select({ name: accountCopy.name })
          .from(accountCopy)
          .where(eq(accountCopy.userId, link.row.connectedBy))
      : []
    const [trial] = link
      ? await tx
          .select({
            id: storePaymentLinkTrial.id,
            url: storePaymentLinkTrial.url,
            amountCents: storePaymentLinkTrial.amountCents,
            createdAt: storePaymentLinkTrial.createdAt,
            paidAt: storePaymentLinkTrial.paidAt,
            paidCents: storePaymentLinkTrial.paidCents,
          })
          .from(storePaymentLinkTrial)
          .where(
            and(
              eq(storePaymentLinkTrial.storeId, storeId),
              gt(storePaymentLinkTrial.createdAt, link.row.connectedAt),
            ),
          )
          .orderBy(desc(storePaymentLinkTrial.createdAt))
          .limit(1)
      : []
    const [method] = await tx
      .select({ id: storePaymentMethod.id, isActive: storePaymentMethod.isActive })
      .from(storePaymentMethod)
      .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.kind, "link")))
      .orderBy(desc(storePaymentMethod.isActive), storePaymentMethod.createdAt)
      .limit(1)
    return {
      available: Boolean(deps.secretsKey && deps.app),
      connection: link
        ? {
            provider: link.row.provider,
            state: link.state,
            mode: link.mode,
            account: link.row.accountLabel,
            connectedAt: link.row.connectedAt,
            connectedByName: by?.name ?? null,
            expiresAt: link.row.expiresAt,
          }
        : null,
      /** Los links enviados que se pueden pagar todavía (lo dice antes de desconectar). */
      openLinks: link ? await openLinksIn(tx, storeId, now) : 0,
      trial: trial ?? null,
      /** El medio «link» que Sofi ofrece (encendido o apagado), si lo hay. */
      method: method ?? null,
    }
  })
}

export const connectInput = z.object({ mode: z.enum(["prueba", "real"]).default("prueba") })

/**
 * Empieza a conectar: guarda el intento (su `state`, resumido, y el verificador de PKCE) y da la
 * dirección de Mercado Pago. El `state` lleva la tienda para volver a ella; solo vale una vez,
 * 10 minutos y para quien lo empezó.
 */
export async function startConnect(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof connectInput>,
  deps: LinkDeps,
  now = new Date(),
) {
  const app = deps.app
  if (!deps.secretsKey || !app) throw unavailable()
  const secret = base64url(randomBytes(32))
  const verifier = base64url(randomBytes(32))
  const state = `${storeId}.${secret}`
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await tx.insert(storePaymentLinkAttempt).values({
      stateHash: sha256(secret).toString("hex"),
      storeId,
      provider: "mercadopago",
      mode: input.mode,
      verifier,
      createdBy: person.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ATTEMPT_MINUTES * 60_000),
    })
  })
  return {
    url: deps.adapters.mercadopago.authorizeURL(app, state, base64url(sha256(verifier))),
  }
}

export const finishInput = z.object({
  state: z.string().trim().max(200),
  code: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_.-]+$/),
})

const STATE_FORMAT = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/

/**
 * Vuelve de Mercado Pago con su código: el intento tiene que ser de esta persona, estar vigente y
 * no usado. Se marca usado antes de cambiar el código (un código solo vale una vez). La llamada a
 * Mercado Pago va fuera de la transacción.
 */
export async function finishConnect(
  appDb: Db,
  person: Person,
  input: z.infer<typeof finishInput>,
  deps: LinkDeps,
  now = new Date(),
) {
  const app = deps.app
  const key = deps.secretsKey
  if (!key || !app) throw unavailable()
  const parts = STATE_FORMAT.exec(input.state)
  if (!parts)
    throw new StoreError(400, "LINK_STATE", "Ese regreso no es de gestorIA. Vuelve a conectar.")
  const storeId = parts[1]!
  const attempt = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .update(storePaymentLinkAttempt)
      .set({ usedAt: now })
      .where(
        and(
          eq(storePaymentLinkAttempt.stateHash, sha256(parts[2]!).toString("hex")),
          eq(storePaymentLinkAttempt.storeId, storeId),
          eq(storePaymentLinkAttempt.createdBy, person.userId),
          isNull(storePaymentLinkAttempt.usedAt),
          gt(storePaymentLinkAttempt.expiresAt, now),
        ),
      )
      .returning()
    return row ?? null
  })
  if (!attempt)
    throw new StoreError(
      409,
      "LINK_STATE",
      "El permiso venció o ya se usó (dura 10 minutos). Vuelve a tocar «Conectar con Mercado Pago».",
    )
  const adapter = deps.adapters[attempt.provider]
  const tokens = await adapter.exchange(app, {
    code: input.code,
    verifier: attempt.verifier,
    test: attempt.mode === "prueba",
  })
  const account = await adapter.account(tokens.accessToken)
  if (account === "sin_permiso")
    throw new StoreError(
      409,
      "LINK_PROVIDER",
      "Mercado Pago no reconoce esa cuenta. Vuelve a conectar.",
    )
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [before] = await tx
      .select({ providerUserId: storePaymentLink.providerUserId, mode: storePaymentLink.mode })
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    const values = {
      provider: attempt.provider,
      accessTokenEnc: sealSecret(key, storeId, tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? sealSecret(key, storeId, tokens.refreshToken) : null,
      expiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
      mode: attempt.mode,
      providerUserId: account.id,
      accountLabel: account.label,
      revokedAt: null,
      // La firma de los avisos era de la cuenta pegada a mano: con la cuenta conectada, el pago
      // se lee siempre de Mercado Pago.
      webhookSecretEnc: null,
      hint: tokens.accessToken.slice(-4),
      connectedBy: person.userId,
      connectedAt: now,
    }
    await tx
      .insert(storePaymentLink)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: storePaymentLink.storeId, set: values })
    if (!before || before.providerUserId !== account.id || before.mode !== attempt.mode)
      await forgetOpenLinks(tx, storeId)
    // Cobrando de verdad, Sofi ofrece el link: si la tienda no tenía su medio, se crea encendido.
    if (attempt.mode === "real") {
      const [method] = await tx
        .select({ id: storePaymentMethod.id })
        .from(storePaymentMethod)
        .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.kind, "link")))
      if (!method)
        await tx.insert(storePaymentMethod).values({
          storeId,
          kind: "link",
          name: "Link de pago (Yape o tarjeta)",
          typeCode: "68",
          collection: "link",
        })
    }
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: "Link de pago",
      detail: { conectado: attempt.provider, modo: attempt.mode },
    })
  })
  return { storeId, mode: attempt.mode as PaymentLinkMode }
}

export async function disconnectPaymentLink(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
      .returning({ provider: storePaymentLink.provider })
    if (!row) throw new StoreError(404, "NOT_FOUND", "El link de pago ya estaba desconectado")
    await forgetOpenLinks(tx, storeId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: "Link de pago",
      detail: { desconectado: row.provider },
    })
  })
}

/* ------------------------------------------------------------- el link de prueba de S/ 1 */

/** Lo que vale el link de prueba: una unidad de la moneda de la tienda (S/ 1). */
export function trialCents(currency: string): number {
  return 10 ** fractionDigits(currency)
}

/**
 * «Probar con S/ 1»: un link en la cuenta de la tienda, con las credenciales de prueba, que se paga
 * con la tarjeta de prueba. Solo en modo prueba (cobrando de verdad sería dinero real).
 */
export async function createTrialLink(
  appDb: Db,
  person: Person,
  storeId: string,
  deps: LinkDeps,
  now = new Date(),
) {
  const key = deps.secretsKey
  if (!key) throw unavailable()
  const prepared = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const link = await linkStateIn(tx, storeId, now)
    if (!link?.usable)
      throw new StoreError(409, "LINK_NOT_CONNECTED", "Primero conecta Mercado Pago.")
    if (link.mode !== "prueba")
      throw new StoreError(
        409,
        "LINK_REAL_MODE",
        "Ya cobras de verdad: el link de prueba es solo en modo prueba.",
      )
    const { name, currency } = await storeRow(tx, storeId)
    return {
      provider: link.row.provider,
      name,
      currency,
      token: openSecret(key, storeId, link.row.accessTokenEnc),
    }
  })
  const id = randomUUID()
  const amountCents = trialCents(prepared.currency)
  const created = await deps.adapters[prepared.provider].create(
    prepared.token,
    {
      id,
      reference: `prueba:${id}`,
      number: "prueba",
      title: `Prueba de gestorIA · ${prepared.name}`,
      storeName: prepared.name,
      totalCents: amountCents,
      currency: prepared.currency,
      expiresAt: null,
      notificationURL: linkNotificationURL(deps, storeId),
    },
    { test: true },
  )
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [trial] = await tx
      .insert(storePaymentLinkTrial)
      .values({
        id,
        storeId,
        provider: prepared.provider,
        amountCents,
        url: created.url,
        ref: created.ref,
        createdBy: person.userId,
      })
      .returning({
        id: storePaymentLinkTrial.id,
        url: storePaymentLinkTrial.url,
        amountCents: storePaymentLinkTrial.amountCents,
        createdAt: storePaymentLinkTrial.createdAt,
        paidAt: storePaymentLinkTrial.paidAt,
        paidCents: storePaymentLinkTrial.paidCents,
      })
    return trial!
  })
}

const TRIAL_REFERENCE = /^prueba:([0-9a-f-]{36})$/

/** El link es el de prueba de la tienda (su referencia), no un pedido. */
export function trialOf(reference: string | null): string | null {
  const match = reference ? TRIAL_REFERENCE.exec(reference) : null
  return match && z.uuid().safeParse(match[1]).success ? match[1]! : null
}

/**
 * El pago del link de prueba, ya leído del proveedor: queda pagado solo si está aprobado, por lo
 * que valía y en la moneda de la tienda. Lo anota el sistema (el dueño de la base).
 */
export async function receiveTrialPayment(
  ownerDb: Db,
  storeId: string,
  trialId: string,
  payment: LinkPayment,
) {
  if (!payment.approved) return
  const { currency } = await storeRow(ownerDb, storeId)
  if (payment.currency !== currency) return
  await ownerDb
    .update(storePaymentLinkTrial)
    .set({ paidAt: new Date(), paidCents: payment.amountCents, paymentRef: payment.ref })
    .where(
      and(
        eq(storePaymentLinkTrial.id, trialId),
        eq(storePaymentLinkTrial.storeId, storeId),
        isNull(storePaymentLinkTrial.paidAt),
        eq(storePaymentLinkTrial.amountCents, payment.amountCents),
      ),
    )
}

/* -------------------------------------------------- el aviso de Mercado Pago y la renovación */

const connectNotice = z.object({
  type: z.literal("mp-connect"),
  action: z.string(),
  user_id: z.union([z.number(), z.string()]).transform(String),
})

/**
 * El aviso `mp-connect` de Mercado Pago: una cuenta desvinculó la aplicación. No se cree por lo
 * que dice: se pregunta a Mercado Pago con el token de cada tienda de esa cuenta, y solo si ya no
 * lo reconoce queda «sin permiso». Siempre responde lo mismo: el aviso no cuenta qué tiendas hay.
 */
/** Cada cuenta de Mercado Pago se mira a lo más una vez por minuto: un aviso inventado no la gasta. */
const connectSeen = new Map<string, number>()

export async function receiveConnectNotice(
  ownerDb: Db,
  body: string,
  deps: LinkDeps,
  now = Date.now(),
) {
  const key = deps.secretsKey
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return
  }
  const notice = connectNotice.safeParse(raw)
  if (!key || !notice.success || notice.data.action !== "application.deauthorized") return
  const last = connectSeen.get(notice.data.user_id)
  if (last !== undefined && now - last < 60_000) return
  if (connectSeen.size > 10_000) connectSeen.clear()
  connectSeen.set(notice.data.user_id, now)
  const rows = await ownerDb
    .select()
    .from(storePaymentLink)
    .where(
      and(
        eq(storePaymentLink.provider, "mercadopago"),
        eq(storePaymentLink.providerUserId, notice.data.user_id),
        isNull(storePaymentLink.revokedAt),
      ),
    )
  for (const row of rows) {
    // Si Mercado Pago no responde, esa tienda queda como estaba y se sigue con las demás: el aviso
    // responde igual (no cuenta qué tiendas hay) y la próxima vez que se use el token se sabrá.
    const seen = await deps.adapters[row.provider]
      .account(openSecret(key, row.storeId, row.accessTokenEnc))
      .catch(() => null)
    if (seen !== "sin_permiso") continue
    await ownerDb.transaction(async (tx) => {
      await tx
        .update(storePaymentLink)
        .set({ revokedAt: new Date() })
        .where(eq(storePaymentLink.storeId, row.storeId))
      await forgetOpenLinks(tx as unknown as Db, row.storeId)
      await tx.insert(storeEvent).values({
        storeId: row.storeId,
        actorUserId: null,
        action: "configuracion.pago",
        subject: "Link de pago",
        detail: { sinPermiso: row.provider },
      })
    })
  }
}

/**
 * Renueva el token de las tiendas al que le quedan menos de 30 días, con su `refresh_token` (el
 * proveedor da otro cada vez). Lo que no se pudo renovar se intenta en la vuelta siguiente; si
 * llega a vencer, la pantalla pide volver a conectar.
 */
export async function renewPaymentLinks(ownerDb: Db, deps: LinkDeps, now = new Date()) {
  const key = deps.secretsKey
  const app = deps.app
  if (!key || !app) return { renewed: 0, failed: 0 }
  // Los intentos de conectar que ya vencieron no sirven: se borran.
  await ownerDb
    .delete(storePaymentLinkAttempt)
    .where(lt(storePaymentLinkAttempt.expiresAt, new Date(now.getTime() - 86_400_000)))
  const rows = await ownerDb
    .select()
    .from(storePaymentLink)
    .where(
      and(
        isNotNull(storePaymentLink.refreshTokenEnc),
        isNull(storePaymentLink.revokedAt),
        lt(storePaymentLink.expiresAt, new Date(now.getTime() + RENEW_BEFORE_DAYS * 86_400_000)),
        gt(storePaymentLink.expiresAt, now),
      ),
    )
  let renewed = 0
  let failed = 0
  for (const row of rows) {
    try {
      const tokens = await deps.adapters[row.provider].refresh(
        app,
        openSecret(key, row.storeId, row.refreshTokenEnc!),
        row.mode === "prueba",
      )
      const saved = await ownerDb
        .update(storePaymentLink)
        .set({
          accessTokenEnc: sealSecret(key, row.storeId, tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken
            ? sealSecret(key, row.storeId, tokens.refreshToken)
            : row.refreshTokenEnc,
          expiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
          hint: tokens.accessToken.slice(-4),
        })
        // Si otra persona la cambió entre medio, vale lo de ella.
        .where(
          and(
            eq(storePaymentLink.storeId, row.storeId),
            eq(storePaymentLink.accessTokenEnc, row.accessTokenEnc),
          ),
        )
        .returning({ storeId: storePaymentLink.storeId })
      if (saved.length > 0) renewed++
      else failed++
    } catch {
      failed++
    }
  }
  return { renewed, failed }
}
