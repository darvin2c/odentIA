import {
  buildPagesLoginUrl,
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
import { and, eq, inArray } from "drizzle-orm"
import { randomBytes } from "node:crypto"
import { SIGNUP_TOKEN_DEAD } from "./connections.js"
import { isUniqueViolation, ServiceError } from "./errors.js"
import { buildOauthStateParam, parseOauthStateParam } from "./mailbox.js"
import { encryptJson } from "./secrets.js"
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
 * Termina: comprueba el state (firma, un solo uso, 10 minutos, la misma persona,
 * que administre la configuración de la clínica), canjea el código, lee las
 * páginas marcadas y deja una conexión por página y por Instagram unido, nueva
 * o la que ya estaba (desconectada o hecha con la app propia), con sus
 * conversaciones. Después suscribe la app a cada página, fuera de la transacción.
 */
export async function completeMetaPagesLogin(
  ownerDb: Db,
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  app: MetaPagesApp,
  deps: { fetch: typeof fetch },
  input: { state: string; code: string; userId: string },
): Promise<MetaPagesResult> {
  const nonce = parseOauthStateParam(secretsKey, input.state)
  if (!nonce) throw new ServiceError("FORBIDDEN", 403, "La vuelta de Facebook no es válida. Vuelve a intentarlo.")
  const [pending] = await ownerDb.select().from(mailboxOauthState).where(eq(mailboxOauthState.nonce, nonce)).limit(1)
  // Consumido primero: el código de Facebook es de un solo uso.
  if (pending) await ownerDb.delete(mailboxOauthState).where(eq(mailboxOauthState.nonce, nonce))
  if (!pending || pending.provider !== PROVIDER) {
    throw new ServiceError("FORBIDDEN", 403, "La conexión con Facebook venció o ya se usó. Vuelve a intentarlo.")
  }
  if (pending.expiresAt.getTime() < Date.now()) {
    throw new ServiceError("FORBIDDEN", 403, "Pasaron más de 10 minutos. Vuelve a intentarlo.")
  }
  if (pending.userId !== input.userId) throw new ServiceError("FORBIDDEN", 403, "Esta conexión la empezó otra persona.")
  const [role] = await ownerDb
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, pending.organizationId), eq(member.userId, input.userId), inArray(member.role, ["owner", "admin"])))
    .limit(1)
  if (!role) throw new ServiceError("FORBIDDEN", 403, "Conecta los canales quien administra la clínica.")

  const userToken = await exchangePagesCode(app, { code: input.code, redirectUri: pending.redirectUri }, deps)
  const pages = await listSharedPages(app, userToken, deps)
  if (pages.length === 0) {
    throw new ServiceError("NO_PAGES", 400, "No marcaste ninguna página en Facebook. Vuelve a intentarlo y marca la de la clínica.")
  }
  const orgId = pending.organizationId
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
      const name = page.instagram.username ? `@${page.instagram.username}` : page.instagram.id
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
  },
): Promise<string | null> {
  const signup: ConnectionSignup = {
    grantedAt: input.at.toISOString(),
    subscribedAt: null,
    // No hay número que registrar: es una página.
    registeredAt: input.at.toISOString(),
    problems: {},
    tokenExpiresAt: null,
    // La clave de una página no vence; si se pierde, lo dice la vuelta diaria.
    tokenNeverExpires: true,
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
    .where(and(inArray(channelConnection.provider, ["messenger", "instagram"]), eq(channelConnection.status, "active")))
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
      body: `Facebook ya no deja usar la cuenta (se quitó el permiso o cambió quien administra la página). Vuelve a conectar con Facebook en Configuración › Integraciones › ${name}.`,
      href: `/settings/integrations/${row.channel}`,
      permission: "settings.write",
    })
  }
  return true
}
