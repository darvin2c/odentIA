import {
  type AccountRemovalReason,
  type ChannelAdapter,
  type ChannelProvider,
  channelAdapters,
  type ProviderAccount,
  setTelegramWebhook,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import {
  channelConnection,
  type ConnectionHealth,
  type ConnectionMetaRemoval,
  type ConnectionOwnApp,
  type ConnectionSignup,
  conversation,
} from "@odentia/db/schema/crm"
import { and, asc, eq, max } from "drizzle-orm"
import {
  declareConfigTemplates,
  listChannelTemplates,
  syncConnectionTemplates,
  type TemplateItem,
} from "./channel-templates.js"
import {
  countConnectionMessages,
  type MessageCounts,
  requestMissingTemplates,
  settleMessageTexts,
} from "./clinic-messages.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { decryptConfig, encryptJson } from "./secrets.js"
import { checkOwnAppKeys, freshOwnApp, type OwnAppKeysChecked, settleOwnApp } from "./whatsapp-own-app.js"

type ConnectionRow = typeof channelConnection.$inferSelect

/** Lo que el proveedor responde por unos datos de conexión. */
export type ProviderCheck = Awaited<ReturnType<ChannelAdapter["validateConnection"]>>

/** Pasos que odentIA hace en Meta después de «Conectar con Facebook», en orden. */
export const SIGNUP_STEPS = ["suscribir", "registrar", "sincronizar"] as const
export type SignupStep = (typeof SIGNUP_STEPS)[number]

/** Horas que da Meta para pedir la agenda y el historial del celular (coexistencia). */
export const BUSINESS_APP_SYNC_HOURS = 24

/** Qué falta y qué no funciona mientras tanto. */
const SIGNUP_STEP_TITLE: Record<SignupStep, string> = {
  suscribir:
    "Falta que WhatsApp le avise a odentIA: lo que escriban a este número todavía no llega a la Bandeja.",
  registrar:
    "Falta registrar el número en WhatsApp: todavía no puede enviar ni recibir. Meta da 14 días desde que se entró con Facebook; pasado ese plazo hay que volver a conectar.",
  sincronizar:
    "Falta traer del celular los nombres de tu agenda y las conversaciones anteriores. Meta da 24 horas desde que se entró con Facebook; pasado ese plazo hay que volver a conectar para traerlas.",
}

/** Por qué Meta cortó la conexión de la cuenta, en palabras de la clínica. */
const META_REMOVAL_WHY: Record<AccountRemovalReason, string> = {
  access_removed: "Se le quitó el acceso a la cuenta de WhatsApp desde la configuración del negocio en Meta.",
  disconnected_in_app: "Se desconectó desde la app WhatsApp Business del celular.",
  primary_inactivity:
    "La app WhatsApp Business no se abrió en el celular principal durante unos 14 días. Para que no vuelva a pasar, ábrela al menos una vez por semana.",
  companion_inactivity: "Uno de los dispositivos vinculados a este número no se usó durante unos 30 días.",
  business_downgrade: "La cuenta del celular dejó de ser de WhatsApp Business.",
  number_changed: "Se cambió el número en la app WhatsApp Business del celular.",
  re_registered: "El número se volvió a registrar o pasó a otro celular.",
}

/** El motivo que dio Meta al cortar la conexión, o que no lo dijo. */
export function metaRemovalWhy(removal: Pick<ConnectionMetaRemoval, "reason">): string {
  return (removal.reason && META_REMOVAL_WHY[removal.reason as AccountRemovalReason]) || "Meta no dijo el motivo."
}

/**
 * Cuándo quedó hecho cada paso; nulo: falta. «sincronizar» solo es de un
 * número de la app del celular: en los demás no hay nada que traer.
 */
export function signupStepsDone(signup: ConnectionSignup): Record<SignupStep, string | null> {
  const sync = signup.sync
  return {
    suscribir: signup.subscribedAt,
    registrar: signup.registeredAt,
    sincronizar: !signup.businessApp
      ? signup.grantedAt
      : sync?.contacts && sync.history
        ? sync.history.at
        : null,
  }
}

/** Un paso de «Conectar con Facebook» que falta. */
export interface SignupPending {
  step: SignupStep
  title: string
  /** Qué respondió Meta en el último intento y qué hacer; nulo si aún no se intentó. */
  problem: string | null
}

/** Cómo va una conexión hecha con «Conectar con Facebook». */
export interface ConnectionSignupView {
  grantedAt: string
  subscribedAt: string | null
  registeredAt: string | null
  /** Lo que falta, en orden. Vacío: quedó completa. */
  pending: SignupPending[]
  /** El número sigue en la app WhatsApp Business del celular (coexistencia). */
  businessApp: boolean
  /** La clínica no quiso compartir el historial del celular al conectar. */
  historyDeclined: boolean
  /**
   * Meta cortó la conexión de la cuenta y por qué, en palabras: no llegan ni
   * salen mensajes hasta volver a conectar con el botón. Nulo: no se cortó.
   */
  metaRemoved: { at: string; why: string } | null
}

/**
 * Cómo va una conexión de WhatsApp hecha con la app propia de la clínica: lo
 * que odentIA hizo en Meta por ella y lo que sabe de sus claves.
 */
export interface ConnectionOwnAppView {
  registeredAt: string | null
  subscribedAt: string | null
  /** Qué pasó en el último intento de cada paso pendiente, en palabras. */
  problems: { suscribir?: string; registrar?: string }
  /** El número ya tenía un PIN: hay que escribirlo para registrarlo. */
  pinNeeded: boolean
  /** Cuándo vence la clave; nulo: no vence o no se supo. */
  tokenExpiresAt: string | null
  /** Meta confirmó la clave y la clave secreta; nulo: no se pudo preguntar. */
  keysCheckedAt: string | null
  /** Último aviso que llegó firmado con otra clave secreta; nulo: ninguno. */
  signatureRejectedAt: string | null
}

export interface ConnectionPublic {
  id: string
  channel: string
  provider: string
  displayName: string
  externalId: string | null
  status: string
  /** Cuándo el proveedor verificó la dirección de avisos; nulo si aún no o si el canal no lo necesita. */
  webhookVerifiedAt: string | null
  /** Lo último que el proveedor dijo de la cuenta; nulo si no lo entrega o aún no se leyó. */
  health: ConnectionHealth | null
  /**
   * Solo en una conexión hecha con «Conectar con Facebook»: cómo quedaron sus
   * pasos. Nulo en las hechas a mano. Con algo en `pending`, necesita atención.
   */
  signup: ConnectionSignupView | null
  /** Solo en WhatsApp con la app propia de la clínica; nulo en las demás o si aún no se comprobó. */
  ownApp: ConnectionOwnAppView | null
  createdAt: string
  updatedAt: string
}

/** Una conexión en la lista de Integraciones, con lo que se calcula al leer. */
export interface ConnectionOverview extends ConnectionPublic {
  /** Último mensaje recibido por esa conexión. */
  lastInboundAt: string | null
  /** Sus mensajes de WhatsApp por estado; nulo si el canal no los usa. */
  messages: MessageCounts | null
}

function signupView(signup: ConnectionSignup | null): ConnectionSignupView | null {
  if (!signup) return null
  const done = signupStepsDone(signup)
  return {
    grantedAt: signup.grantedAt,
    subscribedAt: signup.subscribedAt,
    registeredAt: signup.registeredAt,
    pending: SIGNUP_STEPS.filter((step) => !done[step]).map((step) => ({
      step,
      title: SIGNUP_STEP_TITLE[step],
      problem: signup.problems?.[step] ?? null,
    })),
    businessApp: signup.businessApp === true,
    historyDeclined: Boolean(signup.sync?.historyDeclinedAt),
    metaRemoved: signup.metaRemoved ? { at: signup.metaRemoved.at, why: metaRemovalWhy(signup.metaRemoved) } : null,
  }
}

function ownAppView(ownApp: ConnectionOwnApp | null): ConnectionOwnAppView | null {
  if (!ownApp) return null
  return {
    registeredAt: ownApp.registeredAt,
    subscribedAt: ownApp.subscribedAt,
    problems: ownApp.problems ?? {},
    pinNeeded: ownApp.pinNeeded ?? false,
    tokenExpiresAt: ownApp.tokenExpiresAt ?? null,
    keysCheckedAt: ownApp.keysCheckedAt ?? null,
    signatureRejectedAt: ownApp.signatureRejectedAt ?? null,
  }
}

/** WhatsApp a mano con un proveedor de verdad: odentIA comprueba las claves y hace en Meta lo que falta. */
function usesOwnApp(provider: string, deps: ConnectionDeps, signup: unknown = null): boolean {
  return provider === "whatsapp_cloud_api" && deps.validateExternal !== false && !signup
}

function toPublic(row: ConnectionRow): ConnectionPublic {
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    displayName: row.displayName,
    externalId: row.externalId,
    status: row.status,
    webhookVerifiedAt: row.webhookVerifiedAt?.toISOString() ?? null,
    health: row.health ?? null,
    signup: signupView(row.signup ?? null),
    ownApp: ownAppView(row.ownApp ?? null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function requireAdapter(provider: string) {
  const adapter = channelAdapters[provider as ChannelProvider]
  // Registro parcial (cada slice dueño registra el suyo): sin adaptador no
  // hay validación externa posible; nunca se crea una conexión "activa" ciega.
  if (!adapter) throw validation(`Proveedor desconocido o no registrado: ${provider}`)
  return adapter
}

/** Canal esperado por proveedor conocido; otros proveedores los valida su slice. */
const KNOWN_PROVIDER_CHANNELS: Record<string, string> = {
  whatsapp_cloud_api: "whatsapp",
  telegram_bot_api: "telegram",
  messenger: "messenger",
  instagram: "instagram",
}

/**
 * Canales que se conectan escribiendo sus datos (los demás entran con la
 * cuenta del proveedor): qué datos pide cada uno, cómo se llama la conexión si
 * nadie le pone nombre y qué decir cuando el proveedor no los acepta.
 */
const MANUAL_PROVIDERS: Record<
  string,
  { label: string; fields: [string, string][]; rejected: string }
> = {
  whatsapp_cloud_api: {
    label: "WhatsApp",
    fields: [
      ["phoneNumberId", "el identificador del número"],
      ["wabaId", "el identificador de la cuenta"],
      ["accessToken", "la clave de acceso"],
      ["appSecret", "la clave secreta de la app"],
    ],
    rejected:
      "WhatsApp no aceptó esos datos: la clave no sirve o venció, o el identificador del número no es de esa cuenta. Copia la clave de nuevo; debe ser la permanente, no la temporal de 24 horas.",
  },
  telegram_bot_api: {
    label: "Telegram",
    fields: [["botToken", "la clave del bot"]],
    rejected:
      "Telegram no aceptó esa clave. Cópiala de nuevo: te la da @BotFather al crear el bot.",
  },
  messenger: {
    label: "Messenger",
    fields: [
      ["pageId", "el identificador de la página"],
      ["pageAccessToken", "la clave de acceso de la página"],
      ["appSecret", "la clave secreta de la app"],
    ],
    rejected:
      "Facebook no aceptó esos datos: la clave no sirve o no es de esa página. Cópiala de nuevo.",
  },
  instagram: {
    label: "Instagram",
    fields: [
      ["instagramId", "el identificador de la cuenta"],
      ["accessToken", "la clave de acceso"],
      ["appSecret", "la clave secreta de la app"],
    ],
    rejected:
      "Instagram no aceptó esos datos: la clave no sirve o no es de esa cuenta. Cópiala de nuevo.",
  },
}

/**
 * Lo que guarda una conexión hecha con «Conectar con Facebook». No lleva la
 * clave secreta de una app: sus avisos llegan a la dirección de la app de
 * odentIA, firmados con la clave de esa app.
 */
const SIGNUP_FIELDS: [string, string][] = [
  ["phoneNumberId", "el identificador del número"],
  ["wabaId", "el identificador de la cuenta"],
  ["accessToken", "el permiso de la cuenta"],
]

const SIGNUP_REJECTED =
  "WhatsApp ya no acepta el permiso de esta conexión: venció o la clínica lo quitó en su cuenta de Meta. Vuelve a conectarla con «Conectar con Facebook»."

/**
 * Conexión que nace de «Conectar con Facebook», no de datos escritos a mano. El
 * proveedor ya respondió por el número fuera de la transacción: el código de
 * Meta vive 30 segundos y la red no espera con la base abierta.
 */
export interface SignupOrigin {
  /** Lo que el proveedor respondió por el número con el permiso recién dado. */
  checked: ProviderCheck
  /** Cuenta de WhatsApp Business dueña del número. */
  accountId: string
  at: Date
  /** Cuándo vence el permiso recién dado; nulo si el proveedor no lo dijo. */
  tokenExpiresAt: Date | null
  /** El número sigue en la app WhatsApp Business del celular: ya está registrado. */
  businessApp?: boolean
}

/** Canales cuya dirección de avisos se da de alta a mano en la página de Meta. */
const MANUAL_WEBHOOK_PROVIDERS = ["whatsapp_cloud_api", "messenger", "instagram"]

function assertChannelMatches(provider: string, channel: string): void {
  const expected = KNOWN_PROVIDER_CHANNELS[provider]
  if (expected && channel !== expected) {
    throw validation(`El proveedor ${provider} exige el canal "${expected}"`)
  }
}

function assertFields(fields: [string, string][], config: Record<string, unknown>): void {
  for (const [field, words] of fields) {
    const value = config[field]
    if (typeof value !== "string" || !value.trim()) throw validation(`Falta ${words}.`)
  }
}

function assertManualFields(provider: string, config: Record<string, unknown>): void {
  assertFields(MANUAL_PROVIDERS[provider]?.fields ?? [], config)
}

/** Dirección a la que el proveedor avisa los mensajes de una conexión. */
export function connectionWebhookUrl(base: string, provider: string, id: string): string {
  return `${base.replace(/\/$/, "")}/api/webhooks/channels/${provider}/${id}`
}

export async function listConnections(tx: Db, orgId: string): Promise<ConnectionPublic[]> {
  const rows = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, orgId))
    .orderBy(asc(channelConnection.createdAt))
  return rows.map(toPublic)
}

/**
 * Las conexiones con lo que Integraciones dice de cada una: cuándo recibió su
 * último mensaje y cómo están sus mensajes de WhatsApp. Dos consultas
 * agregadas para todas, no una por conexión.
 */
export async function listConnectionsOverview(
  tx: Db,
  orgId: string,
): Promise<ConnectionOverview[]> {
  const items = await listConnections(tx, orgId)
  const received = await tx
    .select({ id: conversation.channelConnectionId, at: max(conversation.lastInboundAt) })
    .from(conversation)
    .where(eq(conversation.organizationId, orgId))
    .groupBy(conversation.channelConnectionId)
  const lastInbound = new Map(received.map((row) => [row.id, row.at]))
  const withMessages = items
    .filter((item) => channelAdapters[item.provider as ChannelProvider]?.capabilities.templates)
    .map((item) => item.id)
  const counts = await countConnectionMessages(tx, orgId, withMessages)
  return items.map((item) => ({
    ...item,
    lastInboundAt: lastInbound.get(item.id)?.toISOString() ?? null,
    messages: counts.get(item.id) ?? null,
  }))
}

export interface CreateConnectionInput {
  channel: string
  provider: string
  /** Si falta, el nombre con el que el proveedor conoce la cuenta. */
  displayName?: string
  config: Record<string, unknown>
}

export interface ConnectionDeps {
  fetch: typeof fetch
  /** false en dev/e2e para no llamar al proveedor. */
  validateExternal?: boolean
  /**
   * Base pública del API. Con ella, una conexión real de Telegram registra su
   * dirección de avisos; sin ella no se puede y la conexión no recibiría nada.
   */
  webhookBaseUrl?: string
}

/** Cómo quedaron los mensajes de WhatsApp tras conectar o cambiar la clave. */
export interface ConnectionMessagesReport {
  /** La clave puede leer y pedir mensajes a WhatsApp. */
  canManage: boolean
  /** Cuántos se pidieron ahora. */
  requested: number
  /** Qué corregir si no pudo; nulo si todo fue bien. */
  error: string | null
}

export interface ConnectionChecked extends ConnectionPublic {
  /** Lo que el proveedor encontró con esos datos; nulo sin proveedor (pruebas, desarrollo). */
  account: ProviderAccount | null
  /** Solo en canales con mensajes aprobados. */
  templates: ConnectionMessagesReport | null
}

async function checkWithProvider(
  adapter: ChannelAdapter,
  provider: string,
  config: Record<string, unknown>,
  deps: ConnectionDeps,
  /** Hecha con «Conectar con Facebook»: no hay una clave que copiar de nuevo. */
  signup = false,
) {
  try {
    return await adapter.validateConnection(config, { fetch: deps.fetch })
  } catch {
    throw new ServiceError(
      "CONNECTION_REJECTED",
      400,
      signup
        ? SIGNUP_REJECTED
        : (MANUAL_PROVIDERS[provider]?.rejected ??
          "El proveedor no aceptó esos datos: revísalos y vuelve a intentar."),
    )
  }
}

/**
 * Lee la salud de la cuenta y la guarda. Lo que el proveedor no entrega queda
 * nulo; si no responde, se conserva lo último que dijo.
 */
async function refreshHealth(
  tx: Db,
  row: ConnectionRow,
  adapter: ChannelAdapter,
  config: Record<string, unknown>,
  account: ProviderAccount | null,
  deps: ConnectionDeps,
): Promise<ConnectionRow> {
  if (!adapter.readHealth || deps.validateExternal === false) return row
  let health: ConnectionHealth
  try {
    const read = await adapter.readHealth(config, { fetch: deps.fetch })
    health = {
      ...read,
      number: account?.number ?? row.health?.number ?? null,
      name: account?.name ?? row.health?.name ?? null,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    if (!account) return row
    // La cuenta sí respondió quién es: se guarda eso, y de la salud queda lo último que se supo.
    health = {
      quality: row.health?.quality ?? null,
      dailyLimit: row.health?.dailyLimit ?? null,
      unlimited: row.health?.unlimited ?? false,
      number: account.number,
      name: account.name,
      checkedAt: row.health?.checkedAt ?? new Date().toISOString(),
    }
  }
  const [updated] = await tx
    .update(channelConnection)
    .set({ health })
    .where(
      and(
        eq(channelConnection.id, row.id),
        eq(channelConnection.organizationId, row.organizationId),
      ),
    )
    .returning()
  return updated ?? row
}

/** Telegram solo avisa a la dirección que se le registra: sin esto una conexión real no recibe nada. */
async function registerTelegramWebhook(
  row: ConnectionRow,
  config: Record<string, unknown>,
  deps: ConnectionDeps,
): Promise<void> {
  if (
    row.provider !== "telegram_bot_api" ||
    deps.validateExternal === false ||
    !deps.webhookBaseUrl
  )
    return
  try {
    await setTelegramWebhook(
      config,
      connectionWebhookUrl(deps.webhookBaseUrl, row.provider, row.id),
      row.webhookSecret,
      { fetch: deps.fetch },
    )
  } catch (error) {
    throw new ServiceError(
      "CONNECTION_REJECTED",
      502,
      `Telegram no aceptó la dirección de avisos de odentIA: ${error instanceof Error ? error.message : "sin detalle"}`,
    )
  }
}

/**
 * Deja el catálogo de una conexión que usa mensajes aprobados y pide los que
 * faltan: los diez con los que viene la clínica y los que haya creado, de una
 * vez. Si la clave no puede administrarlos, la conexión sigue y se dice qué
 * corregir.
 */
async function prepareMessages(
  tx: Db,
  orgId: string,
  row: ConnectionRow,
  config: Record<string, unknown>,
  secretsKey: Buffer,
  deps: ConnectionDeps,
): Promise<ConnectionMessagesReport> {
  const templateDeps = { fetch: deps.fetch, validateExternal: deps.validateExternal }
  if (deps.validateExternal === false) {
    await declareConfigTemplates(tx, orgId, row.id, config["templates"])
  } else {
    try {
      await syncConnectionTemplates(tx, orgId, row.id, secretsKey, templateDeps)
    } catch (error) {
      return {
        canManage: false,
        requested: 0,
        error:
          error instanceof Error ? error.message : "No se pudieron leer los mensajes de la cuenta",
      }
    }
  }
  // Lo pide una persona que está conectando: se intenta aunque hoy ya hubiera fallado.
  const outcome = await requestMissingTemplates(
    tx,
    orgId,
    row.id,
    secretsKey,
    new Date(),
    templateDeps,
    { force: true },
  )
  await settleMessageTexts(tx, orgId)
  const [failed] = outcome.failed
  return {
    canManage: !failed,
    requested: outcome.requested,
    error: failed
      ? `WhatsApp no aceptó la solicitud de ${outcome.failed.length === 1 ? "un mensaje" : `${outcome.failed.length} mensajes`}: ${failed.detail}. ${
          row.signup
            ? "Vuelve a conectar con Facebook y acepta el permiso para administrar los mensajes de la cuenta."
            : "Dale a la clave el permiso para administrar mensajes (whatsapp_business_management) y vuelve a comprobar."
        }`
      : null,
  }
}

/**
 * Lo que sigue a guardar el acceso a una cuenta: su salud y, si el canal usa
 * mensajes aprobados, su catálogo y la solicitud de los que falten.
 */
async function settleAccount(
  tx: Db,
  orgId: string,
  row: ConnectionRow,
  adapter: ChannelAdapter,
  config: Record<string, unknown>,
  account: ProviderAccount | null,
  secretsKey: Buffer,
  deps: ConnectionDeps,
): Promise<{ row: ConnectionRow; templates: ConnectionMessagesReport | null }> {
  const refreshed = await refreshHealth(tx, row, adapter, config, account, deps)
  const templates = adapter.capabilities.templates
    ? await prepareMessages(tx, orgId, refreshed, config, secretsKey, deps)
    : null
  return { row: refreshed, templates }
}

/**
 * Termina una conexión de «Conectar con Facebook» ya guardada: lee la salud y
 * pide los mensajes, igual que al conectar a mano. Va después de suscribir la
 * app de odentIA a la cuenta, para no perder el aviso de una aprobación rápida.
 */
export async function completeConnectionAccount(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  account: ProviderAccount | null,
  deps: ConnectionDeps,
): Promise<ConnectionChecked> {
  const { row, config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  const adapter = requireAdapter(row.provider)
  const settled = await settleAccount(tx, orgId, row, adapter, config, account, secretsKey, deps)
  return { ...toPublic(settled.row), account, templates: settled.templates }
}

/**
 * Un solo WhatsApp por clínica: lo automático sale por un número y una conexión
 * no pertenece a una sede. Para usar otro número se desconecta antes el actual
 * (sus conversaciones se conservan). `exceptId` es la conexión que se está
 * reactivando; `exceptExternalId`, el número que se intenta conectar: si es el
 * mismo que ya está, la respuesta útil es la de «esa cuenta ya está conectada».
 */
export async function assertSingleWhatsApp(
  tx: Db,
  orgId: string,
  exceptId: string | null = null,
  exceptExternalId: string | null = null,
): Promise<void> {
  const active = await tx
    .select({
      id: channelConnection.id,
      displayName: channelConnection.displayName,
      externalId: channelConnection.externalId,
    })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
  const other = active.find(
    (row) => row.id !== exceptId && !(exceptExternalId && row.externalId === exceptExternalId),
  )
  if (other) {
    throw new ServiceError(
      "WHATSAPP_ALREADY_CONNECTED",
      409,
      `La clínica ya tiene un WhatsApp conectado («${other.displayName}»). Para usar otro número, desconecta primero ese.`,
    )
  }
}

/**
 * Crea la conexión: valida contra el proveedor (salvo validateExternal=false),
 * cifra la config y genera el webhookSecret. Nunca devuelve otros secretos.
 *
 * Dice lo que encontró (`account`) y, si el canal usa mensajes aprobados, deja
 * su catálogo y los pide todos a WhatsApp en ese momento (`templates`). Si la
 * clave no puede administrarlos, la conexión se crea igual y dice qué corregir.
 * Una conexión real de Telegram registra además su dirección de avisos.
 *
 * Con `origin` (hecha con «Conectar con Facebook») no vuelve a preguntar al
 * proveedor ni lee la salud ni pide mensajes: solo guarda la conexión con sus
 * pasos pendientes, sin esperar a la red. Lo demás lo hace
 * `completeConnectionAccount` cuando la app de odentIA ya está suscrita.
 */
export async function createConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: CreateConnectionInput,
  deps: ConnectionDeps,
  origin?: SignupOrigin,
): Promise<ConnectionChecked & { webhookSecret: string; templatesError?: string }> {
  const adapter = requireAdapter(input.provider)
  assertChannelMatches(input.provider, input.channel)
  if (!input.config || typeof input.config !== "object") throw validation("Config inválida")
  if (origin) assertFields(SIGNUP_FIELDS, input.config)
  else assertManualFields(input.provider, input.config)
  let externalId: string | null = null
  let account: ProviderAccount | null = null
  let foundName: string | null = null
  if (origin) {
    externalId = origin.checked.externalId
    account = origin.checked.account ?? null
    foundName = origin.checked.displayName
  } else if (deps.validateExternal !== false) {
    const checked = await checkWithProvider(adapter, input.provider, input.config, deps)
    externalId = checked.externalId
    account = checked.account ?? null
    foundName = checked.displayName
  }
  const ownAppKeys = !origin && usesOwnApp(input.provider, deps) ? await checkOwnAppKeys(input.config, deps) : null
  const displayName =
    input.displayName?.trim() || foundName || MANUAL_PROVIDERS[input.provider]?.label
  if (!displayName) throw validation("El nombre de la conexión es obligatorio")
  if (externalId) {
    // La misma cuenta no se conecta dos veces: se le cambia la clave a la que ya está.
    const [same] = await tx
      .select({ displayName: channelConnection.displayName, signup: channelConnection.signup })
      .from(channelConnection)
      .where(
        and(
          eq(channelConnection.organizationId, orgId),
          eq(channelConnection.provider, input.provider),
          eq(channelConnection.externalId, externalId),
        ),
      )
      .limit(1)
    if (same) {
      throw new ServiceError(
        "CONNECTION_EXISTS",
        409,
        same.signup
          ? `Esa cuenta ya está conectada como «${same.displayName}». Ábrela y vuelve a conectarla con Facebook en vez de crear otra conexión.`
          : `Esa cuenta ya está conectada como «${same.displayName}». Ábrela y cámbiale la clave en vez de crear otra conexión.`,
      )
    }
  }
  if (input.channel === "whatsapp") await assertSingleWhatsApp(tx, orgId)
  let created: ConnectionRow | undefined
  try {
    // Punto de retorno: la cuenta puede estar conectada en otra clínica.
    ;[created] = await tx.transaction((inner) =>
      inner
        .insert(channelConnection)
        .values({
          organizationId: orgId,
          channel: input.channel,
          provider: input.provider,
          displayName,
          externalId,
          configEncrypted: encryptJson(secretsKey, input.config),
          webhookSecret: crypto.randomUUID(),
          status: "active",
          ...(ownAppKeys ? { ownApp: freshOwnApp(ownAppKeys) } : {}),
          ...(origin
            ? {
                accountExternalId: origin.accountId,
                signup: {
                  grantedAt: origin.at.toISOString(),
                  subscribedAt: null,
                  // El de la app del celular ya está registrado: registrarlo otra vez lo sacaría de ella.
                  registeredAt: origin.businessApp ? origin.at.toISOString() : null,
                  problems: {},
                  ...(origin.businessApp ? { businessApp: true } : {}),
                  tokenExpiresAt: origin.tokenExpiresAt?.toISOString() ?? null,
                  tokenProblem: null,
                },
              }
            : {}),
        })
        .returning(),
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    throw new ServiceError(
      "CONNECTION_EXISTS",
      409,
      "Esa cuenta ya está conectada en otra clínica de odentIA.",
    )
  }
  if (!created) throw new Error("No se pudo crear la conexión")
  if (origin) {
    return { ...toPublic(created), account, templates: null, webhookSecret: created.webhookSecret }
  }
  await registerTelegramWebhook(created, input.config, deps)
  created = await settleOwnApp(tx, created, input.config, secretsKey, deps)
  const settled = await settleAccount(
    tx,
    orgId,
    created,
    adapter,
    input.config,
    account,
    secretsKey,
    deps,
  )
  created = settled.row
  const { templates } = settled
  return {
    ...toPublic(created),
    account,
    templates,
    webhookSecret: created.webhookSecret,
    ...(templates?.error ? { templatesError: templates.error } : {}),
  }
}

/** Conexión con config descifrada: solo worker/webhooks (nunca a la UI). */
export async function getConnectionSecrets(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
): Promise<{ row: ConnectionRow; config: Record<string, unknown> }> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conexión")
  return { row, config: decryptConfig(secretsKey, row.configEncrypted) }
}

/**
 * Activa o desactiva una conexión. Al reactivar una conexión real de Telegram
 * se registra de nuevo su dirección de avisos (pasa `secretsKey` y `deps`).
 */
export async function setConnectionStatus(
  tx: Db,
  orgId: string,
  id: string,
  status: "active" | "disabled",
  options: { secretsKey?: Buffer; deps?: ConnectionDeps } = {},
): Promise<ConnectionPublic> {
  if (status === "active") {
    const [current] = await tx
      .select({ channel: channelConnection.channel })
      .from(channelConnection)
      .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
      .limit(1)
    if (current?.channel === "whatsapp") await assertSingleWhatsApp(tx, orgId, id)
  }
  const [updated] = await tx
    .update(channelConnection)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión")
  if (status === "active" && options.secretsKey && options.deps) {
    await registerTelegramWebhook(
      updated,
      decryptConfig(options.secretsKey, updated.configEncrypted),
      options.deps,
    )
  }
  return toPublic(updated)
}

export interface ConnectionTest {
  ok: boolean
  checkedAt: string
  /** La cuenta que el proveedor reconoció; nulo si no entró. */
  account: ProviderAccount | null
  /** Qué pasó y cómo arreglarlo, cuando no entró. */
  problem: string | null
}

/**
 * Prueba la conexión contra el proveedor y dice qué encontró. No cambia el
 * nombre ni el estado de la conexión; solo guarda la salud que entregue.
 */
export async function testConnection(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  deps: ConnectionDeps,
): Promise<ConnectionTest> {
  const { row, config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  const adapter = requireAdapter(row.provider)
  const checkedAt = new Date().toISOString()
  // Sin proveedor (pruebas, desarrollo) no hay a quién preguntar: no se afirma que funcione.
  if (deps.validateExternal === false) {
    return {
      ok: false,
      checkedAt,
      account: null,
      problem: "En este entorno no se llama al proveedor: no se puede probar la conexión.",
    }
  }
  let checked: Awaited<ReturnType<ChannelAdapter["validateConnection"]>>
  try {
    checked = await checkWithProvider(adapter, row.provider, config, deps, !!row.signup)
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      account: null,
      problem: error instanceof Error ? error.message : "El proveedor no respondió",
    }
  }
  if (row.externalId && checked.externalId !== row.externalId) {
    return {
      ok: false,
      checkedAt,
      account: checked.account ?? null,
      problem: row.signup
        ? "El permiso entra a otro número, no al de esta conexión. Vuelve a conectarla con Facebook y elige este número."
        : "La clave entra a otra cuenta, no a la de esta conexión. Cámbiala por la de esta cuenta.",
    }
  }
  const account = checked.account ?? { name: checked.displayName, number: null }
  await refreshHealth(tx, row, adapter, config, account, deps)
  if (usesOwnApp(row.provider, deps, row.signup)) {
    // Con la app propia se repite todo: las claves, la suscripción y el registro del número.
    const problem = await recheckOwnApp(tx, row, config, secretsKey, deps)
    if (problem) return { ok: false, checkedAt, account, problem }
  }
  return { ok: true, checkedAt, account, problem: null }
}

/**
 * Vuelve a revisar las claves de una conexión con la app propia y a hacer en
 * Meta lo que falte. Devuelve lo primero que impide que funcione, en palabras;
 * nulo si nada. Una conexión anterior a estas comprobaciones las recibe aquí.
 */
async function recheckOwnApp(
  tx: Db,
  row: ConnectionRow,
  config: Record<string, unknown>,
  secretsKey: Buffer,
  deps: ConnectionDeps,
  pin?: string,
): Promise<string | null> {
  let keys: OwnAppKeysChecked
  try {
    keys = await checkOwnAppKeys(config, deps)
  } catch (error) {
    if (error instanceof ServiceError) return error.message
    throw error
  }
  const known = row.ownApp
  const ownApp: ConnectionOwnApp = known
    ? {
        ...known,
        tokenExpiresAt: keys.checked ? (keys.tokenExpiresAt?.toISOString() ?? null) : known.tokenExpiresAt,
        keysCheckedAt: keys.checked ? new Date().toISOString() : (known.keysCheckedAt ?? null),
      }
    : freshOwnApp(keys)
  const [current] = await tx
    .update(channelConnection)
    .set({ ownApp })
    .where(and(eq(channelConnection.id, row.id), eq(channelConnection.organizationId, row.organizationId)))
    .returning()
  const settled = await settleOwnApp(tx, current ?? row, config, secretsKey, deps, pin ? { pin } : {})
  const after = settled.ownApp
  if (!after) return null
  if (after.signatureRejectedAt) {
    return "Llegó un mensaje, pero no pudimos leerlo: Meta lo firmó con otra clave secreta. Pega la «Clave secreta de la app» de la misma app con «Cambiar la clave»."
  }
  return after.problems.registrar ?? after.problems.suscribir ?? null
}

/**
 * «Volver a comprobar» y «Registrar el número» de una conexión con la app
 * propia: revisa de nuevo las claves y hace en Meta lo que falte; con `pin`,
 * registra el número con el PIN que escribió la clínica (se guarda cifrado).
 */
export async function retryOwnApp(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  input: { pin?: string },
  deps: ConnectionDeps,
): Promise<ConnectionPublic & { problem: string | null }> {
  const { row, config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  if (row.provider !== "whatsapp_cloud_api" || row.signup) {
    throw validation("Solo una conexión de WhatsApp hecha con la app propia de la clínica se comprueba así.")
  }
  if (input.pin !== undefined && !/^\d{6}$/.test(input.pin)) throw validation("El PIN tiene 6 dígitos.")
  if (deps.validateExternal === false) {
    return { ...toPublic(row), problem: "En este entorno no se llama a Meta: no se puede comprobar." }
  }
  const problem = await recheckOwnApp(tx, row, config, secretsKey, deps, input.pin)
  const [current] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  return { ...toPublic(current ?? row), problem }
}

/**
 * Cambia la clave de una conexión sin crear otra: valida contra el proveedor,
 * exige que sea la misma cuenta y reemplaza la configuración cifrada. La
 * conexión conserva su identidad, su dirección de avisos, su clave de
 * verificación y sus conversaciones. Solo se envían los datos que cambian: los
 * demás siguen como estaban.
 *
 * Volver a conectar con Facebook es este mismo cambio (`origin`): reemplaza el
 * permiso de una conexión hecha con el botón, con las mismas reglas —la misma
 * cuenta, la misma conexión—, sin esperar a la red; la salud y los mensajes los
 * deja `completeConnectionAccount`. Una conexión hecha a mano no se vuelve a
 * conectar con el botón, ni una hecha con el botón admite una clave escrita.
 */
export async function changeConnectionCredentials(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  input: { config: Record<string, unknown> },
  deps: ConnectionDeps,
  origin?: SignupOrigin,
): Promise<ConnectionChecked> {
  const { row, config: previous } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  if (origin && !row.signup) {
    throw validation(
      "Esta conexión se hizo con los datos de la app de Meta de la clínica: se le cambia la clave, no se vuelve a conectar con Facebook.",
    )
  }
  if (!origin && row.signup) {
    throw validation(
      "Esta conexión se hizo con «Conectar con Facebook» y no usa una clave escrita: vuelve a conectarla con el botón.",
    )
  }
  if (!MANUAL_PROVIDERS[row.provider]) {
    throw validation("Esta conexión no usa una clave: se vuelve a conectar entrando con su cuenta.")
  }
  const adapter = requireAdapter(row.provider)
  if (!input.config || typeof input.config !== "object" || Object.keys(input.config).length === 0) {
    throw validation("Escribe la clave nueva.")
  }
  const config = { ...previous, ...input.config }
  if (origin) assertFields(SIGNUP_FIELDS, config)
  else assertManualFields(row.provider, config)
  let account: ProviderAccount | null = null
  let externalId = row.externalId
  if (origin) {
    if (row.externalId && origin.checked.externalId !== row.externalId) {
      throw validation(
        "En la ventana de Meta elegiste otro número. Para volver a conectar esta conexión elige el mismo número; para conectar otro, crea una conexión nueva.",
      )
    }
    externalId = origin.checked.externalId
    account = origin.checked.account ?? null
  } else if (deps.validateExternal !== false) {
    const checked = await checkWithProvider(adapter, row.provider, config, deps)
    if (row.externalId && checked.externalId !== row.externalId) {
      throw validation(
        "Esa clave es de otra cuenta. Para conectar otra cuenta crea una conexión nueva; aquí va la clave de la que ya está conectada.",
      )
    }
    externalId = checked.externalId
    account = checked.account ?? null
  }
  // Clave nueva: lo que se sabía de la anterior (vencimiento, firma rechazada) ya no vale.
  const ownAppKeys = !origin && usesOwnApp(row.provider, deps, row.signup) ? await checkOwnAppKeys(config, deps) : null
  const [updated] = await tx
    .update(channelConnection)
    .set({
      configEncrypted: encryptJson(secretsKey, config),
      externalId,
      updatedAt: new Date(),
      ...(ownAppKeys ? { ownApp: freshOwnApp(ownAppKeys, row.ownApp) } : {}),
      ...(origin && row.signup
        ? {
            accountExternalId: origin.accountId,
            // Lo ya hecho sigue hecho; el plazo para registrar corre desde este permiso.
            // Clave nueva: su vencimiento es otro y lo que falló con la anterior ya no cuenta.
            signup: {
              ...row.signup,
              ...(origin.businessApp
                ? {
                    businessApp: true,
                    // Entrar otra vez con Facebook abre otras 24 horas para traer agenda e historial.
                    sync: {},
                    registeredAt: row.signup.registeredAt ?? origin.at.toISOString(),
                    problems: row.signup.problems.suscribir ? { suscribir: row.signup.problems.suscribir } : {},
                  }
                : {}),
              grantedAt: origin.at.toISOString(),
              tokenExpiresAt: origin.tokenExpiresAt?.toISOString() ?? null,
              tokenNeverExpires: false,
              tokenProblem: null,
              // Volver a entrar con Facebook rehace la conexión que Meta había cortado.
              metaRemoved: null,
            },
          }
        : {}),
    })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión")
  if (origin) return { ...toPublic(updated), account, templates: null }
  await registerTelegramWebhook(updated, config, deps)
  const withOwnApp = await settleOwnApp(tx, updated, config, secretsKey, deps)
  // Con la clave nueva pueden pedirse los mensajes que antes no se pudo.
  const settled = await settleAccount(tx, orgId, withOwnApp, adapter, config, account, secretsKey, deps)
  return { ...toPublic(settled.row), account, templates: settled.templates }
}

export interface ConnectionSetup {
  /** Dirección de odentIA que se copia en la página del proveedor. */
  webhookUrl: string
  /** Clave con la que el proveedor verifica esa dirección. */
  verifyToken: string
  webhookVerifiedAt: string | null
  lastInboundAt: string | null
}

/**
 * Estado del alta a mano de un canal de Meta: los dos valores que se copian en
 * su página (siempre a la vista, no una sola vez), si Meta ya verificó la
 * dirección y si ya entró algún mensaje. Solo para quien configura.
 */
export async function getConnectionSetup(
  tx: Db,
  orgId: string,
  id: string,
  webhookBaseUrl: string,
): Promise<ConnectionSetup> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conexión")
  if (!MANUAL_WEBHOOK_PROVIDERS.includes(row.provider)) {
    throw validation("Este canal no necesita copiar una dirección: se conecta solo.")
  }
  if (row.signup) {
    throw validation(
      "Esta conexión se hizo con «Conectar con Facebook»: no hay una dirección que copiar, WhatsApp le avisa a odentIA.",
    )
  }
  const [received] = await tx
    .select({ at: max(conversation.lastInboundAt) })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.channelConnectionId, id)))
  return {
    webhookUrl: connectionWebhookUrl(webhookBaseUrl, row.provider, row.id),
    verifyToken: row.webhookSecret,
    webhookVerifiedAt: row.webhookVerifiedAt?.toISOString() ?? null,
    lastInboundAt: received?.at?.toISOString() ?? null,
  }
}

/** Anota que el proveedor verificó la dirección de avisos (el reto de Meta). */
export async function markWebhookVerified(tx: Db, orgId: string, id: string): Promise<void> {
  await tx
    .update(channelConnection)
    .set({ webhookVerifiedAt: new Date() })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
}

/**
 * «Actualizar»: vuelve a leer los mensajes de la cuenta, pide los que falten,
 * deja vigente lo que ya aprobó WhatsApp y refresca la salud del número.
 */
export async function syncConnectionAccount(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  deps: ConnectionDeps,
): Promise<TemplateItem[]> {
  const { row, config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  const adapter = requireAdapter(row.provider)
  const templateDeps = { fetch: deps.fetch, validateExternal: deps.validateExternal }
  await syncConnectionTemplates(tx, orgId, id, secretsKey, templateDeps)
  if (adapter.capabilities.templates) {
    await requestMissingTemplates(tx, orgId, id, secretsKey, new Date(), templateDeps, {
      force: true,
    })
    await settleMessageTexts(tx, orgId)
  }
  await refreshHealth(tx, row, adapter, config, null, deps)
  return listChannelTemplates(tx, orgId, id)
}

/**
 * Plantillas que la conexión puede enviar hoy: las aprobadas del catálogo, con
 * su texto y cuántos datos llevan. Las demás (en revisión, rechazadas,
 * pausadas) se ven en `listChannelTemplates`, no aquí.
 */
export async function getConnectionTemplates(
  tx: Db,
  orgId: string,
  id: string,
  _secretsKey?: Buffer,
): Promise<
  { name: string; language: string; body: string; variables: number; buttons: string[] }[]
> {
  const templates = await listChannelTemplates(tx, orgId, id)
  return templates
    .filter((template) => template.status === "aprobada")
    .map(({ name, language, body, variables, buttons }) => ({
      name,
      language,
      body,
      variables,
      buttons,
    }))
}
