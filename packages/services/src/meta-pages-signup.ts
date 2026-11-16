import {
  buildInstagramLoginUrl,
  buildPagesLoginUrl,
  completeInstagramLoginCode,
  type InstagramLoginApp,
  subscribeAppToInstagram,
  exchangePagesCode,
  listSharedPages,
  type MetaPlatformApp,
  type SharedPage,
  subscribeAppToPage,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { channelConnection, type ConnectionSignup } from "@odentia/db/schema/crm"
import { mailboxOauthState } from "@odentia/db/schema/mailbox"
import { canAccess } from "@odentia/auth/permissions"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { randomBytes } from "node:crypto"
import { SIGNUP_TOKEN_DEAD } from "./connections.js"
import { isUniqueViolation, ServiceError } from "./errors.js"
import { buildOauthStateParam, parseOauthStateParam } from "./mailbox.js"
import { decryptConfig, encryptJson } from "./secrets.js"
import { upsertWorkspaceNotification } from "./workspace.js"

/**
 * «Conectar con Facebook» de Messenger e Instagram (ADR 0195): por redirección,
 * como Gmail, sin la página del panel que necesita WhatsApp. La clínica marca
 * en la ventana de Facebook sus páginas; cada página es una conexión de
 * Messenger y, si tiene un Instagram de empresa unido, otra de Instagram. Varias
 * cuentas por canal, como varios buzones de correo: solo WhatsApp tiene una.
 *
 * Los avisos de las páginas llegan a la dirección de la app de odentIA
 * (`/api/webhooks/meta/pages`), firmados con su clave: estas conexiones no
 * guardan clave secreta. La clave de cada página no vence mientras la persona la
 * siga administrando: la vuelta diaria la revisa.
 *
 * Sin probar contra Meta real: falta que Meta apruebe los permisos de páginas.
 */

/** La app de odentIA con la configuración de páginas y la vuelta fija de la API. */
export interface MetaPagesApp extends MetaPlatformApp {
  configId: string
  redirectUri: string
}

const STATE_TTL_MS = 10 * 60 * 1000
const PROVIDER = "meta_pages"
const IG_PROVIDER = "instagram_login"

/** Empieza: guarda el state de un solo uso (10 minutos) y devuelve la ventana de Facebook. */
export async function beginMetaPagesLogin(
  tx: Db,
  orgId: string,
  userId: string,
  secretsKey: Buffer,
  app: MetaPagesApp,
): Promise<{ url: string }> {
  const nonce = randomBytes(32).toString("hex")
  await tx.insert(mailboxOauthState).values({
    nonce,
    organizationId: orgId,
    userId,
    provider: PROVIDER,
    // Facebook Login no usa PKCE en este flujo: la tabla lo pide, no se manda.
    codeVerifier: randomBytes(32).toString("base64url"),
    redirectUri: app.redirectUri,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  })
  const state = buildOauthStateParam(secretsKey, nonce)
  return { url: buildPagesLoginUrl(app, { configId: app.configId, redirectUri: app.redirectUri, state }) }
}

/** Lo que se conectó, para decirlo al volver. */
export interface MetaPagesResult {
  orgId: string
  messenger: string[]
  instagram: string[]
  /** Páginas sin un Instagram de empresa unido: Messenger sí, Instagram no. */
  withoutInstagram: string[]
  /** Cuentas que ya están activas en otra clínica: no se tocan. */
  elsewhere: string[]
}

/**
 * Lo que pasa al volver de Facebook: con una sola página marcada se conecta;
 * con varias, se guardan 10 minutos y la clínica elige una en odentIA, para no
 * conectar por error páginas que no son de la clínica.
 */
export type MetaPagesReturn = ({ kind: "connected" } & MetaPagesResult) | { kind: "choose"; orgId: string; pick: string }

async function consumeState(ownerDb: Db, secretsKey: Buffer, state: string) {
  const nonce = parseOauthStateParam(secretsKey, state)
  if (!nonce) throw new ServiceError("FORBIDDEN", 403, "La vuelta de Facebook no es válida. Vuelve a intentarlo.")
  // Consumido al leerlo, en un solo paso: dos vueltas con el mismo state no pasan las dos.
  const [pending] = await ownerDb.delete(mailboxOauthState).where(eq(mailboxOauthState.nonce, nonce)).returning()
  if (!pending || pending.provider !== PROVIDER || pending.payloadEncrypted) {
    throw new ServiceError("FORBIDDEN", 403, "La conexión con Facebook venció o ya se usó. Vuelve a intentarlo.")
  }
  if (pending.expiresAt.getTime() < Date.now()) {
    throw new ServiceError("FORBIDDEN", 403, "Pasaron más de 10 minutos. Vuelve a intentarlo.")
  }
  return pending
}

/** La misma regla que al empezar: conecta quien administra la configuración. */
async function requireSettingsWriter(ownerDb: Db, orgId: string, userId: string): Promise<void> {
  const [membership] = await ownerDb
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!membership || !canAccess(membership.role, "settings.write")) {
    throw new ServiceError("FORBIDDEN", 403, "Conecta los canales quien administra la clínica.")
  }
}

/**
 * Termina la vuelta de Facebook: comprueba el state (firma, un solo uso, 10
 * minutos, la misma persona, que administre la configuración), canjea el código
 * y lee las páginas marcadas. Una sola: se conecta con su Instagram. Varias: se
 * guardan cifradas para elegir una (`chooseMetaPage`).
 */
export async function completeMetaPagesLogin(
  ownerDb: Db,
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  app: MetaPagesApp,
  deps: { fetch: typeof fetch },
  input: { state: string; code: string; userId: string },
): Promise<MetaPagesReturn> {
  const pending = await consumeState(ownerDb, secretsKey, input.state)
  if (pending.userId !== input.userId) throw new ServiceError("FORBIDDEN", 403, "Esta conexión la empezó otra persona.")
  await requireSettingsWriter(ownerDb, pending.organizationId, input.userId)
  const userToken = await exchangePagesCode(app, { code: input.code, redirectUri: pending.redirectUri }, deps)
  const pages = await listSharedPages(app, userToken, deps)
  if (pages.length === 0) {
    throw new ServiceError("NO_PAGES", 400, "No marcaste ninguna página en Facebook. Vuelve a intentarlo y marca la de la clínica.")
  }
  const orgId = pending.organizationId
  if (pages.length === 1) {
    return { kind: "connected", ...(await connectPages(withOrgContext, secretsKey, app, deps, orgId, pages, true)) }
  }
  // Las elecciones vencidas no se guardan: llevan claves de página que no vencen.
  await ownerDb
    .delete(mailboxOauthState)
    .where(and(inArray(mailboxOauthState.provider, [PROVIDER, IG_PROVIDER]), lt(mailboxOauthState.expiresAt, new Date())))
  const pick = randomBytes(32).toString("hex")
  await ownerDb.insert(mailboxOauthState).values({
    nonce: pick,
    organizationId: orgId,
    userId: input.userId,
    provider: PROVIDER,
    codeVerifier: randomBytes(32).toString("base64url"),
    redirectUri: pending.redirectUri,
    payloadEncrypted: encryptJson(secretsKey, { pages }),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  })
  return { kind: "choose", orgId, pick }
}

/** Una página para elegir, sin su clave. */
export interface PageChoice {
  id: string
  name: string
  /** El Instagram de empresa unido, si tiene. */
  instagram: string | null
}

const PICK_GONE = "La elección venció. Vuelve a conectar con Facebook."

async function readPick(ownerDb: Db, secretsKey: Buffer, input: { pick: string; userId: string; orgId: string }): Promise<SharedPage[]> {
  if (!/^[0-9a-f]{64}$/.test(input.pick)) throw new ServiceError("FORBIDDEN", 403, PICK_GONE)
  const [row] = await ownerDb.select().from(mailboxOauthState).where(eq(mailboxOauthState.nonce, input.pick)).limit(1)
  if (
    !row?.payloadEncrypted ||
    row.provider !== PROVIDER ||
    row.userId !== input.userId ||
    row.organizationId !== input.orgId ||
    row.expiresAt.getTime() < Date.now()
  ) {
    // Vencida: se borra al verla, con sus claves.
    if (row && row.expiresAt.getTime() < Date.now()) await ownerDb.delete(mailboxOauthState).where(eq(mailboxOauthState.nonce, row.nonce))
    throw new ServiceError("FORBIDDEN", 403, PICK_GONE)
  }
  const pages = decryptConfig(secretsKey, row.payloadEncrypted)["pages"]
  return Array.isArray(pages) ? (pages as SharedPage[]) : []
}

const instagramName = (page: SharedPage): string | null =>
  page.instagram ? (page.instagram.username ? `@${page.instagram.username}` : page.instagram.id) : null

/** Las páginas que marcó en Facebook, para elegir una. Sin claves. */
export async function listPagesToChoose(
  ownerDb: Db,
  secretsKey: Buffer,
  input: { pick: string; userId: string; orgId: string },
): Promise<PageChoice[]> {
  const pages = await readPick(ownerDb, secretsKey, input)
  return pages.map((page) => ({ id: page.id, name: page.name, instagram: instagramName(page) }))
}

/** Conecta la página elegida y, si se pide, su Instagram. Consume la elección. */
export async function chooseMetaPage(
  ownerDb: Db,
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  app: MetaPagesApp,
  deps: { fetch: typeof fetch },
  input: { pick: string; pageId: string; withInstagram: boolean; userId: string; orgId: string },
): Promise<MetaPagesResult> {
  await requireSettingsWriter(ownerDb, input.orgId, input.userId)
  const pages = await readPick(ownerDb, secretsKey, input)
  const page = pages.find((candidate) => candidate.id === input.pageId)
  if (!page) throw new ServiceError("NOT_FOUND", 404, "Esa página no está entre las que marcaste en Facebook.")
  // Un solo uso: otra pestaña o un doble clic ya no conecta nada.
  const [consumed] = await ownerDb
    .delete(mailboxOauthState)
    .where(eq(mailboxOauthState.nonce, input.pick))
    .returning({ nonce: mailboxOauthState.nonce })
  if (!consumed) throw new ServiceError("FORBIDDEN", 403, PICK_GONE)
  return connectPages(withOrgContext, secretsKey, app, deps, input.orgId, [page], input.withInstagram)
}

/**
 * Deja una conexión de Messenger por página y, si se pide, otra por su
 * Instagram unido, nueva o la que ya estaba (desconectada o hecha con la app
 * propia), con sus conversaciones. Después suscribe la app a cada página, fuera
 * de la transacción.
 */
async function connectPages(
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  app: MetaPagesApp,
  deps: { fetch: typeof fetch },
  orgId: string,
  pages: SharedPage[],
  withInstagram: boolean,
): Promise<MetaPagesResult> {
  const result: MetaPagesResult = { orgId, messenger: [], instagram: [], withoutInstagram: [], elsewhere: [] }
  const saved = await withOrgContext(orgId, async (tx) => {
    const ids: Array<{ id: string; page: SharedPage }> = []
    for (const page of pages) {
      const at = new Date()
      const messenger = await upsertPageConnection(tx, orgId, secretsKey, {
        provider: "messenger",
        channel: "messenger",
        externalId: page.id,
        displayName: page.name,
        config: { pageId: page.id, pageAccessToken: page.accessToken, appId: app.appId },
        at,
      })
      if (messenger) {
        result.messenger.push(page.name)
        ids.push({ id: messenger, page })
      } else result.elsewhere.push(page.name)
      if (!page.instagram) {
        result.withoutInstagram.push(page.name)
        continue
      }
      if (!withInstagram) continue
      const name = instagramName(page) ?? page.instagram.id
      const instagram = await upsertPageConnection(tx, orgId, secretsKey, {
        provider: "instagram",
        channel: "instagram",
        externalId: page.instagram.id,
        displayName: name,
        config: { instagramId: page.instagram.id, pageId: page.id, pageAccessToken: page.accessToken, appId: app.appId },
        at,
      })
      if (instagram) {
        result.instagram.push(name)
        ids.push({ id: instagram, page })
      } else result.elsewhere.push(name)
    }
    return ids
  })

  // La suscripción es de la página: una vez por página, sirve a Messenger y a su Instagram.
  const subscribed = new Map<string, string | null>()
  for (const { page } of saved) {
    if (subscribed.has(page.id)) continue
    try {
      await subscribeAppToPage(app, page.id, page.accessToken, deps)
      subscribed.set(page.id, null)
    } catch (error) {
      subscribed.set(page.id, error instanceof Error ? error.message : "Meta no aceptó la suscripción")
    }
  }
  await withOrgContext(orgId, async (tx) => {
    for (const { id, page } of saved) {
      const problem = subscribed.get(page.id) ?? null
      const [row] = await tx.select({ signup: channelConnection.signup }).from(channelConnection).where(eq(channelConnection.id, id)).limit(1)
      if (!row?.signup) continue
      const signup: ConnectionSignup = problem
        ? { ...row.signup, problems: { ...row.signup.problems, suscribir: "Meta no dejó suscribir la app a la página. Vuelve a conectar con Facebook." } }
        : { ...row.signup, subscribedAt: new Date().toISOString(), problems: {} }
      await tx.update(channelConnection).set({ signup, updatedAt: new Date() }).where(eq(channelConnection.id, id))
    }
  })
  return result
}

/**
 * Una conexión de página (Messenger) o de su Instagram: la que ya tenía la
 * clínica con esa cuenta (desconectada o hecha con la app propia) pasa al botón
 * con sus conversaciones; si no hay, una nueva. Nula si la cuenta está activa
 * en otra clínica: no se toca.
 */
async function upsertPageConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: {
    provider: "messenger" | "instagram"
    channel: "messenger" | "instagram"
    externalId: string
    displayName: string
    config: Record<string, string>
    at: Date
    /** Con Instagram la clave dura 60 días y se renueva sola; la de una página no vence. */
    tokenExpiresAt?: string | null
  },
): Promise<string | null> {
  const signup: ConnectionSignup = {
    grantedAt: input.at.toISOString(),
    subscribedAt: null,
    // No hay número que registrar: es una página.
    registeredAt: input.at.toISOString(),
    problems: {},
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    // La clave de una página no vence; si se pierde, lo dice la vuelta diaria.
    tokenNeverExpires: input.tokenExpiresAt == null,
    tokenProblem: null,
  }
  const values = {
    displayName: input.displayName,
    configEncrypted: encryptJson(secretsKey, input.config),
    externalId: input.externalId,
    signup,
    ownApp: null,
    status: "active" as const,
    updatedAt: input.at,
  }
  const [existing] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.provider, input.provider),
        eq(channelConnection.externalId, input.externalId),
      ),
    )
    .limit(1)
  try {
    // Punto de retorno: la cuenta puede estar activa en otra clínica.
    if (existing) {
      await tx.transaction((inner) => inner.update(channelConnection).set(values).where(eq(channelConnection.id, existing.id)))
      return existing.id
    }
    const [created] = await tx.transaction((inner) =>
      inner
        .insert(channelConnection)
        .values({
          ...values,
          organizationId: orgId,
          channel: input.channel,
          provider: input.provider,
          webhookSecret: crypto.randomUUID(),
        })
        .returning({ id: channelConnection.id }),
    )
    return created?.id ?? null
  } catch (error) {
    if (isUniqueViolation(error)) return null
    throw error
  }
}

/** Las conexiones de páginas e Instagram hechas con el botón y activas, de todas las clínicas (sin demos). */
export async function listPageConnections(ownerDb: Db): Promise<Array<{ orgId: string; connectionId: string }>> {
  const rows = await ownerDb
    .select({ orgId: channelConnection.organizationId, connectionId: channelConnection.id, signup: channelConnection.signup })
    .from(channelConnection)
    .leftJoin(saasSubscription, eq(saasSubscription.organizationId, channelConnection.organizationId))
    .where(
      and(
        inArray(channelConnection.provider, ["messenger", "instagram"]),
        eq(channelConnection.status, "active"),
        or(isNull(saasSubscription.isDemo), eq(saasSubscription.isDemo, false)),
      ),
    )
  return rows.filter((row) => row.signup !== null).map(({ orgId, connectionId }) => ({ orgId, connectionId }))
}

/**
 * Lo que dijo Facebook al revisar la clave de una página: `dead` si ya no la
 * acepta (se quitó el permiso, cambió quien administra la página). La fila dice
 * «Necesita atención» y la campana avisa a quien administra; al volver a
 * aceptarla, se borra y el aviso se retira solo. Devuelve si cambió algo.
 */
export async function notePageTokenState(tx: Db, orgId: string, connectionId: string, dead: boolean): Promise<boolean> {
  const [row] = await tx
    .select({ signup: channelConnection.signup, channel: channelConnection.channel })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row?.signup) return false
  const was = row.signup.tokenProblem === SIGNUP_TOKEN_DEAD
  if (was === dead) return false
  const signup: ConnectionSignup = { ...row.signup, tokenProblem: dead ? SIGNUP_TOKEN_DEAD : null }
  await tx.update(channelConnection).set({ signup, updatedAt: new Date() }).where(eq(channelConnection.id, connectionId))
  if (!dead) return true
  const name = row.channel === "instagram" ? "Instagram" : "Messenger"
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  for (const { userId } of admins) {
    await upsertWorkspaceNotification(tx, orgId, {
      userId,
      // El mismo asunto que WhatsApp: se retira solo cuando la clave vuelve a servir.
      dedupeKey: `clave-meta:${connectionId}:${userId}`,
      subject: `clave-meta:${connectionId}`,
      title: `${name} dejó de recibir mensajes`,
      body: `Meta ya no deja usar la cuenta (se quitó el permiso o cambió quien la administra). Vuelve a conectarla en Configuración › Integraciones › ${name}.`,
      href: `/settings/integrations/${row.channel}`,
      permission: "settings.write",
    })
  }
  return true
}

/* ------------------------- Conectar con Instagram ------------------------- */

/** La app de Instagram del caso de uso de Instagram y su vuelta fija. */
export interface InstagramLoginConfig extends InstagramLoginApp {
  redirectUri: string
}


/** Empieza: guarda el state de un solo uso y devuelve la ventana de Instagram. */
export async function beginInstagramLogin(
  tx: Db,
  orgId: string,
  userId: string,
  secretsKey: Buffer,
  app: InstagramLoginConfig,
): Promise<{ url: string }> {
  const nonce = randomBytes(32).toString("hex")
  await tx.insert(mailboxOauthState).values({
    nonce,
    organizationId: orgId,
    userId,
    provider: IG_PROVIDER,
    codeVerifier: randomBytes(32).toString("base64url"),
    redirectUri: app.redirectUri,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  })
  return { url: buildInstagramLoginUrl(app, { redirectUri: app.redirectUri, state: buildOauthStateParam(secretsKey, nonce) }) }
}

/**
 * Termina: la cuenta profesional de Instagram con la que entró, con o sin
 * página de Facebook. Queda como una conexión hecha con el botón (sus avisos
 * llegan a la dirección de la app), con su clave de 60 días que la vuelta diaria
 * renueva cada 7. La que ya tenía la clínica con esa cuenta sigue, con sus
 * conversaciones. Devuelve el usuario conectado, o nulo si está activa en otra clínica.
 */
export async function completeInstagramLogin(
  ownerDb: Db,
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  app: InstagramLoginConfig,
  deps: { fetch: typeof fetch },
  input: { state: string; code: string; userId: string },
): Promise<{ orgId: string; username: string | null; elsewhere: boolean }> {
  const nonce = parseOauthStateParam(secretsKey, input.state)
  if (!nonce) throw new ServiceError("FORBIDDEN", 403, "La vuelta de Instagram no es válida. Vuelve a intentarlo.")
  const [pending] = await ownerDb.delete(mailboxOauthState).where(eq(mailboxOauthState.nonce, nonce)).returning()
  if (!pending || pending.provider !== IG_PROVIDER || pending.expiresAt.getTime() < Date.now()) {
    throw new ServiceError("FORBIDDEN", 403, "La conexión con Instagram venció o ya se usó. Vuelve a intentarlo.")
  }
  if (pending.userId !== input.userId) throw new ServiceError("FORBIDDEN", 403, "Esta conexión la empezó otra persona.")
  await requireSettingsWriter(ownerDb, pending.organizationId, input.userId)
  const account = await completeInstagramLoginCode(app, { code: input.code, redirectUri: pending.redirectUri }, deps)
  const orgId = pending.organizationId
  const now = new Date()
  const name = account.username ? `@${account.username}` : account.userId
  const expiresAt = new Date(now.getTime() + (account.expiresInSeconds ?? 60 * 24 * 3600) * 1000).toISOString()
  const id = await withOrgContext(orgId, (tx) =>
    upsertPageConnection(tx, orgId, secretsKey, {
      provider: "instagram",
      channel: "instagram",
      externalId: account.userId,
      displayName: name,
      config: { instagramId: account.userId, accessToken: account.accessToken, appId: app.appId, tokenRenewedAt: now.toISOString() },
      at: now,
      tokenExpiresAt: expiresAt,
    }),
  )
  if (!id) return { orgId, username: name, elsewhere: true }
  let problem: string | null = null
  try {
    await subscribeAppToInstagram(app, account.accessToken, deps)
  } catch {
    problem = "Instagram no dejó suscribir la app a la cuenta. Vuelve a conectar con Instagram."
  }
  await withOrgContext(orgId, async (tx) => {
    const [row] = await tx.select({ signup: channelConnection.signup }).from(channelConnection).where(eq(channelConnection.id, id)).limit(1)
    if (!row?.signup) return
    const signup: ConnectionSignup = problem
      ? { ...row.signup, problems: { ...row.signup.problems, suscribir: problem } }
      : { ...row.signup, subscribedAt: new Date().toISOString(), problems: {} }
    await tx.update(channelConnection).set({ signup, updatedAt: new Date() }).where(eq(channelConnection.id, id))
  })
  return { orgId, username: name, elsewhere: false }
}
