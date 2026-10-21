import { createHash, randomUUID } from "node:crypto"
import {
  assertValidWebchatConfig,
  createWebchatToken,
  isWebchatSessionId,
  newWebchatSessionId,
  normalizeOrigin,
  readWebchatToken,
  verifyWebchatToken,
  WEBCHAT_CHANNEL,
  type WebchatConnectionConfig,
} from "@odentia/channels"
import { normalizePhone } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, organization, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { webchatRateLimit, webchatSite, type WebchatSiteStatus } from "@odentia/db/schema/webchat"
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { z } from "zod"
import { getAgentConfig } from "./agentConfig.js"
import { findClinicName } from "./automation-routing.js"
import { createConnection, setConnectionStatus } from "./connections.js"
import { updateContact } from "./contacts.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgCountry } from "./locale.js"
import { clinicOrigin } from "./public-links.js"
import { decryptConfig, encryptJson } from "./secrets.js"
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

/** Re-export del canal lógico para rutas y seeds. */
export { WEBCHAT_CHANNEL }
export type { WebchatConnectionConfig }

const DEFAULT_COLOR = "#0f766e"
export const WEBCHAT_DEFAULT_GREETING = "Hola, ¿en qué podemos ayudarte?"
/** Una prueba se borra sola a los 7 días. */
const TEST_KEEP_MS = 7 * 24 * 3_600_000
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
  const [org] = await tx.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
  const origin = org ? clinicOrigin(org.slug) : null
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
  const config: WebchatConnectionConfig = {
    ...readConfig(row, secretsKey),
    previousSecret: row.webhookSecret,
    rotatedAt: new Date().toISOString(),
  }
  const [updated] = await tx
    .update(channelConnection)
    .set({ webhookSecret: randomUUID(), configEncrypted: encryptJson(secretsKey, config), updatedAt: new Date() })
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
}

/** Con el rol owner: la ruta pública todavía no sabe de qué clínica es. */
export async function findClinicWebchat(ownerDb: Db, secretsKey: Buffer, slug: string): Promise<PublicWebchat | null> {
  const [org] = await ownerDb.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1)
  if (!org) return null
  const row = await clinicWebchatRow(ownerDb, org.id)
  if (!row) return null
  return { orgId: org.id, connection: row, config: readConfig(row, secretsKey) }
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
  const attends = cfg.enabled && (cfg.channels === null || cfg.channels.includes(WEBCHAT_CHANNEL))
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
  const [site] = await tx.insert(webchatSite).values({ organizationId: orgId, connectionId, origin, status }).returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: null,
    action: status === "permitido" ? "webchat.site_registered" : "webchat.site_pending",
    entity: "webchat_site",
    entityId: site?.id ?? null,
    metadata: { origin },
  })
  if (status === "pendiente") {
    const admins = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    const host = new URL(origin).host
    for (const admin of admins) {
      await createWorkspaceNotification(tx, orgId, {
        userId: admin.userId,
        dedupeKey: `webchat-site:${origin}`,
        title: `El chat de tu sitio apareció en ${host}`,
        body: "Mientras no lo permitas, ahí dice «No disponible». ¿Es tuyo?",
        href: SETTINGS_HREF,
        permission: "settings.write",
      })
    }
  }
  return { origin, status }
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
  connection: typeof channelConnection.$inferSelect,
  opts: { test?: boolean } = {},
): { sessionId: string; token: string; expiresAt: number } {
  const sessionId = newWebchatSessionId(opts)
  const token = createWebchatToken(connection.webhookSecret, sessionId)
  const verified = verifyWebchatToken(connection.webhookSecret, token)
  if (!verified) throw new Error("No se pudo emitir la sesión del chat")
  return { sessionId, token, expiresAt: verified.expiresAt }
}

/**
 * La sesión de un token; nula si no es válida. Con la clave anterior (tras
 * «Generar un código nuevo») sigue valiendo y trae uno nuevo (`renewed`).
 */
export function readVisitorSession(
  found: PublicWebchat,
  token: string,
): { sessionId: string; renewed: string | null } | null {
  const read = readWebchatToken(found.config, found.connection.webhookSecret, token)
  if (!read || !isWebchatSessionId(read.sessionId)) return null
  return {
    sessionId: read.sessionId,
    renewed: read.renew ? createWebchatToken(found.connection.webhookSecret, read.sessionId) : null,
  }
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
 * crea en la ingesta).
 */
export async function pollWebchatVisitor(
  tx: Db,
  orgId: string,
  connectionId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<VisitorPoll> {
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
        text,
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
  const attends = cfg.enabled && conv.agentStatus === "on" && (cfg.channels === null || cfg.channels.includes(WEBCHAT_CHANNEL))
  const [topic] = await tx
    .select({ id: sql<string>`h.id` })
    .from(sql`agent_handoff h`)
    .where(sql`h.organization_id = ${orgId} and h.conversation_id = ${conv.id} and ${handoffOpenSql(sql.raw("h"))}`)
    .limit(1)
  return {
    messages,
    typing: !!last && last.direction === "in" && attends && now.getTime() - last.createdAt.getTime() < TYPING_MS,
    askContact: !!topic && !conv.phone && !conv.email,
    contact: masked(conv.phone, conv.email),
  }
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
  const typedPhone = input.whatsapp?.trim() || null
  const typedEmail = input.email?.trim() || null
  if (!typedPhone && !typedEmail) throw validation("Escribe tu WhatsApp o tu correo.")
  const phone = typedPhone ? normalizePhone(typedPhone, (await findOrgCountry(tx, orgId)) ?? undefined) : null
  if (typedPhone && !phone) throw validation("Escribe tu WhatsApp con el código de tu país, por ejemplo +51 987 654 321.")
  const email = typedEmail ? emailSchema.safeParse(typedEmail) : null
  if (email && !email.success) throw validation("Revisa tu correo: falta algo, como la @.")
  await updateContact(
    tx,
    orgId,
    conv.contactId,
    { ...(phone ? { phone } : {}), ...(email?.success ? { email: email.data } : {}) },
    { userId: null },
  )
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
  const { sessionId, token } = openWebchatSession(row, { test: true })
  return { sessionId, token }
}

/**
 * «Borrar esta prueba»: la conversación de prueba de esa sesión, con todo lo
 * que dejó (`delete_webchat_test`, solo una prueba de esta clínica).
 */
export async function deleteWebchatTest(tx: Db, orgId: string, input: { sessionId?: string; conversationId?: string }): Promise<boolean> {
  let conversationId = input.conversationId ?? null
  if (!conversationId && input.sessionId) {
    const row = await clinicWebchatRow(tx, orgId)
    const conv = row ? await sessionConversation(tx, orgId, row.id, input.sessionId) : null
    conversationId = conv?.id ?? null
  }
  if (!conversationId) return false
  const [result] = await tx.execute<{ deleted: boolean }>(sql`select public.delete_webchat_test(${conversationId}::uuid) as deleted`)
  if (!result?.deleted) throw new ServiceError("NOT_A_TEST", 409, "Solo se borra una prueba del chat web")
  return true
}

/** Las pruebas de más de 7 días se borran solas (lo llama el ciclo del worker). */
export async function purgeOldWebchatTests(tx: Db, orgId: string, now: Date): Promise<number> {
  const old = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.isTest, true), lt(conversation.createdAt, new Date(now.getTime() - TEST_KEEP_MS))))
    .limit(50)
  for (const row of old) await tx.execute(sql`select public.delete_webchat_test(${row.id}::uuid)`)
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
