import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  accountCopy,
  type Db,
  type PaymentLinkMode,
  type PaymentLinkProvider,
  saleOrder,
  storeEvent,
  storePaymentLink,
  storePaymentLinkAttempt,
  storePaymentLinkTrial,
  storePaymentMethod,
} from "@gestoria/db"
import { and, count, desc, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { fractionDigits } from "./dinero.js"
import type { LinkPayment } from "./link-de-pago.js"
import { type LinkDeps, linkNotificationURL, storeRow, withLinkToken } from "./pedidos.js"
import { openSecret, sealSecret } from "./secretos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * La pasarela de la tienda en Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6; ADR
 * 0232), con dos puertas: entrando a la cuenta de Mercado Pago con la aplicación de gestorIA (OAuth
 * con PKCE), o con las claves de la tienda, el Access Token de su propia aplicación en Mercado Pago
 * Developers, que pega en Cobros (así no depende de la aplicación de gestorIA). Empieza en modo prueba: un link de S/ 1 que se paga con la tarjeta de prueba y queda pagado solo,
 * como un pedido. «Cobrar de verdad» vuelve a pedir permiso con las credenciales reales. En modo
 * prueba ningún pedido se cobra por link y Sofi no lo ofrece: el modo queda guardado y cada pedido
 * lo dice.
 *
 * Las credenciales van cifradas (`secretos.ts`) y nunca vuelven al navegador. El token de la cuenta
 * se renueva solo antes de vencer (`renewPaymentLinks`); el de las claves no vence y se revisa una
 * vez al día (`checkKeyLinks`). Si Mercado Pago avisa que la tienda quitó el permiso (`mp-connect`),
 * se comprueba con su API antes de creerlo; si deja de reconocer el token al usarlo, queda «sin
 * permiso» (`revokeLinkIn`).
 */

/** Lo que vale un intento de conectar: lo que vale el código de Mercado Pago. */
export const ATTEMPT_MINUTES = 10
/** Se renueva cuando le queda menos que esto (el token de Mercado Pago dura 180 días). */
export const RENEW_BEFORE_DAYS = 30

const base64url = (bytes: Buffer) => bytes.toString("base64url")
const sha256 = (text: string) => createHash("sha256").update(text).digest()

/** Cómo está la pasarela: si se puede usar, en qué modo, y la fila con sus credenciales. */
export async function linkStateIn(tx: Db, storeId: string, now = new Date()) {
  // Sin las credenciales cifradas: esto se lee en cada pedido y en cada turno de Sofi.
  const [row] = await tx
    .select({
      provider: storePaymentLink.provider,
      mode: storePaymentLink.mode,
      revokedAt: storePaymentLink.revokedAt,
      expiresAt: storePaymentLink.expiresAt,
      accountLabel: storePaymentLink.accountLabel,
      connectedWith: storePaymentLink.connectedWith,
      connectedBy: storePaymentLink.connectedBy,
      connectedAt: storePaymentLink.connectedAt,
    })
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

/** El token cifrado de la pasarela, solo donde se usa (crear un link). */
export async function linkTokenIn(tx: Db, storeId: string): Promise<string> {
  const [row] = await tx
    .select({ token: storePaymentLink.accessTokenEnc })
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  if (!row) throw new StoreError(409, "LINK_NOT_CONNECTED", "Primero conecta Mercado Pago.")
  return row.token
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

/** Entrar a la cuenta necesita la aplicación de gestorIA en Mercado Pago; las claves, no. */
function accountDoorClosed(): StoreError {
  return new StoreError(
    409,
    "LINK_ACCOUNT_UNAVAILABLE",
    "Conecta Mercado Pago con tus claves: toca «Conectar con mis claves» en Cobros.",
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
          .select(trialColumns)
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
      /** Se puede conectar: con las claves de la tienda, siempre que haya con qué cifrarlas. */
      available: Boolean(deps.secretsKey),
      /** También entrando a la cuenta: con la aplicación de gestorIA en Mercado Pago. */
      accountDoor: Boolean(deps.secretsKey && deps.app),
      connection: link
        ? {
            provider: link.row.provider,
            via: link.row.connectedWith,
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
  if (!deps.secretsKey) throw unavailable()
  if (!app) throw accountDoorClosed()
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
  if (!key) throw unavailable()
  if (!app) throw accountDoorClosed()
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
    await saveConnection(tx, person, storeId, {
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
      connectedWith: "cuenta",
      checkedAt: now,
      connectedBy: person.userId,
      connectedAt: now,
    })
  })
  return { storeId, mode: attempt.mode as PaymentLinkMode }
}

/**
 * Guarda la conexión (con la cuenta o con las claves): los links abiertos de otra cuenta o de otro
 * modo se olvidan, cobrando de verdad la tienda tiene su medio «link» para Sofi, y queda anotado.
 */
async function saveConnection(
  tx: Db,
  person: Person,
  storeId: string,
  values: Omit<typeof storePaymentLink.$inferInsert, "storeId">,
) {
  const [before] = await tx
    .select({ providerUserId: storePaymentLink.providerUserId, mode: storePaymentLink.mode })
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  await tx
    .insert(storePaymentLink)
    .values({ storeId, ...values })
    .onConflictDoUpdate({ target: storePaymentLink.storeId, set: values })
  if (!before || before.providerUserId !== values.providerUserId || before.mode !== values.mode)
    await forgetOpenLinks(tx, storeId)
  // Cobrando de verdad, Sofi ofrece el link: si la tienda no tenía su medio, se crea encendido.
  if (values.mode === "real") {
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
    detail: { conectado: values.provider, modo: values.mode, con: values.connectedWith },
  })
}

/* ------------------------------------------------------- con las claves de la tienda */

/**
 * Lo que se pega es el Access Token de la aplicación de la tienda en Mercado Pago Developers
 * («Credenciales»: el de «Prueba» para probar y el de «Producción» para cobrar de verdad). Hoy los
 * dos empiezan con `APP_USR-`; los de prueba de antes, con `TEST-`.
 */
const ACCESS_TOKEN = /^(APP_USR|TEST)-[A-Za-z0-9_-]{20,250}$/
/** La Public Key: el mismo prefijo y un UUID (va en el navegador, no sirve para cobrar). */
const PUBLIC_KEY = /^(APP_USR|TEST)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** El Client Secret (32 letras y números) y el Client ID (solo números): de la otra puerta. */
const CLIENT_SECRET = /^[A-Za-z0-9]{32}$/
const CLIENT_ID = /^\d{6,20}$/

export const keysInput = z.object({
  mode: z.enum(["prueba", "real"]),
  accessToken: z.string().trim().max(400),
})

const tokenError = (message: string) =>
  new StoreError(400, "LINK_KEYS", message, { accessToken: message })

/** Lo que se ve mal en lo pegado, antes de preguntar a Mercado Pago. */
export function keysProblem(token: string, mode: PaymentLinkMode): string | null {
  const what = mode === "prueba" ? "de prueba" : "de producción"
  if (!token) return `Pega aquí el Access Token ${what}.`
  if (PUBLIC_KEY.test(token))
    return "Esa es la «Public Key». Copia la otra clave, la que dice «Access Token»."
  if (CLIENT_SECRET.test(token) || CLIENT_ID.test(token))
    return "Ese es el «Client ID» o el «Client Secret». Copia la clave que dice «Access Token»."
  if (!ACCESS_TOKEN.test(token))
    return "Eso no parece un Access Token: empieza con APP_USR- y es largo. Cópialo de nuevo, entero."
  if (mode === "real" && token.startsWith("TEST-"))
    return "Ese es el Access Token de prueba. Para cobrar de verdad, copia el de «Producción»."
  return null
}

/** Probar claves llama a Mercado Pago: a lo más 10 veces por minuto en cada tienda. */
const keysTried = new Map<string, { since: number; count: number }>()
function tryBudget(storeId: string, now: number) {
  const seen = keysTried.get(storeId)
  if (!seen || now - seen.since > 60_000) {
    if (keysTried.size > 10_000) keysTried.clear()
    keysTried.set(storeId, { since: now, count: 1 })
  } else if (++seen.count > 10)
    throw new StoreError(429, "TOO_MANY", "Probaste muchas veces seguidas. Espera un minuto.")
}

/**
 * Revisa las claves con Mercado Pago: que reconozca el token (`/users/me`), de qué cuenta es y que
 * sea del modo pedido hasta donde se puede saber. Mercado Pago no lo dice en el token: un `TEST-` o
 * una cuenta que marca de prueba no van donde va el de producción. No se rechaza el mismo token con
 * el que ya prueba la tienda: si pegó el de producción para probar, no tendría cómo seguir.
 */
async function verifyKeys(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof keysInput>,
  deps: LinkDeps,
  now: Date,
) {
  const key = deps.secretsKey
  if (!key) throw unavailable()
  // Primero el permiso: quien no conecta no usa esto para preguntar por tokens.
  await inStore(appDb, person, storeId, "configuracion", async () => {})
  const problem = keysProblem(input.accessToken, input.mode)
  if (problem) throw tokenError(problem)
  tryBudget(storeId, now.getTime())
  const account = await deps.adapters.mercadopago.account(input.accessToken)
  if (account === "sin_permiso")
    throw tokenError(
      "Mercado Pago no reconoce ese Access Token. Cópialo de nuevo desde «Credenciales», entero.",
    )
  if (input.mode === "real" && account.test)
    throw tokenError(
      "Ese es de una cuenta de prueba. Para cobrar de verdad, copia el Access Token de «Producción».",
    )
  return { key, account }
}

/** «Probar»: dice si las claves sirven y de qué cuenta son, sin guardar nada. */
export async function tryKeys(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof keysInput>,
  deps: LinkDeps,
  now = new Date(),
) {
  const { account } = await verifyKeys(appDb, person, storeId, input, deps, now)
  return { account: account.label }
}

/**
 * Conecta con las claves de la tienda: las revisa otra vez y las guarda cifradas. No vence ni se
 * renueva (no hay `refresh_token`); empieza en prueba y «Cobrar de verdad» pide el de producción.
 */
export async function connectWithKeys(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof keysInput>,
  deps: LinkDeps,
  now = new Date(),
) {
  const { key, account } = await verifyKeys(appDb, person, storeId, input, deps, now)
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await saveConnection(tx, person, storeId, {
      provider: "mercadopago",
      accessTokenEnc: sealSecret(key, storeId, input.accessToken),
      refreshTokenEnc: null,
      expiresAt: null,
      mode: input.mode,
      providerUserId: account.id,
      accountLabel: account.label,
      revokedAt: null,
      // El pago se lee siempre de Mercado Pago: no hace falta la clave de los avisos.
      webhookSecretEnc: null,
      hint: input.accessToken.slice(-4),
      connectedWith: "claves",
      checkedAt: now,
      connectedBy: person.userId,
      connectedAt: now,
    })
  })
  return { storeId, mode: input.mode, account: account.label }
}

/**
 * La cuenta de la demo (semilla de Calzados Rosa): su token es inventado, así que nunca se revisa ni
 * queda «sin permiso» (la demo se vería rota).
 */
export const DEMO_PROVIDER_USER = "semilla"
const notDemo = or(
  isNull(storePaymentLink.providerUserId),
  ne(storePaymentLink.providerUserId, DEMO_PROVIDER_USER),
)

/**
 * De qué cuenta es el token guardado de una tienda, según el proveedor; null si no se pudo saber
 * (no responde, o el token no se puede abrir): quien pregunta no decide nada con eso.
 */
async function accountOf(
  deps: LinkDeps,
  key: Buffer,
  row: { storeId: string; provider: PaymentLinkProvider; accessTokenEnc: string },
) {
  try {
    return await deps.adapters[row.provider].account(
      openSecret(key, row.storeId, row.accessTokenEnc),
    )
  } catch {
    return null
  }
}

/**
 * Mercado Pago respondió que no reconoce el token al usarlo (crear un link, leer un pago): antes de
 * creerlo se le pregunta de qué cuenta es (`/users/me`), porque un aviso con el pago de otra cuenta
 * también puede dar 401. Solo si tampoco lo reconoce ahí, la pasarela queda «sin permiso» y los
 * links abiertos se olvidan. Lo anota el sistema (el dueño de la base), y solo si el token sigue
 * siendo ese: si la tienda volvió a conectar entre medio, vale lo nuevo. `confirmed`: ya se preguntó.
 */
export async function revokeLinkIn(
  ownerDb: Db,
  deps: LinkDeps,
  storeId: string,
  accessTokenEnc: string,
  confirmed = false,
) {
  const key = deps.secretsKey
  if (!key) return
  if (
    !confirmed &&
    (await accountOf(deps, key, { storeId, provider: "mercadopago", accessTokenEnc })) !==
      "sin_permiso"
  )
    return
  await ownerDb.transaction(async (tx) => {
    const [row] = await tx
      .update(storePaymentLink)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(storePaymentLink.storeId, storeId),
          eq(storePaymentLink.accessTokenEnc, accessTokenEnc),
          isNull(storePaymentLink.revokedAt),
          notDemo,
        ),
      )
      .returning({ provider: storePaymentLink.provider })
    if (!row) return
    await forgetOpenLinks(tx as unknown as Db, storeId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: null,
      action: "configuracion.pago",
      subject: "Link de pago",
      detail: { sinPermiso: row.provider },
    })
  })
}

/** Cada cuánto se pregunta a Mercado Pago si sigue reconociendo las claves pegadas. */
export const CHECK_KEYS_HOURS = 24

/**
 * Las claves no vencen, pero la tienda puede cambiarlas o borrar su aplicación en su panel: una vez
 * al día se pregunta a Mercado Pago (`/users/me`) si las sigue reconociendo. Si no, «sin permiso».
 * Si no responde, se intenta en la vuelta siguiente.
 */
export async function checkKeyLinks(ownerDb: Db, deps: LinkDeps, now = new Date()) {
  const key = deps.secretsKey
  if (!key) return { checked: 0, revoked: 0 }
  const rows = await ownerDb
    .select({
      storeId: storePaymentLink.storeId,
      provider: storePaymentLink.provider,
      accessTokenEnc: storePaymentLink.accessTokenEnc,
    })
    .from(storePaymentLink)
    .where(
      and(
        eq(storePaymentLink.connectedWith, "claves"),
        isNull(storePaymentLink.revokedAt),
        notDemo,
        or(
          isNull(storePaymentLink.checkedAt),
          lt(storePaymentLink.checkedAt, new Date(now.getTime() - CHECK_KEYS_HOURS * 3_600_000)),
        ),
      ),
    )
  let checked = 0
  let revoked = 0
  for (const row of rows) {
    // Un token que no se puede leer o un Mercado Pago que no responde no frena a las demás tiendas:
    // esa se intenta en la vuelta siguiente.
    const known = await accountOf(deps, key, row)
    if (known === null) continue
    checked++
    if (known === "sin_permiso") {
      await revokeLinkIn(ownerDb, deps, row.storeId, row.accessTokenEnc, true)
      revoked++
    } else
      await ownerDb
        .update(storePaymentLink)
        .set({ checkedAt: now })
        .where(
          and(
            eq(storePaymentLink.storeId, row.storeId),
            eq(storePaymentLink.accessTokenEnc, row.accessTokenEnc),
          ),
        )
  }
  return { checked, revoked }
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

/** Cuánto vale reusar el link de prueba sin pagar: lo mismo que la pantalla espera su pago. */
export const TRIAL_REUSE_MS = 15 * 60_000

const trialColumns = {
  id: storePaymentLinkTrial.id,
  url: storePaymentLinkTrial.url,
  amountCents: storePaymentLinkTrial.amountCents,
  createdAt: storePaymentLinkTrial.createdAt,
  paidAt: storePaymentLinkTrial.paidAt,
  paidCents: storePaymentLinkTrial.paidCents,
}

/**
 * «Probar con S/ 1»: un link en la cuenta de la tienda, con las credenciales de prueba, que se paga
 * con la tarjeta de prueba. Solo en modo prueba (cobrando de verdad sería dinero real).
 *
 * Crear un link en Mercado Pago es un efecto de afuera: un doble toque o volver a tocar mientras se
 * espera el pago no crea otro. Si hay uno sin pagar de los últimos 15 minutos (de esta conexión), se
 * devuelve ese. El candado de la tienda se tiene mientras se crea, así dos pedidos a la vez esperan
 * su turno y el segundo encuentra el link del primero (la llamada tiene su tiempo límite).
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
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`link-de-prueba:${storeId}`}))`)
    const link = await linkStateIn(tx, storeId, now)
    if (!link?.usable)
      throw new StoreError(409, "LINK_NOT_CONNECTED", "Primero conecta Mercado Pago.")
    if (link.mode !== "prueba")
      throw new StoreError(
        409,
        "LINK_REAL_MODE",
        "Ya cobras de verdad: el link de prueba es solo en modo prueba.",
      )
    const [open] = await tx
      .select(trialColumns)
      .from(storePaymentLinkTrial)
      .where(
        and(
          eq(storePaymentLinkTrial.storeId, storeId),
          isNull(storePaymentLinkTrial.paidAt),
          gt(storePaymentLinkTrial.createdAt, link.row.connectedAt),
          gt(storePaymentLinkTrial.createdAt, new Date(now.getTime() - TRIAL_REUSE_MS)),
        ),
      )
      .orderBy(desc(storePaymentLinkTrial.createdAt))
      .limit(1)
    if (open) return open
    const { name, currency } = await storeRow(tx, storeId)
    const sealed = await linkTokenIn(tx, storeId)
    const token = openSecret(key, storeId, sealed)
    const id = randomUUID()
    const amountCents = trialCents(currency)
    const created = await withLinkToken(deps, storeId, sealed, () =>
      deps.adapters[link.row.provider].create(
        token,
        {
          id,
          reference: `prueba:${id}`,
          number: "prueba",
          title: `Prueba de gestorIA · ${name}`,
          storeName: name,
          totalCents: amountCents,
          currency,
          expiresAt: null,
          notificationURL: linkNotificationURL(deps, storeId),
        },
        { test: true },
      ),
    )
    const [trial] = await tx
      .insert(storePaymentLinkTrial)
      .values({
        id,
        storeId,
        provider: link.row.provider,
        amountCents,
        url: created.url,
        ref: created.ref,
        createdBy: person.userId,
      })
      .returning(trialColumns)
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

/**
 * Cada cuenta de Mercado Pago se mira a lo más 5 veces por minuto: avisos inventados no gastan la
 * cuenta ni tapan el aviso de verdad (que llega igual, y Mercado Pago lo reintenta).
 */
const connectSeen = new Map<string, { since: number; count: number }>()

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
  const seen = connectSeen.get(notice.data.user_id)
  if (!seen || now - seen.since > 60_000) {
    if (connectSeen.size > 10_000) connectSeen.clear()
    connectSeen.set(notice.data.user_id, { since: now, count: 1 })
  } else if (++seen.count > 5) return
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
    if ((await accountOf(deps, key, row)) !== "sin_permiso") continue
    await revokeLinkIn(ownerDb, deps, row.storeId, row.accessTokenEnc, true)
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
