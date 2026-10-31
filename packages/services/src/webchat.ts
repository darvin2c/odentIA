import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import {
  assertValidWebchatConfig,
  createWebchatToken,
  isWebchatSessionId,
  newWebchatSessionId,
  normalizeOrigin,
  verifyWebchatToken,
  WEBCHAT_CHANNEL,
  type WebchatConnectionConfig,
} from "@odentia/channels"
import { normalizePhone } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, organization, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { type WebchatSiteStatus, webchatRateLimit, webchatSite } from "@odentia/db/schema/webchat"
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { z } from "zod"
import { getAgentConfig } from "./agentConfig.js"
import { findClinicName } from "./automation-routing.js"
import { createConnection, setConnectionStatus } from "./connections.js"
import { updateContact } from "./contacts.js"
import { TEST_KEEP_MS } from "./conversation-state.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgCountry } from "./locale.js"
import { resolvePersonalLinkRefs } from "./personal-link-token.js"
import { clinicOriginOf } from "./public-links.js"
import { decryptConfig, encryptJson } from "./secrets.js"
import { webchatCanNotify, webchatReplyRoutes } from "./webchat-reply.js"
import { createWorkspaceNotification } from "./workspace.js"

/**
 * El chat web de la clínica (issue 111; fase 6 del pulido de la Bandeja). Uno
 * solo por clínica, servido desde su dirección con una línea que no cambia
 * (decisión 7): `<script src="https://<clínica>.<dominio>/chat.js" async>`.
 * Responde en el primer sitio donde se carga y en los que la clínica permite
 * (decisión 8). El visitante escribe sin dar su nombre (decisión 9) y su
 * conversación sigue 30 días en ese navegador. Cuando Sofi pasa un tema al
 * equipo, el chat le pide dónde avisarle (R4, decisión 10). La prueba desde
 * Configuración responde de verdad, pero no se cobra ni cuenta.
 */

/** Proveedor del chat web embebible propio (sin red externa). */
export const WEBCHAT_PROVIDER = "web_chat"

export type { WebchatConnectionConfig }
/** Re-export del canal lógico para rutas y seeds. */
export { WEBCHAT_CHANNEL }

const DEFAULT_COLOR = "#0f766e"
export const WEBCHAT_DEFAULT_GREETING = "Hola, ¿en qué podemos ayudarte?"
/** «escribiendo…» mientras Sofi atiende lo último que escribió, como mucho este rato. */
const TYPING_MS = 90_000
const SETTINGS_HREF = "/settings/integrations/webchat"

/**
 * Config descifrada de la conexión (AES-256-GCM con SECRETS_KEY, igual que el
 * resto de conexiones). Lo que ya no se usa (orígenes, título) se descarta.
 */
function readConfig(row: typeof channelConnection.$inferSelect, secretsKey: Buffer): WebchatConnectionConfig {
  try {
    return assertValidWebchatConfig(decryptConfig(secretsKey, row.configEncrypted))
  } catch (e) {
    // Config corrupta = fallo interno (500 vía onError): nunca es culpa del visitante ni del admin.
    throw new Error(e instanceof Error ? e.message : "Configuración del chat web ilegible")
  }
}

async function clinicWebchatRow(tx: Db, orgId: string) {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.provider, WEBCHAT_PROVIDER)))
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
    .limit(1)
  return row ?? null
}

async function requireClinicWebchat(tx: Db, orgId: string) {
  const row = await clinicWebchatRow(tx, orgId)
  if (!row) throw notFound("Chat web")
  return row
}

/**
 * La conexión del chat web de la clínica, creada si aún no existe: «Probar» va
 * por ella, como la prueba del chat web, aunque el chat esté desactivado (ADR 0094).
 */
export async function ensureClinicWebchatConnection(tx: Db, orgId: string, secretsKey: Buffer, actorUserId: string | null): Promise<string> {
  await getClinicWebchat(tx, orgId, secretsKey, actorUserId)
  return (await requireClinicWebchat(tx, orgId)).id
}

// ------------------------------------------------------------ Configuración ---

export interface WebchatSiteView {
  id: string
  origin: string
  status: WebchatSiteStatus
  firstSeenAt: string
  decidedAt: string | null
  /** Quién lo permitió o lo bloqueó; nulo en el primero, que se registró solo. */
  decidedByName: string | null
  /** El primer sitio, registrado solo. */
  first: boolean
}

/** Lo que muestra Configuración › Chat web. Sin secretos. */
export interface ClinicWebchat {
  id: string
  active: boolean
  /** La línea para pegar en el sitio; nula sin dirección pública configurada. */
  script: string | null
  color: string
  greeting: string
  notifyUrl: string | null
  /** El primer sitio permitido donde ya cargó: «Instalado en sonrisa.pe». */
  installedOn: string | null
  sites: WebchatSiteView[]
}

/**
 * El chat de la clínica; si aún no tiene, nace encendido y sin sitios: el
 * primero donde se pegue la línea se registra solo. Si la clínica tenía varios
 * de antes, vale el más antiguo.
 */
export async function getClinicWebchat(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
): Promise<ClinicWebchat> {
  let row = await clinicWebchatRow(tx, orgId)
  if (!row) {
    // La pantalla y su vista previa lo piden a la vez al abrirse: uno solo lo crea,
    // el otro espera y usa ese. Dos chats firmarían sus sesiones con claves distintas.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`webchat-crear:${orgId}`}))`)
    row = await clinicWebchatRow(tx, orgId)
  }
  if (!row) {
    const created = await createConnection(
      tx,
      orgId,
      secretsKey,
      { channel: WEBCHAT_CHANNEL, provider: WEBCHAT_PROVIDER, displayName: "Chat web", config: {} },
      { fetch, validateExternal: false },
    )
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "webchat.created",
      entity: "channel_connection",
      entityId: created.id,
      metadata: {},
    })
    row = await requireClinicWebchat(tx, orgId)
  }
  return clinicWebchatView(tx, orgId, row, readConfig(row, secretsKey))
}

/**
 * El chat de la clínica sin crearlo: la lista de Integraciones lo mira sin
 * dejarlo encendido. Nulo si la clínica nunca abrió Configuración › Chat web.
 */
export async function peekClinicWebchat(tx: Db, orgId: string, secretsKey: Buffer): Promise<ClinicWebchat | null> {
  const row = await clinicWebchatRow(tx, orgId)
  return row ? clinicWebchatView(tx, orgId, row, readConfig(row, secretsKey)) : null
}

async function clinicWebchatView(
  tx: Db,
  orgId: string,
  row: typeof channelConnection.$inferSelect,
  config: WebchatConnectionConfig,
): Promise<ClinicWebchat> {
  const sites = await tx
    .select({ site: webchatSite, decidedByName: user.name })
    .from(webchatSite)
    .leftJoin(user, eq(user.id, webchatSite.decidedByUserId))
    .where(and(eq(webchatSite.organizationId, orgId), eq(webchatSite.connectionId, row.id)))
    .orderBy(asc(webchatSite.firstSeenAt), asc(webchatSite.id))
  const origin = await clinicOriginOf(tx, orgId)
  const views = sites.map(({ site, decidedByName }, index) => ({
    id: site.id,
    origin: site.origin,
    status: site.status,
    firstSeenAt: site.firstSeenAt.toISOString(),
    decidedAt: site.decidedAt?.toISOString() ?? null,
    decidedByName,
    first: index === 0 && site.decidedByUserId === null && site.status === "permitido",
  }))
  return {
    id: row.id,
    active: row.status === "active",
    script: origin ? `<script src="${origin}/chat.js" async></script>` : null,
    color: config.widgetColor ?? DEFAULT_COLOR,
    greeting: config.greeting ?? WEBCHAT_DEFAULT_GREETING,
    notifyUrl: config.notifyUrl ?? null,
    installedOn: views.find((site) => site.status === "permitido")?.origin ?? null,
    sites: views,
  }
}

/** Color, saludo y aviso al sitio («Opciones avanzadas»). Cambiarlos no obliga a volver a pegar la línea. */
export async function updateClinicWebchat(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
  patch: { color?: string; greeting?: string | null; notifyUrl?: string | null },
): Promise<ClinicWebchat> {
  const row = await requireClinicWebchat(tx, orgId)
  const next: Record<string, unknown> = { ...readConfig(row, secretsKey) }
  if (patch.color !== undefined) next["widgetColor"] = patch.color
  if (patch.greeting !== undefined) next["greeting"] = patch.greeting?.trim() || undefined
  if (patch.notifyUrl !== undefined) next["notifyUrl"] = patch.notifyUrl?.trim() || undefined
  let valid: WebchatConnectionConfig
  try {
    valid = assertValidWebchatConfig(next)
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Revisa los datos del chat")
  }
  const [updated] = await tx
    .update(channelConnection)
    .set({ configEncrypted: encryptJson(secretsKey, valid), updatedAt: new Date() })
    .where(and(eq(channelConnection.id, row.id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Chat web")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "webchat.updated",
    entity: "channel_connection",
    entityId: row.id,
    metadata: { fields: Object.keys(patch) },
  })
  return clinicWebchatView(tx, orgId, updated, valid)
}

/** «Desactivar» / «Activar»: desactivado, el chat dice «No disponible» en todos los sitios. */
export async function setClinicWebchatActive(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  active: boolean,
): Promise<ClinicWebchat> {
  const row = await requireClinicWebchat(tx, orgId)
  await setConnectionStatus(tx, orgId, row.id, active ? "active" : "disabled")
  const fresh = await requireClinicWebchat(tx, orgId)
  return clinicWebchatView(tx, orgId, fresh, readConfig(fresh, secretsKey))
}

/**
 * «Generar un código nuevo»: la clave que firma las sesiones y el aviso al
 * sitio cambia. Los visitantes que ya estaban siguen en su conversación 30
 * días con la anterior y reciben una sesión nueva al volver.
 */
export async function rotateClinicWebchatSecret(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
): Promise<ClinicWebchat> {
  const row = await requireClinicWebchat(tx, orgId)
  const config = readConfig(row, secretsKey)
  // Solo cambia el código de los avisos: las sesiones de los visitantes tienen su propia clave (`webchatSessionKey`).
  const [updated] = await tx
    .update(channelConnection)
    .set({ webhookSecret: randomUUID(), updatedAt: new Date() })
    .where(and(eq(channelConnection.id, row.id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Chat web")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "webchat.secret_rotated",
    entity: "channel_connection",
    entityId: row.id,
    metadata: {},
  })
  return clinicWebchatView(tx, orgId, updated, config)
}

/**
 * El código con que se firma el aviso al sitio (`x-webchat-signature`): lo
 * necesita quien hace la web para comprobar que el aviso es de la clínica.
 * Solo para quien administra (la ruta pide `settings.write`).
 */
export async function webchatSigningCode(tx: Db, orgId: string): Promise<string> {
  return (await requireClinicWebchat(tx, orgId)).webhookSecret
}

/** «Permitir» o «Bloquear» un sitio donde apareció el chat (decisión 8). */
export async function decideWebchatSite(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string,
  siteId: string,
  status: "permitido" | "bloqueado",
): Promise<ClinicWebchat> {
  const [updated] = await tx
    .update(webchatSite)
    .set({ status, decidedByUserId: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(webchatSite.id, siteId), eq(webchatSite.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Sitio")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: status === "permitido" ? "webchat.site_allowed" : "webchat.site_blocked",
    entity: "webchat_site",
    entityId: siteId,
    metadata: { origin: updated.origin },
  })
  const row = await requireClinicWebchat(tx, orgId)
  return clinicWebchatView(tx, orgId, row, readConfig(row, secretsKey))
}

// ------------------------------------------------------------ Para el visitante ---

/** El chat de una clínica por su dirección; nulo si no existe la clínica o no tiene chat. */
export interface PublicWebchat {
  orgId: string
  connection: typeof channelConnection.$inferSelect
  config: WebchatConnectionConfig
  /** Firma las sesiones de los visitantes (`webchatSessionKey`); nunca se muestra. */
  sessionKey: string
}

/**
 * La clave de las sesiones del chat: sale de la clave de secretos del
 * servidor y del chat, no del código de los avisos que se entrega a quien
 * hace la web. Por eso «Generar un código nuevo» no deja a nadie sin su
 * conversación, y quien conoce el código no puede leer ninguna.
 */
export function webchatSessionKey(secretsKey: Buffer, connectionId: string): string {
  return createHmac("sha256", secretsKey).update(`webchat-session:${connectionId}`, "utf8").digest("hex")
}

/** Con el rol owner: la ruta pública todavía no sabe de qué clínica es. */
export async function findClinicWebchat(ownerDb: Db, secretsKey: Buffer, slug: string): Promise<PublicWebchat | null> {
  const [org] = await ownerDb.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1)
  if (!org) return null
  const row = await clinicWebchatRow(ownerDb, org.id)
  if (!row) return null
  return { orgId: org.id, connection: row, config: readConfig(row, secretsKey), sessionKey: webchatSessionKey(secretsKey, row.id) }
}

/** Lo que el visitante ve antes de escribir: cómo se llama, quién responde y el saludo. */
export interface WebchatAppearance {
  clinicName: string
  /** «Te responde Sofi al momento» si Sofi atiende el chat; si no, que responde el equipo. */
  subtitle: string
  /** Quién firma el saludo y las respuestas automáticas: Sofi, o la clínica si Sofi no atiende el chat. */
  assistant: string
  color: string
  greeting: string
}

export async function webchatAppearance(tx: Db, orgId: string, found: PublicWebchat): Promise<WebchatAppearance> {
  const cfg = await getAgentConfig(tx, orgId)
  const attends = cfg.enabled
  const clinicName = (await findClinicName(tx, orgId)) ?? "La clínica"
  return {
    clinicName,
    subtitle: attends ? `Te responde ${cfg.personaName} al momento` : "Te respondemos lo antes posible",
    assistant: attends ? cfg.personaName : clinicName,
    color: found.config.widgetColor ?? DEFAULT_COLOR,
    greeting: found.config.greeting ?? WEBCHAT_DEFAULT_GREETING,
  }
}

/**
 * ¿Responde el chat en este sitio? El primero donde carga se permite solo; uno
 * nuevo queda pendiente, avisa a quien administra («¿Es tuyo?») y mientras
 * tanto ahí dice «No disponible». Así nadie gasta las conversaciones de la
 * clínica copiando su línea en otro sitio (decisión 8).
 */
export async function admitWebchatSite(
  tx: Db,
  orgId: string,
  connectionId: string,
  rawOrigin: string,
): Promise<{ origin: string; status: WebchatSiteStatus } | null> {
  const origin = normalizeOrigin(rawOrigin)
  if (!origin) return null
  // Dos sitios que cargan a la vez no pueden ser los dos «el primero».
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`webchat-site:${connectionId}`}))`)
  const [known] = await tx
    .select({ status: webchatSite.status })
    .from(webchatSite)
    .where(and(eq(webchatSite.connectionId, connectionId), eq(webchatSite.origin, origin)))
    .limit(1)
  if (known) return { origin, status: known.status }
  const [any] = await tx.select({ id: webchatSite.id }).from(webchatSite).where(eq(webchatSite.connectionId, connectionId)).limit(1)
  const status: WebchatSiteStatus = any ? "pendiente" : "permitido"
  // Sitios inventados no llenan la lista ni la campana: pasado el tope, uno nuevo no se anota y dice «No disponible».
  if (status === "pendiente") {
    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(webchatSite)
      .where(and(eq(webchatSite.connectionId, connectionId), eq(webchatSite.status, "pendiente")))
    if ((pending?.count ?? 0) >= MAX_PENDING_SITES) return null
  }
  const [site] = await tx.insert(webchatSite).values({ organizationId: orgId, connectionId, origin, status }).returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: null,
    action: status === "permitido" ? "webchat.site_registered" : "webchat.site_pending",
    entity: "webchat_site",
    entityId: site?.id ?? null,
    metadata: { origin },
  })
  // El primero también se avisa: si no es de la clínica, se bloquea desde Configuración.
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
  const host = new URL(origin).host
  for (const admin of admins) {
    await createWorkspaceNotification(tx, orgId, {
      userId: admin.userId,
      dedupeKey: `webchat-site:${origin}`,
      title: status === "pendiente" ? `El chat de tu sitio apareció en ${host}` : `El chat de tu sitio quedó instalado en ${host}`,
      body:
        status === "pendiente"
          ? "Mientras no lo permitas, ahí dice «No disponible». ¿Es tuyo?"
          : "Es el primer sitio donde cargó. Si no es tuyo, bloquéalo en Configuración › Chat web.",
      href: SETTINGS_HREF,
      permission: "settings.write",
    })
  }
  return { origin, status }
}

/** Sitios esperando el sí de la clínica, como mucho. */
const MAX_PENDING_SITES = 20
const SITE_TICKET_TTL_MS = 24 * 60 * 60 * 1000

/**
 * El sitio donde cargó `chat.js`, visto por la API en la cabecera `Origin` y
 * firmado. La ventana del chat lo presenta al abrir la sesión: abrir
 * `/embed?site=…` desde otra página no basta para conversar en nombre de un
 * sitio permitido.
 */
export function webchatSiteTicket(sessionKey: string, origin: string, now: number = Date.now()): string {
  const payload = `${origin}|${now + SITE_TICKET_TTL_MS}`
  const sig = createHmac("sha256", sessionKey).update(`site:${payload}`, "utf8").digest("hex")
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url")
}

/** El sitio de un ticket vigente y bien firmado; nulo si no. */
export function readWebchatSiteTicket(sessionKey: string, ticket: string, now: number = Date.now()): string | null {
  let decoded: string
  try {
    decoded = Buffer.from(ticket, "base64url").toString("utf8")
  } catch {
    return null
  }
  const parts = decoded.split("|")
  if (parts.length !== 3) return null
  const [origin, exp, sig] = parts as [string, string, string]
  if (!Number.isInteger(Number(exp)) || Number(exp) <= now) return null
  const expected = createHmac("sha256", sessionKey).update(`site:${origin}|${exp}`, "utf8").digest("hex")
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null
  return normalizeOrigin(origin)
}

/**
 * Los sitios donde el navegador deja mostrar el chat (`frame-ancestors`): los
 * permitidos. Nulo mientras no haya ninguno, para que el primero pueda cargar.
 */
export async function webchatFrameAncestors(tx: Db, orgId: string, connectionId: string): Promise<string[] | null> {
  const rows = await tx
    .select({ origin: webchatSite.origin, status: webchatSite.status })
    .from(webchatSite)
    .where(and(eq(webchatSite.organizationId, orgId), eq(webchatSite.connectionId, connectionId)))
  if (rows.length === 0) return null
  return rows.filter((row) => row.status === "permitido").map((row) => row.origin)
}

/** Una sesión de visitante: dura 30 días en su navegador. La prueba lleva su propia marca. */
export function openWebchatSession(
  sessionKey: string,
  opts: { test?: boolean } = {},
): { sessionId: string; token: string; expiresAt: number } {
  const sessionId = newWebchatSessionId(opts)
  const token = createWebchatToken(sessionKey, sessionId)
  const verified = verifyWebchatToken(sessionKey, token)
  if (!verified) throw new Error("No se pudo emitir la sesión del chat")
  return { sessionId, token, expiresAt: verified.expiresAt }
}

/** La sesión de un token; nula si no es válida o venció. */
export function readVisitorSession(found: PublicWebchat, token: string): { sessionId: string } | null {
  const read = verifyWebchatToken(found.sessionKey, token)
  if (!read || !isWebchatSessionId(read.sessionId)) return null
  return { sessionId: read.sessionId }
}

/**
 * Lo que recibe el visitante de cada mensaje: quién lo dijo en palabras, el
 * texto y la hora. Nunca quién del equipo escribió por dentro, errores ni
 * identificadores internos (tablero 8): la clave de su propio mensaje es la
 * que eligió su navegador; la de la clínica, una huella del mensaje.
 */
export interface VisitorMessage {
  key: string
  from: "visitante" | "clinica"
  /** «Sofi» o el nombre de la clínica; nulo en lo que escribió el visitante. */
  author: string | null
  text: string
  at: string
}

export interface VisitorPoll {
  messages: VisitorMessage[]
  /** Sofi está respondiendo lo último que escribió. */
  typing: boolean
  /** Hay un tema con el equipo y todavía no dejó dónde avisarle (R4). */
  askContact: boolean
  /** Dónde se le avisa, a medias: «•••• 4321». Nulo si no dejó nada. */
  contact: { whatsapp: string | null; email: string | null } | null
}

const EMPTY_POLL: VisitorPoll = { messages: [], typing: false, askContact: false, contact: null }

async function sessionConversation(tx: Db, orgId: string, connectionId: string, sessionId: string) {
  const [row] = await tx
    .select({
      id: conversation.id,
      agentStatus: conversation.agentStatus,
      isTest: conversation.isTest,
      contactId: conversation.contactId,
      phone: contact.phone,
      email: contact.email,
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.channelConnectionId, connectionId),
        eq(conversation.externalThreadId, sessionId),
      ),
    )
    .limit(1)
  return row ?? null
}

function masked(phone: string | null, email: string | null): VisitorPoll["contact"] {
  if (!phone && !email) return null
  const at = email?.indexOf("@") ?? -1
  return {
    whatsapp: phone ? `•••• ${phone.slice(-4)}` : null,
    email: email && at > 0 ? `${email.slice(0, 1)}•••${email.slice(at)}` : null,
  }
}

/**
 * Lee la conversación de la sesión y marca `sent → delivered` lo que el
 * visitante acaba de recibir. Sin conversación aún: nada (su primer mensaje la
 * crea en la ingesta). «Su enlace» va en los mensajes como referencia: aquí,
 * como al enviar por cualquier canal, se le pone su token (ADR 0037).
 */
export async function pollWebchatVisitor(
  tx: Db,
  orgId: string,
  connectionId: string,
  sessionId: string,
  options: { now?: Date; secretsKey?: Buffer } = {},
): Promise<VisitorPoll> {
  const now = options.now ?? new Date()
  const conv = await sessionConversation(tx, orgId, connectionId, sessionId)
  if (!conv) return EMPTY_POLL
  const rows = await tx
    .select({
      id: message.id,
      direction: message.direction,
      senderKind: message.senderKind,
      body: message.body,
      status: message.status,
      externalId: message.externalId,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.conversationId, conv.id), sql`${message.redactedAt} is null`))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(100)
  rows.reverse()
  const cfg = await getAgentConfig(tx, orgId)
  const clinic = (await findClinicName(tx, orgId)) ?? "La clínica"
  const messages: VisitorMessage[] = []
  for (const row of rows) {
    const text = row.body?.trim()
    if (!text) continue
    if (row.direction === "in") {
      messages.push({ key: row.externalId?.split(":").at(-1) ?? hashKey(row.id), from: "visitante", author: null, text, at: row.createdAt.toISOString() })
    } else if (row.status !== "failed" && row.status !== "held") {
      messages.push({
        key: hashKey(row.id),
        from: "clinica",
        author: row.senderKind === "agent" ? cfg.personaName : clinic,
        text: options.secretsKey ? resolvePersonalLinkRefs(text, options.secretsKey) : text,
        at: row.createdAt.toISOString(),
      })
    }
  }
  const delivered = await tx
    .update(message)
    .set({ status: "delivered" })
    .where(and(eq(message.conversationId, conv.id), eq(message.direction, "out"), eq(message.status, "sent")))
    .returning({ id: message.id })
  if (delivered.length > 0) {
    await tx.execute(
      sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "message.updated", conversationId: conv.id, at: now.toISOString() })})`,
    )
  }
  const last = rows.at(-1)
  // Una prueba responde aunque Sofi esté apagada (ADR 0094).
  const attends = (cfg.enabled || conv.isTest) && conv.agentStatus === "on"
  const [topic] = await tx
    .select({ id: sql<string>`h.id` })
    .from(sql`agent_handoff h`)
    .where(sql`h.organization_id = ${orgId} and h.conversation_id = ${conv.id} and ${handoffOpenSql(sql.raw("h"))}`)
    .limit(1)
  return {
    messages,
    typing: !!last && last.direction === "in" && attends && now.getTime() - last.createdAt.getTime() < TYPING_MS,
    // Se pide solo si la clínica tiene por dónde avisarle (WhatsApp o un buzón).
    askContact: !!topic && !conv.phone && !conv.email && (await webchatCanNotify(tx, orgId)),
    contact: masked(conv.phone, conv.email),
  }
}

/**
 * Qué dice Sofi al pasar un tema en el chat web: «aquí abajo» solo si el chat
 * va a pedir dónde avisarle; si ya lo dejó, que le avisan por ahí; si la
 * clínica no tiene por dónde, que le responden en el chat.
 */
export async function webchatHandoffWhere(tx: Db, orgId: string, conversationId: string): Promise<"preguntar" | "ya_dejo" | "aqui"> {
  const [row] = await tx.execute<{ phone: string | null; email: string | null }>(sql`
    select p.phone, p.email from conversation c join contact p on p.id = c.contact_id
    where c.organization_id = ${orgId} and c.id = ${conversationId}::uuid`)
  if (row?.phone || row?.email) return "ya_dejo"
  return (await webchatCanNotify(tx, orgId)) ? "preguntar" : "aqui"
}

function hashKey(id: string): string {
  return `c${createHash("sha256").update(id).digest("hex").slice(0, 12)}`
}

const emailSchema = z.string().trim().toLowerCase().email().max(320)

/**
 * «¿Dónde te avisamos?» (R4, decisión 10): su WhatsApp o su correo, solo para
 * responderle. Queda en su persona y la respuesta del equipo sale por ahí;
 * nunca la une con otra ficha por el número.
 */
export async function saveWebchatVisitorContact(
  tx: Db,
  orgId: string,
  connectionId: string,
  sessionId: string,
  input: { whatsapp?: string | null; email?: string | null },
): Promise<VisitorPoll["contact"]> {
  const conv = await sessionConversation(tx, orgId, connectionId, sessionId)
  if (!conv) throw notFound("Conversación")
  return saveVisitorContact(tx, orgId, conv, input)
}

/**
 * Lo mismo cuando la persona escribe su WhatsApp o su correo en el chat y Sofi
 * lo guarda (`guardar_contacto`): en el chat web no se reserva sin dónde
 * avisarle (auditoría del 27-oct). Las mismas reglas que el formulario.
 */
export async function saveWebchatContactForConversation(
  tx: Db,
  orgId: string,
  conversationId: string,
  input: { whatsapp?: string | null; email?: string | null },
): Promise<VisitorPoll["contact"]> {
  const [conv] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId, phone: contact.phone, email: contact.email })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")
  return saveVisitorContact(tx, orgId, conv, input)
}

async function saveVisitorContact(
  tx: Db,
  orgId: string,
  conv: { id: string; contactId: string; phone: string | null; email: string | null },
  input: { whatsapp?: string | null; email?: string | null },
): Promise<VisitorPoll["contact"]> {
  // Solo la persona que nació en este chat: la ficha de un paciente, o de quien
  // también escribe por otro canal, no se cambia desde un navegador.
  // La persona de «Probar» ya nace con su ficha (ADR 0094): se le guarda igual, como a un visitante.
  const [known] = await tx.execute<{ known: boolean }>(sql`
    select (exists (select 1 from patient_contact pc where pc.organization_id = ${orgId} and pc.contact_id = ${conv.contactId})
      or exists (select 1 from conversation c2 join channel_connection cn on cn.id = c2.channel_connection_id
        where c2.organization_id = ${orgId} and c2.contact_id = ${conv.contactId} and cn.provider <> ${WEBCHAT_PROVIDER}))
      and not exists (select 1 from contact p where p.id = ${conv.contactId} and p.is_test) as known`)
  if (known?.known) throw new ServiceError("WEBCHAT_CONTACT_KNOWN", 409, "Ya tenemos cómo avisarte.")
  const typedPhone = input.whatsapp?.trim() || null
  const typedEmail = input.email?.trim() || null
  // Cada error a su dato (`whatsapp`/`email` en el cuerpo); sin ninguno, el de los dos.
  if (!typedPhone && !typedEmail) throw validation("Escribe tu WhatsApp o tu correo.", { whatsapp: "Escribe tu WhatsApp o tu correo." })
  const phone = typedPhone ? normalizePhone(typedPhone, (await findOrgCountry(tx, orgId)) ?? undefined) : null
  if (typedPhone && !phone)
    throw invalidField("whatsapp", "Escribe tu WhatsApp con el código de tu país, por ejemplo +51 987 654 321.")
  const email = typedEmail ? emailSchema.safeParse(typedEmail) : null
  if (email && !email.success) throw invalidField("email", "Revisa tu correo: falta algo, como la @.")
  await updateContact(
    tx,
    orgId,
    conv.contactId,
    { ...(phone ? { phone } : {}), ...(email?.success ? { email: email.data } : {}) },
    { userId: null },
  )
  // Lo que deja tiene que servir para avisarle. Un número que ya es de otra persona se guarda
  // igual y sin decírselo (le revelaría quién es de la clínica): no se usa para avisarle, y el
  // equipo lo ve en «Sin forma de avisarle» (`othersPhone`) y decide.
  const routes = await webchatReplyRoutes(tx, orgId, conv.contactId)
  if (!routes.whatsapp && !routes.correo && !routes.othersPhone) {
    throw typedEmail
      ? invalidField("email", "No podemos avisarte por ahí. Revisa tu correo o déjanos tu WhatsApp.")
      : invalidField("whatsapp", "No podemos avisarte por ese WhatsApp. Déjanos otro número o tu correo.")
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: null,
    action: "webchat.contact_saved",
    entity: "conversation",
    entityId: conv.id,
    metadata: { whatsapp: !!phone, email: !!email?.success },
  })
  return masked(phone ?? conv.phone, email?.success ? email.data : conv.email)
}

// ------------------------------------------------------------ La prueba ---

/** «Probar sin publicar»: una sesión de prueba, aunque el chat esté desactivado. */
export async function openWebchatTest(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
): Promise<{ sessionId: string; token: string }> {
  await getClinicWebchat(tx, orgId, secretsKey, actorUserId)
  const row = await requireClinicWebchat(tx, orgId)
  const { sessionId, token } = openWebchatSession(webchatSessionKey(secretsKey, row.id), { test: true })
  return { sessionId, token }
}

/**
 * Borra una prueba de esta clínica con todo lo que dejó (`delete_webchat_test`).
 * Antes toma la conversación: lo que Sofi esté anotando en ella termina primero y
 * se borra también, o espera y ya no la encuentra. Tiene que ser `for update`: es
 * el único que choca con el `for key share` de las llaves foráneas; sin él, una
 * corrida anotada a mitad del borrado lo tumba con 23503.
 */
export async function deleteTestConversation(tx: Db, orgId: string, conversationId: string): Promise<boolean> {
  await tx.execute(sql`select 1 from "conversation" where "id" = ${conversationId}::uuid and "organization_id" = ${orgId} and "is_test" for update`)
  const [result] = await tx.execute<{ deleted: boolean }>(sql`select public.delete_webchat_test(${conversationId}::uuid) as deleted`)
  return result?.deleted === true
}

/** «Borrar esta prueba»: la conversación de prueba de esa sesión, con todo lo que dejó. */
export async function deleteWebchatTest(tx: Db, orgId: string, input: { sessionId?: string; conversationId?: string }): Promise<boolean> {
  let conversationId = input.conversationId ?? null
  if (!conversationId && input.sessionId) {
    const row = await clinicWebchatRow(tx, orgId)
    const conv = row ? await sessionConversation(tx, orgId, row.id, input.sessionId) : null
    conversationId = conv?.id ?? null
  }
  if (!conversationId) return false
  if (!(await deleteTestConversation(tx, orgId, conversationId))) throw new ServiceError("NOT_A_TEST", 409, "Solo se borra una prueba del chat web")
  return true
}

/** Las pruebas de más de 7 días se borran solas (lo llama el ciclo del worker). */
export async function purgeOldWebchatTests(tx: Db, orgId: string, now: Date): Promise<number> {
  const old = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.isTest, true), lt(conversation.createdAt, new Date(now.getTime() - TEST_KEEP_MS))))
    .limit(50)
  for (const row of old) await deleteTestConversation(tx, orgId, row.id)
  return old.length
}

// ------------------------------------------------------------ Límite de ráfagas ---

/**
 * Límite de ráfaga persistido en DB (multiproceso): cubeta por clave y ventana
 * fija. Upsert atómico: las peticiones concurrentes incrementan sin perderse.
 * Limpia cubetas vencidas de paso (tabla operativa pequeña).
 */
export async function checkWebchatRateLimit(
  db: Db,
  key: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const rows = (await db.execute(sql`
    insert into "webchat_rate_limit" ("key", "window_start", "count")
    values (${key}, now(), 1)
    on conflict ("key") do update set
      "window_start" = case
        when "webchat_rate_limit"."window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')
        then now()
        else "webchat_rate_limit"."window_start"
      end,
      "count" = case
        when "webchat_rate_limit"."window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')
        then 1
        else "webchat_rate_limit"."count" + 1
      end
    returning "count" as "count", "window_start" as "windowStart"
  `)) as unknown as Array<{ count: number; windowStart: Date }>
  const first = rows[0]
  if (!first) throw new Error("No se pudo aplicar el límite del chat web")
  await db
    .delete(webchatRateLimit)
    .where(sql`"window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')`)
    .catch(() => {})
  if (first.count <= max) return { allowed: true, retryAfter: 0 }
  const retryAfter = Math.max(
    1,
    Math.ceil((new Date(first.windowStart).getTime() + windowMs - Date.now()) / 1000),
  )
  return { allowed: false, retryAfter }
}
