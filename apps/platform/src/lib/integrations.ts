import { type AgentModelStatus, MODEL_CHECK_TEXT } from "./agent"
import { AGENT_MODEL_LABEL, type ConnectionItem } from "./crm"

/**
 * Integraciones (Configuración): lo que se conecta una vez. Aquí vive lo que la
 * pantalla dice de cada una —para qué sirve, cómo está y qué hace falta—,
 * calculado sin React para poder probarlo. La pantalla solo lo dibuja.
 *
 * Regla de los datos: lo que el servidor no entrega se omite. Ninguna fila
 * supone una cuenta, una fecha ni un estado que no vino en la respuesta.
 */

/* ---------- Catálogo: nombre, para qué sirve y qué pide ---------- */

/** Canales de mensajería, en el orden de la pantalla. */
export const MESSAGING_CHANNELS = ["whatsapp", "instagram", "messenger", "telegram"] as const
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number]

/** Los que se conectan en el panel lateral; WhatsApp tiene página propia. */
export type PanelChannel = Exclude<MessagingChannel, "whatsapp">

export const MAILBOX_PROVIDERS = ["gmail", "microsoft365"] as const
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number]

export type IntegrationId = MessagingChannel | MailboxProvider | "webchat" | "model"

interface IntegrationCopy {
  name: string
  /** Monograma de la fila: distingue sin depender de un logotipo. */
  mark: string
  /** Para qué sirve, en una frase. */
  purpose: string
  /** Lo mismo en corto, para la fila del teléfono. */
  purposeShort: string
  /** Qué hace falta tener a mano para conectarla. */
  toConnect: string
}

export const INTEGRATIONS: Record<IntegrationId, IntegrationCopy> = {
  whatsapp: {
    name: "WhatsApp",
    mark: "WA",
    purpose: "Atiende el agente, responde tu equipo y salen los recordatorios y avisos.",
    purposeShort: "Atención, recordatorios y avisos",
    toConnect: "el número de WhatsApp de la clínica y los datos de su cuenta de WhatsApp Business.",
  },
  instagram: {
    name: "Instagram",
    mark: "IG",
    purpose: "Responder en la Bandeja los mensajes directos de la clínica.",
    purposeShort: "Responder sus mensajes directos",
    toConnect: "la cuenta profesional de Instagram de la clínica.",
  },
  messenger: {
    name: "Messenger",
    mark: "ME",
    purpose: "Responder en la Bandeja los mensajes de tu página de Facebook.",
    purposeShort: "Responder los de tu página",
    toConnect: "la página de Facebook de la clínica.",
  },
  telegram: {
    name: "Telegram",
    mark: "TG",
    purpose: "Responder en la Bandeja lo que le escriben al bot de la clínica.",
    purposeShort: "Responder lo que le escriben al bot",
    toConnect: "la clave del bot, que da @BotFather.",
  },
  webchat: {
    name: "Chat web",
    mark: "CW",
    purpose: "El chat de tu sitio web: lo que escriben llega a la misma Bandeja.",
    purposeShort: "El chat de tu sitio web",
    toConnect: "pegar una línea en tu sitio web.",
  },
  gmail: {
    name: "Gmail",
    mark: "GM",
    purpose:
      "Tu correo de Google en la Bandeja. Por ahí salen tickets, presupuestos y los avisos a quien no tiene WhatsApp.",
    purposeShort: "Tu correo de Google en la Bandeja",
    toConnect: "entrar con la cuenta de Google de la clínica.",
  },
  microsoft365: {
    name: "Microsoft 365",
    mark: "MS",
    purpose:
      "Tu correo de Microsoft en la Bandeja. Por ahí salen tickets, presupuestos y los avisos a quien no tiene WhatsApp.",
    purposeShort: "Tu correo de Microsoft en la Bandeja",
    toConnect: "entrar con la cuenta de Microsoft de la clínica.",
  },
  model: {
    name: "Modelo del agente",
    mark: "IA",
    purpose: "La inteligencia con la que el agente entiende y escribe.",
    purposeShort: "Con qué entiende y escribe el agente",
    toConnect: "",
  },
}

/** Quién pide la autorización del buzón: se nombra a la empresa, no al proveedor técnico. */
const MAILBOX_OWNER: Record<MailboxProvider, string> = { gmail: "Google", microsoft365: "Microsoft" }

/** Lo que deja de funcionar al desconectar, dicho antes de confirmar. */
export const DISCONNECT_CONSEQUENCE: Record<PanelChannel | MailboxProvider, string> = {
  instagram:
    "Los mensajes directos de Instagram dejarán de llegar a la Bandeja y tu equipo no podrá responderlos desde aquí. Las conversaciones que ya tienes se conservan.",
  messenger:
    "Los mensajes de tu página de Facebook dejarán de llegar a la Bandeja y tu equipo no podrá responderlos desde aquí. Las conversaciones que ya tienes se conservan.",
  telegram:
    "Lo que le escriban al bot dejará de llegar a la Bandeja y tu equipo no podrá responder desde aquí. Las conversaciones que ya tienes se conservan.",
  gmail:
    "La clínica dejará de recibir correos en este buzón. Por ahí tampoco saldrán tickets, presupuestos ni avisos.",
  microsoft365:
    "La clínica dejará de recibir correos en este buzón. Por ahí tampoco saldrán tickets, presupuestos ni avisos.",
}

/* ---------- Datos para conectar un canal en el panel lateral ---------- */

export interface ChannelField {
  /** Nombre del dato en la configuración de la conexión; nunca llega a la pantalla. */
  key: string
  /** Nombre en palabras. */
  label: string
  /** Cómo se llama en el proveedor, para encontrarlo allí. */
  hint: string
  /** Una clave: se escribe oculta y es lo que «Cambiar la clave» vuelve a pedir. */
  secret: boolean
}

export interface ChannelSetup {
  provider: "telegram_bot_api" | "messenger" | "instagram"
  /** Qué pasa al conectarlo, dicho al abrir el panel. */
  intro: string
  fields: ChannelField[]
  /** El proveedor necesita que se le pegue la dirección de avisos (Meta); Telegram no. */
  pasteAddress: boolean
  /** Dónde se pegan la dirección y su clave. */
  pasteWhere: string
}

const APP_SECRET: ChannelField = {
  key: "appSecret",
  label: "Clave secreta de la app",
  hint: "En Meta se llama «App secret».",
  secret: true,
}

export const CHANNEL_SETUP: Record<PanelChannel, ChannelSetup> = {
  instagram: {
    provider: "instagram",
    intro: "Los mensajes directos de la cuenta de la clínica llegan a la Bandeja y tu equipo responde desde ahí.",
    fields: [
      {
        key: "instagramId",
        label: "Identificador de la cuenta de Instagram",
        hint: "En Meta se llama «Instagram account ID».",
        secret: false,
      },
      {
        key: "accessToken",
        label: "Clave de acceso",
        hint: "En Meta se llama «Instagram user access token».",
        secret: true,
      },
      APP_SECRET,
    ],
    pasteAddress: true,
    pasteWhere: "En tu app de Meta, en Instagram › Webhooks.",
  },
  messenger: {
    provider: "messenger",
    intro: "Los mensajes de tu página de Facebook llegan a la Bandeja y tu equipo responde desde ahí.",
    fields: [
      {
        key: "pageId",
        label: "Identificador de la página",
        hint: "En Meta se llama «Page ID».",
        secret: false,
      },
      {
        key: "pageAccessToken",
        label: "Clave de acceso",
        hint: "En Meta se llama «Page access token».",
        secret: true,
      },
      APP_SECRET,
    ],
    pasteAddress: true,
    pasteWhere: "En tu app de Meta, en Messenger › Webhooks.",
  },
  telegram: {
    provider: "telegram_bot_api",
    intro: "El bot de la clínica recibe lo que le escriben y tu equipo responde desde la Bandeja.",
    fields: [
      {
        key: "botToken",
        label: "Clave del bot",
        hint: "Te la da @BotFather, dentro de Telegram, al crear el bot. Ahí se llama «token».",
        secret: true,
      },
    ],
    pasteAddress: false,
    pasteWhere: "",
  },
}

/** Los campos que son claves: lo único que «Cambiar la clave» vuelve a pedir. */
export function secretFields(channel: PanelChannel): ChannelField[] {
  return CHANNEL_SETUP[channel].fields.filter((field) => field.secret)
}

export function isPanelChannel(channel: string): channel is PanelChannel {
  return channel === "instagram" || channel === "messenger" || channel === "telegram"
}

/* ---------- Tiempo dicho con palabras ---------- */

const MINUTE = 60_000
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * Hace cuánto pasó algo: «hace 12 minutos», «ayer», «el 3 de octubre». Vacío
 * si la fecha no se puede leer o está en el futuro: no se afirma lo que no se sabe.
 */
export function sinceWords(iso: string, now: number, locale?: string, timeZone?: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then) || then > now) return ""
  const minutes = Math.floor((now - then) / MINUTE)
  if (minutes < 1) return "hace un momento"
  if (minutes < 60) return `hace ${plural(minutes, "minuto", "minutos")}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${plural(hours, "hora", "horas")}`
  const days = Math.floor(hours / 24)
  if (days === 1) return "ayer"
  if (days < 7) return `hace ${days} días`
  // La fecha se dice en la zona de la clínica, no en la del navegador.
  return `el ${new Date(then).toLocaleDateString(locale, { day: "numeric", month: "long", ...(timeZone ? { timeZone } : {}) })}`
}

type Since = (iso: string) => string

/** «último mensaje hace 12 minutos»; `null` si el servidor no entrega la fecha. */
function lastInboundWords(at: string | null | undefined, since: Since, what: "mensaje" | "correo"): string | null {
  if (at === undefined) return null
  if (at === null) return `todavía no llegó ningún ${what}`
  const when = since(at)
  return when ? `último ${what} ${when}` : null
}

/* ---------- La fila ---------- */

export type IntegrationTone = "ok" | "off" | "attention"

/** Algo de la integración que pide revisión aunque esté conectada. */
export interface IntegrationReview {
  label: string
  /** Lo mismo en corto, para la fila del teléfono. */
  short: string
  tone: "danger" | "warning"
}

/** Tercera línea de la fila: con qué cuenta está, qué hace falta, o una nota. */
export type IntegrationDetail =
  | { kind: "account"; account: string; activity: string | null }
  | { kind: "connect"; needs: string }
  | { kind: "note"; text: string }

export interface IntegrationRowModel {
  /**
   * Identidad en la lista: la integración y su posición, no la conexión. Así
   * la fila es la misma antes y después de conectarla, y el foco vuelve a su
   * control al cerrar el panel.
   */
  key: string
  id: IntegrationId
  name: string
  mark: string
  purpose: string
  purposeShort: string
  tone: IntegrationTone
  /** El estado, en palabras. */
  status: string
  review: IntegrationReview[]
  detail: IntegrationDetail
  /** Por qué necesita atención. */
  problem: string | null
}

function base(id: IntegrationId, key: string, name?: string): Pick<IntegrationRowModel, "key" | "id" | "name" | "mark" | "purpose" | "purposeShort"> {
  const copy = INTEGRATIONS[id]
  return { key, id, name: name ?? copy.name, mark: copy.mark, purpose: copy.purpose, purposeShort: copy.purposeShort }
}

function notConnected(id: IntegrationId): IntegrationRowModel {
  return {
    ...base(id, `${id}-0`),
    tone: "off",
    status: "Sin conectar",
    review: [],
    detail: { kind: "connect", needs: INTEGRATIONS[id].toConnect },
    problem: null,
  }
}

/** Cómo está, en una palabra: lo que la fila corta dice a la derecha. */
export function rowShortWord(row: IntegrationRowModel): { text: string; tone: "warning" | "danger" | "ok" | "muted" } {
  if (row.tone === "attention") return { text: "Resolver", tone: "warning" }
  const review = row.review[0]
  if (review) return { text: review.short, tone: review.tone }
  return { text: row.status, tone: row.tone === "ok" ? "ok" : "muted" }
}

/* ---------- Mensajería ---------- */

export interface ChannelRow extends IntegrationRowModel {
  channel: MessagingChannel
  connection: ConnectionItem | null
}

/** Con qué cuenta está conectado un canal: lo que diga el proveedor antes que el nombre escrito a mano. */
export function channelAccount(connection: ConnectionItem): string {
  const number = connection.health?.number?.trim()
  const name = connection.health?.name?.trim()
  if (number) return number
  if (name) return name
  const generic = INTEGRATIONS[connection.channel as IntegrationId]?.name
  const typed = connection.displayName.trim()
  // Un nombre igual al del canal no identifica la cuenta: mejor su identificador.
  if (typed && typed !== generic) return typed
  return connection.externalId?.trim() || typed
}

/**
 * Meta no entrega mensajes hasta verificar la dirección de avisos. Solo se
 * afirma cuando el servidor dice que no la verificó y que no ha llegado nada.
 */
export function awaitsAddress(connection: ConnectionItem): boolean {
  if (connection.channel !== "instagram" && connection.channel !== "messenger") return false
  return connection.status === "active" && connection.webhookVerifiedAt === null && !connection.lastInboundAt
}

function messageReviews(messages: ConnectionItem["messages"]): IntegrationReview[] {
  const reviews: IntegrationReview[] = []
  const rejected = messages?.rechazados ?? 0
  const paused = messages?.pausados ?? 0
  if (rejected > 0) {
    reviews.push({
      label: plural(rejected, "mensaje rechazado", "mensajes rechazados"),
      short: plural(rejected, "rechazado", "rechazados"),
      tone: "danger",
    })
  }
  if (paused > 0) {
    reviews.push({
      label: plural(paused, "mensaje pausado", "mensajes pausados"),
      short: plural(paused, "pausado", "pausados"),
      tone: "warning",
    })
  }
  return reviews
}

/**
 * Lo que le falta a un WhatsApp activo para estar terminado, con la misma regla
 * que su página: los pasos que dejó pendientes el botón de Facebook o, a mano,
 * la dirección de avisos y el primer mensaje.
 */
function whatsappPending(connection: ConnectionItem): string | null {
  if (connection.signup) {
    return connection.signup.pending.length > 0 ? "Falta un paso para terminar de conectarlo." : null
  }
  if (connection.lastInboundAt || connection.webhookVerifiedAt === undefined) return null
  return connection.webhookVerifiedAt === null
    ? "Falta pegar en Meta la dirección de avisos: todavía no llega ningún mensaje."
    : "Falta la prueba: escribe «hola» al número de la clínica."
}

function channelRow(channel: MessagingChannel, connection: ConnectionItem, index: number, since: Since): ChannelRow {
  const account = channelAccount(connection)
  const common = { ...base(channel, `${channel}-${index}`), channel, connection }
  if (connection.status !== "active") {
    return {
      ...common,
      tone: "off",
      status: "Desconectado",
      review: [],
      detail: { kind: "account", account, activity: "no recibe ni envía mensajes" },
      problem: null,
    }
  }
  const parts = [lastInboundWords(connection.lastInboundAt, since, "mensaje")]
  if (channel === "whatsapp" && connection.messages) {
    const approved = connection.messages.aprobados ?? 0
    const inReview = connection.messages.enRevision ?? 0
    parts.push(plural(approved, "mensaje aprobado", "mensajes aprobados"))
    if (inReview > 0) parts.push(`${inReview} en revisión`)
  }
  const activity = parts.filter((part): part is string => Boolean(part)).join(" · ") || null
  const pending = channel === "whatsapp" ? whatsappPending(connection) : null
  if (pending) {
    return {
      ...common,
      tone: "attention",
      status: "Necesita atención",
      review: [],
      detail: { kind: "account", account, activity: null },
      problem: pending,
    }
  }
  if (awaitsAddress(connection)) {
    return {
      ...common,
      tone: "attention",
      status: "Necesita atención",
      review: [],
      detail: { kind: "account", account, activity: null },
      problem: "Falta pegar en Meta la dirección de avisos: todavía no llega ningún mensaje.",
    }
  }
  return {
    ...common,
    tone: "ok",
    status: "Conectado",
    review: channel === "whatsapp" ? messageReviews(connection.messages) : [],
    detail: { kind: "account", account, activity },
    problem: null,
  }
}

/** Una fila por conexión de cada canal; el canal sin conexión muestra cómo conectarlo. */
export function channelRows(connections: ConnectionItem[], since: Since): ChannelRow[] {
  return MESSAGING_CHANNELS.flatMap((channel): ChannelRow[] => {
    const own = connections.filter((connection) => connection.channel === channel)
    if (own.length === 0) return [{ ...notConnected(channel), channel, connection: null }]
    return own.map((connection, index) => channelRow(channel, connection, index, since))
  })
}

/* ---------- Chat web ---------- */

/** El chat de la clínica, uno solo (decisión 7 del pulido de la Bandeja): lo que entrega `/api/channels/webchat`. */
export interface WebchatSummary {
  id: string
  active: boolean
  installedOn: string | null
  sites: Array<{ origin: string; status: "permitido" | "pendiente" | "bloqueado" }>
}

export interface WebchatRow extends IntegrationRowModel {
  connection: WebchatSummary | null
}

/** Un sitio sin el «https://». */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    // Un origen mal escrito se muestra tal cual, sin romper la fila.
    return origin
  }
}

/** Dónde responde: el primer sitio permitido y, si hay más, cuántos. */
function siteOf(chat: WebchatSummary): string {
  const allowed = chat.sites.filter((site) => site.status === "permitido")
  const [first, ...rest] = allowed
  if (!first) return "Sin sitio"
  return rest.length > 0 ? `${hostOf(first.origin)} y ${plural(rest.length, "sitio más", "sitios más")}` : hostOf(first.origin)
}

export function webchatRows(
  chat: WebchatSummary | null,
  lastInboundOf: (id: string) => string | null | undefined,
  since: Since,
): WebchatRow[] {
  const pending = chat?.sites.filter((site) => site.status === "pendiente") ?? []
  // Sin instalar en ningún sitio y sin ninguno que espere su sí: lo que falta es pegar la línea.
  if (!chat || (!chat.installedOn && chat.active && pending.length === 0)) return [{ ...notConnected("webchat"), status: "Sin instalar", connection: chat }]
  const review: IntegrationReview[] = pending.length
    ? [
        {
          label: `Apareció en ${hostOf(pending[0]?.origin ?? "")}${pending.length > 1 ? ` y ${plural(pending.length - 1, "sitio más", "sitios más")}` : ""}: ¿es tuyo?`,
          short: "Espera tu sí",
          tone: "warning",
        },
      ]
    : []
  return [
    {
      ...base("webchat", "webchat-0"),
      connection: chat,
      tone: !chat.active ? "off" : review.length ? "attention" : "ok",
      status: chat.active ? "Activo" : "Desactivado",
      review,
      detail: {
        kind: "account",
        account: siteOf(chat),
        activity: chat.active ? lastInboundWords(lastInboundOf(chat.id), since, "mensaje") : "no recibe mensajes",
      },
      problem: null,
    },
  ]
}

/* ---------- Correo ---------- */

export interface MailProviderInfo {
  provider: MailboxProvider
  label: string
  channel: string
  /** odentIA ya habilitó este proveedor en la instalación. */
  configured: boolean
}

export interface MailConnection {
  id: string
  provider: MailboxProvider
  email: string | null
  displayName: string
  status: string
  /** Ya leyó el buzón al menos una vez. */
  synced: boolean
  createdAt: string
  updatedAt: string
}

export interface MailState {
  providers: MailProviderInfo[]
  connections: MailConnection[]
}

export interface MailRow extends IntegrationRowModel {
  provider: MailboxProvider
  connection: MailConnection | null
  /** Se puede iniciar la autorización: odentIA ya habilitó al proveedor. */
  available: boolean
}

function mailRow(
  provider: MailboxProvider,
  connection: MailConnection,
  index: number,
  available: boolean,
  lastInboundAt: string | null | undefined,
  since: Since,
): MailRow {
  const account = connection.email ?? connection.displayName
  const common = { ...base(provider, `${provider}-${index}`), provider, connection, available }
  if (connection.status !== "active") {
    return {
      ...common,
      tone: "attention",
      status: "Necesita atención",
      review: [],
      detail: { kind: "account", account, activity: "no trae correo nuevo" },
      problem: `${MAILBOX_OWNER[provider]} pide volver a autorizar el buzón.`,
    }
  }
  const activity =
    lastInboundWords(lastInboundAt ?? undefined, since, "correo") ??
    (connection.synced ? "lee el correo nuevo" : "todavía no trae correo: la primera lectura está pendiente")
  return {
    ...common,
    tone: "ok",
    status: "Conectado",
    review: [],
    detail: { kind: "account", account, activity },
    problem: null,
  }
}

/** Gmail y Microsoft 365, siempre las dos filas y en ese orden. */
export function mailRows(
  state: MailState,
  lastInboundOf: (id: string) => string | null | undefined,
  since: Since,
): MailRow[] {
  return MAILBOX_PROVIDERS.flatMap((provider): MailRow[] => {
    const available = state.providers.some((item) => item.provider === provider && item.configured)
    const own = state.connections.filter((connection) => connection.provider === provider)
    if (own.length > 0) {
      return own.map((connection, index) => mailRow(provider, connection, index, available, lastInboundOf(connection.id), since))
    }
    if (!available) {
      return [
        {
          ...base(provider, `${provider}-0`),
          provider,
          connection: null,
          available,
          tone: "off",
          status: "No disponible",
          review: [],
          detail: { kind: "note", text: "odentIA todavía no lo habilitó para tu clínica." },
          problem: null,
        },
      ]
    }
    return [{ ...notConnected(provider), provider, connection: null, available }]
  })
}

/* ---------- Modelo del agente ---------- */

/**
 * El modelo con la misma comprobación que el encendido de Recepción: una
 * llamada mínima que hace el servidor. Sin ella todavía, la fila dice que se
 * está comprobando y no afirma nada. Nunca dice por qué no responde: eso es
 * de odentIA, que también lo arregla; por eso la fila no ofrece acciones.
 */
export function modelRow(model: AgentModelStatus | undefined): IntegrationRowModel {
  const common = { ...base("model", "model"), review: [], detail: { kind: "account" as const, account: AGENT_MODEL_LABEL, activity: null } }
  if (!model) return { ...common, tone: "off", status: MODEL_CHECK_TEXT.checking, problem: null }
  if (model.responds) return { ...common, tone: "ok", status: "Responde", problem: null }
  return { ...common, tone: "attention", status: "No responde", problem: MODEL_CHECK_TEXT.down }
}

/* ---------- Avisos que llegan en la dirección tras autorizar un buzón ---------- */

/** Resultado de la autorización del correo: el proveedor vuelve con él en la dirección. */
export interface IntegrationsSearch {
  /** Llega como `ok=1`; se conserva tal cual para que el router no reescriba la dirección. */
  ok?: string | number
  buzon?: string
  error?: string
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/** Se lee del router y no de `window`: así la página también se genera en el servidor. */
export function validateIntegrationsSearch(search: Record<string, unknown>): IntegrationsSearch {
  const ok = typeof search.ok === "number" ? search.ok : text(search.ok)
  const buzon = text(search.buzon)
  const error = text(search.error)
  return { ...(ok !== undefined ? { ok } : {}), ...(buzon ? { buzon } : {}), ...(error ? { error } : {}) }
}

export interface MailNotice {
  tone: "success" | "danger"
  text: string
}

/** Lo que pasó al volver de autorizar el correo, dicho sin códigos. */
export function mailNotice(search: IntegrationsSearch): MailNotice | null {
  if (search.error) {
    if (search.error === "oauth-denegado") {
      return { tone: "danger", text: "No se conectó el correo: cancelaste la autorización." }
    }
    if (search.error === "oauth-sin-sesion") {
      return { tone: "danger", text: "Tu sesión se cerró mientras autorizabas. Vuelve a conectar el correo." }
    }
    return { tone: "danger", text: "No pudimos conectar el correo. Vuelve a intentarlo." }
  }
  if (!search.ok) return null
  const name = search.buzon && search.buzon in INTEGRATIONS ? INTEGRATIONS[search.buzon as IntegrationId].name : "El correo"
  return { tone: "success", text: `${name} quedó conectado: lo que llegue a ese buzón ya entra a la Bandeja.` }
}
