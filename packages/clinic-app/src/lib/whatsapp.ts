import type { ConnectionItem, OwnAppState } from "./crm"
import { type ChannelField, channelAccount } from "./integrations"
import { ADMIN_NAME } from "./agent-names"
import { appWords } from "./product-words"

/**
 * WhatsApp en Configuración y en la Bandeja: lo que entrega el servidor y lo
 * que la pantalla dice con ello, calculado sin React para poder probarlo.
 *
 * Regla de los textos: lo que el servidor ya entrega en palabras —estado,
 * motivo, «mientras tanto», comprobaciones del texto, por qué no hay mensaje—
 * se muestra tal cual. Aquí solo se arma lo que la pantalla añade alrededor.
 */

/* ---------- Lo que entrega el servidor ---------- */

export type MessageStatus = "en_revision" | "aprobada" | "rechazada" | "pausada" | "deshabilitada" | "sin_pedir"
/** `plan`: «Presupuesto listo», que sale al entregar un presupuesto. */
export type MessageOrigin = "agente" | "bandeja" | "plan" | "clinica" | "cuenta"

/** Un tramo del texto tal como le llega a la persona; `data`: lo pone el sistema. */
export interface PreviewPart {
  text: string
  data: boolean
  /** En un mensaje creado en la página de Meta: posición del dato que escribe quien envía. */
  index?: number
}

export interface MessageTextState {
  /** El texto con sus datos por nombre (`{{persona}}`), como lo guarda el servidor. */
  body: string
  previewParts: PreviewPart[]
  status: MessageStatus
  statusLabel: string
  reason: string | null
  since: string | null
  /** Es el texto con el que viene odentIA. */
  isDefault: boolean
}

export interface MessageData {
  key: string
  label: string
  example: string
  required: boolean
}

export interface ClinicMessage {
  id: string
  origin: MessageOrigin
  title: string
  /** Cuándo sale; solo en los que envía el agente. */
  when: string | null
  /** `enabled`: la línea está prendida y con «el agente le escribe». */
  line: { key: string; title: string; enabled: boolean } | null
  current: MessageTextState
  /** Cambio de texto que espera a WhatsApp o que rechazó. */
  pending: MessageTextState | null
  buttons: { title: string; does: string }[]
  variables: MessageData[]
  /** Tipo de mensaje según WhatsApp, ya en palabras. */
  category: string
  /** WhatsApp lo cuenta como promoción aunque se pidió como aviso: solo sale a quien aceptó novedades (ADR 0040). */
  promotion: boolean
  /** Ya estaba en la cuenta y odentIA no sabe enviarla: la frase del servidor. Nulo en los demás. */
  unsendable: string | null
  /** Qué pasa mientras no está aprobado: frase completa del servidor. */
  meanwhile: string | null
  editable: boolean
  deletable: boolean
  canRevert: boolean
}

export interface MessageCheck {
  ok: boolean
  checks: { ok: boolean; text: string }[]
  previewParts: PreviewPart[]
}

/** Cómo quedaron los mensajes tras conectar o cambiar la clave. */
export interface ConnectionMessagesReport {
  canManage: boolean
  requested: number
  error: string | null
}

/** Lo que el proveedor reconoce con unos datos; cada parte puede faltar. */
export interface ProviderAccount {
  name?: string | null
  number?: string | null
}

/**
 * Lo que el servidor dice al conectar, por cualquiera de los dos caminos (los
 * datos de la app de Meta o el botón de Facebook), y al cambiar la clave.
 */
export interface ConnectResult {
  id: string
  /** La cuenta que WhatsApp reconoció; nulo si no se le preguntó. */
  account?: ProviderAccount | null
  templates?: ConnectionMessagesReport | null
  /** Solo al conectar a mano: la clave con la que Meta verifica la dirección. */
  webhookSecret?: string
  /** Solo con la app propia: lo que odentIA hizo en Meta y comprobó de las claves. */
  ownApp?: OwnAppState | null
}

export interface ConnectionSetup {
  webhookUrl: string
  verifyToken: string
  webhookVerifiedAt: string | null
  lastInboundAt: string | null
}

export interface ConnectionTest {
  ok: boolean
  checkedAt: string
  account: ProviderAccount | null
  problem: string | null
}

/** Un mensaje aprobado que se puede enviar a mano, con los datos de esa persona ya puestos. */
export interface ApprovedMessageOption {
  id: string
  title: string
  previewParts: PreviewPart[]
  buttons: string[]
  /** Datos que escribe quien envía: solo en mensajes creados en la página de Meta. */
  fields: { index: number; label: string }[]
}

export interface ApprovedMessages {
  data: ApprovedMessageOption[]
  /** Por qué no hay ninguno y, si el rol puede abrirla, dónde se arregla. */
  none: { text: string; fixHref: string | null } | null
}

type Since = (iso: string) => string

/* ---------- Conectar con los datos de la app de Meta ---------- */

/** Los cuatro datos de la cuenta: su nombre en palabras y cómo se llaman en Meta. */
export const WHATSAPP_FIELDS: ChannelField[] = [
  {
    key: "phoneNumberId",
    label: "Identificador del número",
    hint: "En Meta se llama «Phone number ID».",
    secret: false,
  },
  {
    key: "wabaId",
    label: "Identificador de la cuenta",
    hint: "En Meta se llama «WhatsApp Business Account ID».",
    secret: false,
  },
  {
    key: "accessToken",
    label: "Clave de acceso permanente",
    hint: "En Meta es el «token» de un usuario del sistema: el permanente, no el temporal de 24 horas.",
    secret: true,
  },
  {
    key: "appSecret",
    label: "Clave secreta de la app",
    hint: "En Meta se llama «App secret».",
    secret: true,
  },
]

/** Lo único que «Cambiar la clave» vuelve a pedir. */
export const WHATSAPP_KEY_FIELDS: ChannelField[] = WHATSAPP_FIELDS.filter((field) => field.secret)

/** Lo que deja de funcionar al desconectar, dicho antes de confirmar. */
export const WHATSAPP_DISCONNECT_CONSEQUENCE =
  "Los mensajes de WhatsApp dejarán de llegar a la Bandeja y tu equipo no podrá responderlos desde aquí. El agente dejará de atender y de enviar recordatorios y avisos por WhatsApp; lo que pueda salir por correo seguirá saliendo. Las conversaciones que ya tienes se conservan."

/** Donde la clínica agrega la forma de pago de su cuenta de WhatsApp. */
export const META_ACCOUNT_URL = "https://business.facebook.com/wa/manage/home/"

/** La cuenta que encontró el proveedor, con las palabras que entregue; `null` si no dijo ninguna. */
export function accountWords(account: ProviderAccount | null | undefined): string | null {
  const parts = [account?.number, account?.name].filter((part): part is string => Boolean(part?.trim()))
  return parts.length > 0 ? parts.join(" · ") : null
}

/**
 * En qué paso está una conexión hecha a mano: 2, falta que Meta verifique la
 * dirección; 3, falta el primer mensaje; `null`, no falta nada. Si el servidor
 * no dice si verificó, no se supone que falte.
 */
export function setupStep(state: { webhookVerifiedAt?: string | null; lastInboundAt?: string | null }): 2 | 3 | null {
  if (state.lastInboundAt) return null
  if (state.webhookVerifiedAt === undefined) return null
  return state.webhookVerifiedAt === null ? 2 : 3
}

/** Lo que le falta a una conexión activa para estar terminada. `own-app`: algo que odentIA no pudo hacer en Meta. */
export type ConnectionPending = "address" | "first-message" | "signup" | "own-app" | null

/* ---------- La app propia de la clínica en Meta ---------- */

/** Un mensaje firmado con otra clave llegó después del último que se pudo leer. */
export function ownAppSignatureProblem(state: OwnAppState | null | undefined, lastInboundAt?: string | null): boolean {
  const rejected = state?.signatureRejectedAt
  if (!rejected) return false
  return !lastInboundAt || Date.parse(rejected) > Date.parse(lastInboundAt)
}

/** Lo que odentIA no pudo hacer en Meta por la conexión: registrar el número o suscribir la app. */
export function ownAppUnfinished(state: OwnAppState | null | undefined): boolean {
  return Boolean(state && (!state.registeredAt || !state.subscribedAt))
}

export type OwnAppCheckState = "ok" | "warn" | "problem"

export interface OwnAppCheck {
  key: string
  state: OwnAppCheckState
  /** Lo que se comprobó, en negrita. */
  title: string
  /** Lo que sigue: qué significa o qué hacer. */
  text: string
}

/**
 * La lista de «Comprobar» con la app propia: cada cosa que odentIA comprobó o
 * hizo en Meta, con las palabras del servidor cuando algo falló. `day` pone la
 * fecha en palabras de la clínica.
 */
export function ownAppChecks(
  state: OwnAppState,
  { found, day, lastInboundAt = null }: { found: string | null; day: (iso: string) => string; lastInboundAt?: string | null },
): OwnAppCheck[] {
  const checks: OwnAppCheck[] = []
  if (found) checks.push({ key: "numero", state: "ok", title: "Encontramos el número", text: found })
  if (state.keysCheckedAt) {
    checks.push(
      state.tokenExpiresAt
        ? {
            key: "vence",
            state: "warn",
            title: `La clave vence el ${day(state.tokenExpiresAt)}.`,
            text: "Funciona, pero ese día dejará de enviar. Mejor genera una con caducidad «Nunca» y usa «Cambiar la clave».",
          }
        : { key: "vence", state: "ok", title: "La clave es permanente:", text: "no vence." },
      { key: "permisos", state: "ok", title: "La clave puede enviar y pedir mensajes.", text: "" },
      { key: "secreta", state: "ok", title: "La clave secreta es de la misma app.", text: "" },
    )
  } else {
    checks.push({
      key: "secreta",
      state: "warn",
      title: "No pudimos preguntarle a Meta por las claves.",
      text: "Lo comprobará el primer mensaje que llegue.",
    })
  }
  if (ownAppSignatureProblem(state, lastInboundAt)) {
    checks.push({
      key: "firma",
      state: "problem",
      title: "Llegó un mensaje, pero no pudimos leerlo.",
      text: "Meta lo firmó con otra clave secreta. Pega la «Clave secreta de la app» de la misma app con «Cambiar la clave».",
    })
  }
  checks.push(
    state.registeredAt
      ? { key: "registro", state: "ok", title: "El número quedó registrado en WhatsApp.", text: "Su PIN, si lo pusimos nosotros, queda guardado cifrado." }
      : {
          key: "registro",
          state: "problem",
          title: "Falta registrar el número en WhatsApp.",
          text: state.problems.registrar ?? "Vuelve a comprobar.",
        },
    state.subscribedAt
      ? { key: "suscripcion", state: "ok", title: "Tu app recibe los avisos de esta cuenta.", text: "" }
      : {
          key: "suscripcion",
          state: "problem",
          title: "Falta que tu app reciba los avisos de la cuenta.",
          text: state.problems.suscribir ?? "Vuelve a comprobar.",
        },
  )
  return checks
}

/** Días antes del vencimiento de la clave en que la tarjeta lo dice (lo mismo que avisa la campana). */
export const OWN_APP_TOKEN_WARN_DAYS = 7

/** «La clave vence el 25 de diciembre.» si vence dentro de 7 días o ya venció; nulo si no. */
export function ownAppExpiryWords(state: OwnAppState | null | undefined, now: number, day: (iso: string) => string): string | null {
  const at = state?.tokenExpiresAt
  if (!at) return null
  const left = Date.parse(at) - now
  if (left > OWN_APP_TOKEN_WARN_DAYS * 86_400_000) return null
  return left <= 0 ? "La clave de WhatsApp venció: los mensajes ya no salen." : `La clave de WhatsApp vence el ${day(at)}.`
}

/** El texto que se lleva «Pedir ayuda a odentIA»: en qué paso está y lo que encontró, nunca las claves. */
export function ownAppHelpText(step: number, checks: OwnAppCheck[] = []): string {
  const problems = checks.filter((check) => check.state !== "ok").map((check) => `- ${check.title} ${check.text}`.trim())
  return [
    `Me trabé conectando WhatsApp con mi propia app de Meta, en el paso ${step} de 3.`,
    ...(problems.length > 0 ? ["Lo que dice la pantalla:", ...problems] : []),
  ].join("\n")
}

/**
 * Qué falta, según cómo se conectó: con el botón de Facebook, los pasos que el
 * servidor dejó pendientes; a mano, la dirección o el primer mensaje. `setup`
 * es la lectura más reciente del alta a mano, si la hay.
 */
export function connectionPending(
  connection: ConnectionItem,
  setup?: { webhookVerifiedAt?: string | null; lastInboundAt?: string | null } | null,
): ConnectionPending {
  if (connection.status !== "active") return null
  if (connection.signup) return connection.signup.pending.length > 0 ? "signup" : null
  if (ownAppUnfinished(connection.ownApp) || ownAppSignatureProblem(connection.ownApp, setup?.lastInboundAt ?? connection.lastInboundAt)) {
    return "own-app"
  }
  const step = setupStep(setup ?? connection)
  return step === 2 ? "address" : step === 3 ? "first-message" : null
}

/** Espacio de no separación, escrito por su código para que se vea en el fuente. */
const THIN_GAP = String.fromCharCode(0xa0)

/** Miles con espacio de no separación (ISO 80000-1), igual que los escribe el servidor. */
export function countWords(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, THIN_GAP)
}

export type ConnectionTone = "ok" | "pending" | "off"

export interface ConnectionWords {
  /** El número y el nombre con que WhatsApp conoce la cuenta, o lo que la identifique. */
  title: string
  tone: ConnectionTone
  /** El estado en una palabra. */
  status: string
  /** Lo que sigue al estado: qué hace y cuándo recibió por última vez. */
  detail: string
  /** Calidad y límite diario; cada uno solo si el servidor lo entrega. */
  facts: string[]
}

/** La tarjeta de la conexión, en palabras. `pending`: lo que le falta, si algo. */
export function connectionWords(connection: ConnectionItem, since: Since, pending: ConnectionPending = null): ConnectionWords {
  const number = connection.health?.number?.trim()
  const name = connection.health?.name?.trim()
  const title = number && name ? `${number} · ${name}` : channelAccount(connection)
  if (connection.status !== "active") {
    return {
      title,
      tone: "off",
      status: "Desconectado.",
      detail: "No recibe ni envía mensajes. Las conversaciones que ya tienes se conservan.",
      facts: [],
    }
  }
  const facts: string[] = []
  const quality = connection.health?.quality
  if (quality) facts.push(`Calidad del número: ${quality}`)
  if (connection.health?.unlimited) facts.push("Puede escribirle primero a todas las personas que haga falta")
  else if (typeof connection.health?.dailyLimit === "number") {
    const limit = connection.health.dailyLimit
    facts.push(`Puede escribirle primero a ${countWords(limit)} ${limit === 1 ? "persona" : "personas"} al día`)
  }
  if (pending === "address") {
    return {
      title,
      tone: "pending",
      status: "Falta un paso.",
      detail: "Todavía no recibe mensajes: falta que WhatsApp sepa adónde avisar.",
      facts,
    }
  }
  if (pending === "signup") {
    const many = (connection.signup?.pending.length ?? 0) > 1
    return {
      title,
      tone: "pending",
      status: many ? "Faltan pasos." : "Falta un paso.",
      detail: "Todavía no quedó terminada de conectar: lo que falta está aquí abajo.",
      facts,
    }
  }
  if (pending === "own-app") {
    return {
      title,
      tone: "pending",
      status: "Necesita atención.",
      detail: ownAppSignatureProblem(connection.ownApp, connection.lastInboundAt)
        ? "Llegó un mensaje firmado con otra clave secreta: lo que falta está aquí abajo."
        : `Falta algo que ${appWords().name} no pudo hacer en Meta: está aquí abajo.`,
      facts,
    }
  }
  if (pending === "first-message") {
    return {
      title,
      tone: "ok",
      status: "Conectado.",
      detail: "Meta ya verificó la dirección. Todavía no llegó ningún mensaje.",
      facts,
    }
  }
  const last = connection.lastInboundAt
  const when = last ? since(last) : ""
  const received =
    last === undefined ? "" : last === null ? " Todavía no llegó ningún mensaje." : when ? ` Último mensaje recibido ${when}.` : ""
  return { title, tone: "ok", status: "Conectado.", detail: `Recibe y envía.${received}`, facts }
}

/* ---------- El texto de un mensaje: datos por nombre ↔ datos entre corchetes ---------- */

type DataName = Pick<MessageData, "key" | "label">

/** El mismo patrón con el que el servidor reconoce un dato por su nombre. */
const NAMED_DATA = /\{\{\s*([^{}\s]+)\s*\}\}/g
const BRACKETED = /\[([^[\]\n]+)\]/g

/** Quien escribe un dato a mano no tiene que acertar mayúsculas, tildes ni espacios. */
function plain(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** Un dato como se ve y se escribe en el campo: su nombre entre corchetes. */
export function dataToken(label: string): string {
  return `[${label}]`
}

/**
 * Del servidor al campo: cada `{{persona}}` pasa a «[Nombre de la persona]».
 * Un dato que el mensaje no declara se deja como llegó: el servidor dirá qué hacer con él.
 */
export function toFieldText(body: string, data: DataName[]): string {
  const labels = new Map(data.map((item) => [item.key, item.label]))
  return body.replace(NAMED_DATA, (whole, key: string) => {
    const label = labels.get(key)
    return label ? dataToken(label) : whole
  })
}

/**
 * Del campo al servidor: cada «[Nombre de la persona]» pasa a `{{persona}}`.
 * Unos corchetes que no nombran un dato del mensaje son texto y se quedan como están.
 */
export function toServerBody(text: string, data: DataName[]): string {
  const keys = new Map(data.map((item) => [plain(item.label), item.key]))
  return text.replace(BRACKETED, (whole, label: string) => {
    const key = keys.get(plain(label))
    return key ? `{{${key}}}` : whole
  })
}

/** Pone un dato donde está el cursor (o sobre lo seleccionado) y dice dónde queda el cursor. */
export function insertAtCursor(text: string, insert: string, start: number, end: number = start): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  return { text: text.slice(0, from) + insert + text.slice(to), cursor: from + insert.length }
}

/**
 * Los datos que puede llevar un mensaje nuevo de la clínica. El servidor no los
 * lista aparte: son los de los mensajes que envía el equipo (uno propio o
 * «Retomar la conversación»), y en uno nuevo ninguno es obligatorio.
 */
export function ownMessageData(items: ClinicMessage[]): MessageData[] {
  const source = items.find((item) => item.origin === "clinica") ?? items.find((item) => item.origin === "bandeja")
  return (source?.variables ?? []).map((item) => ({ ...item, required: false }))
}

/* ---------- La lista de mensajes ---------- */

/** El texto como le llega a la persona, de corrido. */
export function previewText(parts: PreviewPart[]): string {
  return parts.map((part) => part.text).join("")
}

export function messageGroups(items: ClinicMessage[]): { agent: ClinicMessage[]; team: ClinicMessage[] } {
  return {
    agent: items.filter((item) => item.origin === "agente"),
    team: items.filter((item) => item.origin !== "agente"),
  }
}

export type StatusTone = "ok" | "waiting" | "danger" | "off"

export const STATUS_TONE: Record<MessageStatus, StatusTone> = {
  aprobada: "ok",
  en_revision: "waiting",
  rechazada: "danger",
  pausada: "waiting",
  deshabilitada: "off",
  sin_pedir: "off",
}

// Lo que trae la plataforma lleva su nombre al leerlo: la app declara su producto después de cargar el módulo.
const SOURCE_WORDS: Record<Exclude<MessageOrigin, "agente">, string> = {
  get bandeja() {
    return `Viene con ${appWords().name}`
  },
  clinica: "Lo creó la clínica",
  cuenta: "Ya estaba en tu cuenta",
  get plan() {
    return `Viene con ${appWords().name}`
  },
}

/** De dónde sale: los automáticos dicen cómo está su línea; los demás, su origen. */
export function messageSource(item: ClinicMessage): string {
  if (item.origin !== "agente") return SOURCE_WORDS[item.origin]
  if (!item.line) return `Lo envía ${ADMIN_NAME}`
  return item.line.enabled ? "Línea prendida" : "Línea apagada"
}

/** El estado con las palabras del servidor y, si está en revisión, desde cuándo. */
export function statusWords(state: Pick<MessageTextState, "status" | "statusLabel" | "since">, since: Since): string {
  if (state.status !== "en_revision" || !state.since) return state.statusLabel
  const when = since(state.since)
  return when ? `${state.statusLabel} desde ${when}` : state.statusLabel
}

export interface MessageRowModel {
  /** El comienzo del texto, con datos de ejemplo. */
  preview: string
  source: string
  status: string
  tone: StatusTone
  /** Lo que hay que saber sin abrirlo: un cambio en espera, un rechazo, qué pasa mientras tanto. */
  note: { text: string; tone: "muted" | "waiting" | "danger" } | null
}

const stopped = (status: MessageStatus) => status === "rechazada" || status === "deshabilitada"

/** La marca de un aviso que WhatsApp pasó a promoción (ADR 0040). */
export const PROMOTION_MARK = "Meta lo considera promoción"

export function messageRow(item: ClinicMessage, since: Since): MessageRowModel {
  let note: MessageRowModel["note"] = null
  if (item.unsendable) note = { text: item.unsendable, tone: "muted" }
  else if (item.promotion) note = { text: PROMOTION_MARK, tone: "waiting" }
  else if (stopped(item.current.status)) note = { text: "Ver el motivo y qué hacer", tone: "danger" }
  else if (item.meanwhile) {
    note = {
      text: item.meanwhile,
      tone: item.pending ? (stopped(item.pending.status) ? "danger" : "waiting") : "muted",
    }
  } else if (item.line && !item.line.enabled && item.current.status === "aprobada") {
    note = { text: "Listo para cuando la prendas", tone: "muted" }
  }
  return {
    preview: previewText(item.current.previewParts),
    source: messageSource(item),
    status: statusWords(item.current, since),
    tone: STATUS_TONE[item.current.status],
    note,
  }
}

const SUMMARY_WORDS: [MessageStatus, string, string][] = [
  ["aprobada", "aprobado", "aprobados"],
  ["en_revision", "en revisión", "en revisión"],
  ["rechazada", "rechazado", "rechazados"],
  ["pausada", "pausado", "pausados"],
  ["deshabilitada", "retirado", "retirados"],
  ["sin_pedir", "sin pedir", "sin pedir"],
]

/** «6 aprobados · 1 en revisión · 1 rechazado»: cuenta el texto vigente de cada mensaje. */
export function messagesSummary(items: ClinicMessage[]): string {
  return SUMMARY_WORDS.map(([status, one, many]) => {
    const count = items.filter((item) => item.current.status === status).length
    return count === 0 ? null : `${count} ${count === 1 ? one : many}`
  })
    .filter((part): part is string => part !== null)
    .join(" · ")
}

/* ---------- Un mensaje abierto ---------- */

/** Qué significa cada estado y qué hacer; el motivo y el «mientras tanto» los da el servidor. */
export const STATUS_EXPLAINED: Record<MessageStatus, string | null> = {
  aprobada: null,
  en_revision: "WhatsApp lo está revisando. Puede tardar hasta un día; no hay nada que hacer, te avisamos cuando responda.",
  rechazada: "WhatsApp no aceptó el texto. Cámbialo y se pide de nuevo.",
  pausada:
    "WhatsApp pausa un mensaje cuando muchas personas lo bloquean o lo reportan. Suele reactivarlo solo en unas horas; si se repite, lo retira.",
  deshabilitada: "Ya no sirve para enviar. Cámbiale el texto para pedirlo de nuevo.",
  sin_pedir: "Todavía no se le pidió a WhatsApp. «Actualizar», en la lista de mensajes, lo pide.",
}

/** «Desde ayer, con el texto que trae odentIA. WhatsApp lo cuenta como mensaje de utilidad.» */
export function statusDetail(item: ClinicMessage, since: Since): string {
  const state = item.current
  const when = state.since ? since(state.since) : ""
  const catalog = item.origin === "agente" || item.origin === "bandeja" || item.origin === "plan"
  const text = catalog ? (state.isDefault ? `con el texto que trae ${appWords().name}` : "con el texto de la clínica") : ""
  const lead = [when ? `desde ${when}` : "", text].filter(Boolean).join(", ")
  const sentence = lead ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)}.` : ""
  // El tipo importa en lo que WhatsApp tiene en su poder y puede salir: de eso depende lo que cobra.
  const counted = state.status === "aprobada" || state.status === "en_revision" || state.status === "pausada"
  const category = counted ? `WhatsApp lo cuenta como mensaje de ${item.category.toLowerCase()}.` : ""
  // La categoría manda (ADR 0040): un aviso que pasó a promoción solo sale a quien aceptó novedades.
  const promotion = item.promotion
    ? "Solo se enviará a quien aceptó novedades: cambia el texto para que sea solo el aviso."
    : ""
  return [sentence, category, promotion].filter(Boolean).join(" ")
}

/* ---------- Bandeja, pasadas las 24 horas ---------- */

/**
 * Lo que la zona de escritura dice antes de escribir cuando WhatsApp ya no deja
 * hacerlo con libertad. `lastInboundAt`: `null`, la persona nunca escribió por
 * aquí; `undefined`, el servidor no lo dijo y no se supone ninguna de las dos cosas.
 */
export function closedWindowNotice(
  name: string,
  lastInboundAt: string | null | undefined,
  since: Since,
): { lead: string; rest: string } {
  if (lastInboundAt === null) {
    return {
      lead: `${name} todavía no escribió por aquí.`,
      rest: "WhatsApp solo deja escribirle primero con un mensaje aprobado. Cuando responda, podrás escribirle con libertad.",
    }
  }
  const when = lastInboundAt ? since(lastInboundAt) : ""
  return {
    lead: when ? `Pasaron 24 horas desde su último mensaje: ${name} escribió ${when}.` : `Pasaron 24 horas desde su último mensaje.`,
    rest: "Ahora WhatsApp solo deja enviarle un mensaje aprobado. Cuando responda, podrás escribirle con libertad.",
  }
}

/** Los datos que escribió quien envía, en el orden que pide el mensaje; nada si no pide ninguno. */
export function approvedValues(option: Pick<ApprovedMessageOption, "fields">, typed: Record<number, string>): string[] | undefined {
  if (option.fields.length === 0) return undefined
  return [...option.fields].sort((a, b) => a.index - b.index).map((field) => (typed[field.index] ?? "").trim())
}

/* ---------- Claves de consulta ---------- */

/** Los mensajes de una conexión: la lista de Configuración y su panel leen la misma consulta. */
export const whatsappMessagesKey = (connectionId: string) => ["whatsapp-messages", connectionId] as const

/** Los mensajes aprobados que se pueden enviar a mano en una conversación. */
export const approvedMessagesKey = (conversationId: string) => ["approved-messages", conversationId] as const
