import { randomUUID } from "node:crypto"
import {
  type ChannelProvider,
  channelAdapters,
  type ProviderTemplate,
  type TemplateCategory,
  type TemplateStatus,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { automationRule } from "@odentia/db/schema/automation"
import {
  channelConnection,
  channelTemplate,
  clinicMessage,
  clinicMessageVersion,
  contact,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { adminLineOf, beforePhrase, hourPhrase, type LineTiming, lineOfJobKind } from "./admin-lines.js"
import { lineDays, lineTiming } from "./automation.js"
import {
  AUTOMATION_MESSAGE_KEYS,
  AUTOMATION_MESSAGE_LANGUAGE,
  AUTOMATION_MESSAGES,
  type AutomationMessage,
  type AutomationMessageKey,
  BUDGET_READY_MESSAGE_KEY,
  CATALOG_MESSAGE_KEYS,
  type CatalogMessageKey,
  catalogMessageOf,
  cleanVariable,
  dataNamesOf,
  isMessageVariable,
  MESSAGE_VARIABLES,
  type MessageButton,
  type MessageSpec,
  type MessageVariable,
  namedBody,
  placePhrase,
  positionalBody,
  RESUME_MESSAGE_KEY,
  replyId,
  splitNamedBody,
} from "./automation-messages.js"
import { clinicName, findClinicName, firstName } from "./automation-routing.js"
import {
  connectionWithAdapter,
  findTemplateByName,
  listChannelTemplates,
  requestConnectionTemplate,
  retireTemplates,
  type TemplateDeps,
  type TemplateItem,
  type TemplateOrder,
} from "./channel-templates.js"
import { type MessageItem, sendTemplateOutbound } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgLocale } from "./locale.js"

/**
 * Los mensajes de WhatsApp de una clínica. Son suyos: viven en su cuenta,
 * vienen escritos por odentIA y cada clínica puede cambiarles el texto.
 *
 * - Once vienen con odentIA: los nueve que envía el agente
 *   (`AUTOMATION_MESSAGES`: uno por línea que escribe y los tres avisos de
 *   «Recordar la cita» cuando la cita cambia), «Retomar la conversación», que
 *   envía una persona desde la Bandeja, y «Presupuesto listo», que sale al
 *   entregar un presupuesto (desde Plan, el cierre de la atención o el agente).
 *   La clínica puede además crear los suyos para la Bandeja.
 * - Un texto nuevo es otra versión, con otro nombre de plantilla, que se pide a
 *   WhatsApp. Mientras está en revisión, o si la rechazan, sigue saliendo la
 *   versión vigente: un cambio nunca deja a la clínica sin mensaje.
 * - El texto vigente es uno solo para todas las vías (plantilla, respuesta
 *   dentro de las 24 horas y correo). Sin WhatsApp, o sin ninguna versión
 *   aprobada todavía, vale el último texto guardado.
 *
 * Motivos en `docs/decisions/0019-mensajes-de-whatsapp-de-cada-clinica.md`.
 * Sin proveedor (pruebas, desarrollo) una solicitud queda «en revisión» y no
 * cambia sola: nada de esto acredita que WhatsApp acepte un texto.
 */

type MessageRow = typeof clinicMessage.$inferSelect
type VersionRow = typeof clinicMessageVersion.$inferSelect

/** Dónde se administran: los avisos y la Bandeja llevan ahí. */
export const MESSAGES_HREF = "/settings/integrations/whatsapp"

/** Reglas del texto de una plantilla de WhatsApp. */
export const MESSAGE_BODY_MAX = 1024
export const MESSAGE_TITLE_MAX = 60
/** El botón también sale dentro de las 24 horas, donde WhatsApp admite 20 caracteres. */
export const MESSAGE_BUTTON_MAX = 20
/** Mensajes propios que una clínica puede tener a la vez. */
export const OWN_MESSAGES_MAX = 20

/** `plan`: «Presupuesto listo», que sale al entregar el presupuesto. */
export type MessageOrigin = "agente" | "bandeja" | "plan" | "clinica" | "cuenta"
/** El estado que da WhatsApp, o `sin_pedir` si todavía no se le pidió. */
export type MessageStatus = TemplateStatus | "sin_pedir"

const STATUS_LABELS: Record<MessageStatus, string> = {
  aprobada: "Aprobado",
  en_revision: "En revisión",
  rechazada: "Rechazado",
  pausada: "Pausado por WhatsApp",
  deshabilitada: "Retirado por WhatsApp",
  sin_pedir: "Sin pedir a WhatsApp",
}

const CATEGORY_LABELS: Record<string, string> = {
  utility: "Utilidad",
  marketing: "Marketing",
  authentication: "Autenticación",
}

/**
 * Motivos de rechazo que WhatsApp entrega como código, dichos en palabras. Uno
 * que no esté aquí se muestra tal como llegó.
 */
const REASON_WORDS: Record<string, string> = {
  ABUSIVE_CONTENT: "WhatsApp considera que el contenido es abusivo",
  INVALID_FORMAT: "El formato del texto no cumple las reglas de WhatsApp",
  PROMOTIONAL: "WhatsApp lo considera promocional",
  SCAM: "WhatsApp lo considera engañoso",
  TAG_CONTENT_MISMATCH: "El texto no corresponde al tipo de mensaje con el que se pidió",
}

export function templateReasonWords(reason: string | null): string | null {
  if (!reason) return null
  return REASON_WORDS[reason.trim().toUpperCase()] ?? reason
}

/** Un texto de un mensaje: el de odentIA (0) o uno que guardó la clínica. */
interface MessageText {
  number: number
  /** Con sus datos por nombre. */
  body: string
  templateName: string
  isDefault: boolean
}

interface MessageDef {
  /** Clave del catálogo o identificador del mensaje propio. */
  id: string
  origin: Exclude<MessageOrigin, "cuenta">
  title: string
  catalog: MessageSpec | null
  row: MessageRow | null
  versions: VersionRow[]
  /** Datos que puede llevar; `required`: no puede faltar. */
  data: { key: MessageVariable; required: boolean }[]
  buttons: readonly MessageButton[]
  category: TemplateCategory
}

const OWN_DATA: MessageDef["data"] = [
  { key: "persona", required: false },
  { key: "clinica", required: false },
]

/** Los avisos de «Recordar la cita» no son una línea: cada uno dice qué avisa. */
const NOTICE_TITLES: Record<string, string> = {
  aviso_cita_reservada: "Recordar la cita: cita reservada",
  aviso_cita_movida: "Recordar la cita: cambio de fecha",
  aviso_cita_cancelada: "Recordar la cita: cita cancelada",
}

function catalogTitle(key: CatalogMessageKey): string {
  if (key === RESUME_MESSAGE_KEY) return "Retomar la conversación"
  if (key === BUDGET_READY_MESSAGE_KEY) return "Presupuesto listo"
  return NOTICE_TITLES[key] ?? adminLineOf(key)?.name ?? key
}

function catalogDef(
  key: CatalogMessageKey,
  row: MessageRow | null,
  versions: VersionRow[],
): MessageDef {
  const spec = catalogMessageOf(key)
  if (!spec) throw new Error(`Mensaje del catálogo desconocido: ${key}`)
  return {
    id: key,
    origin: key === RESUME_MESSAGE_KEY ? "bandeja" : key === BUDGET_READY_MESSAGE_KEY ? "plan" : "agente",
    title: catalogTitle(key),
    catalog: spec,
    row,
    versions,
    data: spec.variables.map((name) => ({ key: name, required: true })),
    buttons: spec.buttons,
    category: spec.category,
  }
}

function ownDef(row: MessageRow, versions: VersionRow[]): MessageDef {
  return {
    id: row.id,
    origin: "clinica",
    title: row.title ?? "",
    catalog: null,
    row,
    versions,
    data: OWN_DATA,
    buttons: row.buttonTitle ? [{ action: "responder", title: row.buttonTitle }] : [],
    // Se pide como utilidad; WhatsApp decide la categoría y puede asignar otra.
    category: "utility",
  }
}

function textOf(def: MessageDef, number: number): MessageText | null {
  if (number === 0) {
    return def.catalog
      ? {
          number: 0,
          body: namedBody(def.catalog),
          templateName: def.catalog.template,
          isDefault: true,
        }
      : null
  }
  const version = def.versions.find((item) => item.number === number)
  return version
    ? { number, body: version.body, templateName: version.templateName, isDefault: false }
    : null
}

/** El texto vigente. Un mensaje del catálogo siempre tiene uno: el de odentIA. */
function currentText(def: MessageDef): MessageText {
  const text =
    textOf(def, def.row?.currentVersion ?? 0) ??
    textOf(def, 0) ??
    textOf(def, def.versions.at(-1)?.number ?? 0)
  if (!text) throw new Error(`El mensaje ${def.id} no tiene texto`)
  return text
}

function pendingText(def: MessageDef): MessageText | null {
  const number = def.row?.pendingVersion
  return number === null || number === undefined ? null : textOf(def, number)
}

function orderOf(def: MessageDef, text: MessageText): TemplateOrder {
  const { body, variables } = positionalBody(text.body)
  return {
    name: text.templateName,
    category: def.category,
    body,
    examples: variables.map((name) => MESSAGE_VARIABLES[name].example),
    buttons: def.buttons.map((button) => button.title),
    messageKey: def.catalog?.key ?? null,
  }
}

// ----------------------------------------------------------------- lectura ---

async function loadMessages(
  tx: Db,
  orgId: string,
): Promise<{ defs: MessageDef[]; known: Set<string> }> {
  const rows = await tx
    .select()
    .from(clinicMessage)
    .where(eq(clinicMessage.organizationId, orgId))
    .orderBy(asc(clinicMessage.createdAt), asc(clinicMessage.id))
  const versions = await tx
    .select()
    .from(clinicMessageVersion)
    .where(eq(clinicMessageVersion.organizationId, orgId))
    .orderBy(asc(clinicMessageVersion.number))
  const versionsOf = (id: string) => versions.filter((version) => version.messageId === id)
  const defs: MessageDef[] = CATALOG_MESSAGE_KEYS.map((key) => {
    const row = rows.find((item) => item.key === key) ?? null
    return catalogDef(key, row, row ? versionsOf(row.id) : [])
  })
  for (const row of rows) {
    if (row.key === null && row.archivedAt === null) defs.push(ownDef(row, versionsOf(row.id)))
  }
  // Toda plantilla que es de un mensaje de la clínica, incluidas las de textos
  // ya reemplazados y las de mensajes eliminados: no son «de la cuenta».
  const known = new Set<string>(versions.map((version) => version.templateName))
  for (const key of CATALOG_MESSAGE_KEYS) known.add(catalogMessageOf(key)?.template ?? "")
  return { defs, known }
}

async function loadMessage(tx: Db, orgId: string, messageId: string): Promise<MessageDef> {
  const { defs } = await loadMessages(tx, orgId)
  const def = defs.find((item) => item.id === messageId)
  if (!def) throw notFound("Mensaje")
  return def
}

/**
 * El mensaje de una línea con el texto vigente de la clínica: de aquí salen la
 * plantilla, la respuesta dentro de las 24 horas y el correo.
 */
export async function currentAutomationMessage(
  tx: Db,
  orgId: string,
  key: AutomationMessageKey,
): Promise<AutomationMessage> {
  const base = AUTOMATION_MESSAGES[key]
  return { ...base, ...(await currentTextOf(tx, orgId, base)) }
}

/** Lo mismo para un tipo de trabajo que puede no tener mensaje. */
export async function currentAutomationMessageOf(
  tx: Db,
  orgId: string,
  kind: string,
): Promise<AutomationMessage | null> {
  return (AUTOMATION_MESSAGE_KEYS as readonly string[]).includes(kind)
    ? currentAutomationMessage(tx, orgId, kind as AutomationMessageKey)
    : null
}

async function currentTextOf(
  tx: Db,
  orgId: string,
  base: MessageSpec,
): Promise<Pick<MessageSpec, "template" | "body" | "variables">> {
  const [row] = await tx
    .select({ id: clinicMessage.id, currentVersion: clinicMessage.currentVersion })
    .from(clinicMessage)
    .where(and(eq(clinicMessage.organizationId, orgId), eq(clinicMessage.key, base.key)))
    .limit(1)
  if (!row || row.currentVersion === 0) return base
  const [version] = await tx
    .select({ body: clinicMessageVersion.body, templateName: clinicMessageVersion.templateName })
    .from(clinicMessageVersion)
    .where(
      and(
        eq(clinicMessageVersion.organizationId, orgId),
        eq(clinicMessageVersion.messageId, row.id),
        eq(clinicMessageVersion.number, row.currentVersion),
      ),
    )
    .limit(1)
  if (!version) return base
  return { template: version.templateName, ...positionalBody(version.body) }
}

/**
 * Un mensaje del catálogo con el texto vigente de la clínica (plantilla,
 * cuerpo y datos): de aquí salen la plantilla, la respuesta y el correo.
 */
export async function currentCatalogMessage(tx: Db, orgId: string, key: CatalogMessageKey): Promise<MessageSpec> {
  const base = catalogMessageOf(key)
  if (!base) throw new Error(`Mensaje del catálogo desconocido: ${key}`)
  return { ...base, ...(await currentTextOf(tx, orgId, base)) }
}

/** Plantilla del texto vigente de un mensaje del catálogo en una conexión, en el estado que tenga. */
export async function findMessageTemplate(
  tx: Db,
  orgId: string,
  connectionId: string,
  key: CatalogMessageKey,
): Promise<TemplateItem | null> {
  const base = catalogMessageOf(key)
  if (!base) return null
  const { template } = await currentTextOf(tx, orgId, base)
  return findTemplateByName(tx, orgId, connectionId, template)
}

async function activeWhatsApps(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
  return rows.map((row) => row.id)
}

/** Las plantillas en el idioma de los mensajes de la clínica, por nombre. */
function byName(items: TemplateItem[]): Map<string, TemplateItem> {
  const own = items.filter((item) => item.language === AUTOMATION_MESSAGE_LANGUAGE)
  return new Map(own.map((item) => [item.name, item]))
}

async function templatesOf(
  tx: Db,
  orgId: string,
  connectionId: string,
): Promise<Map<string, TemplateItem>> {
  return byName(await listChannelTemplates(tx, orgId, connectionId))
}

function statusIn(templates: Map<string, TemplateItem>, text: MessageText): MessageStatus {
  return templates.get(text.templateName)?.status ?? "sin_pedir"
}

async function requireTemplateConnection(tx: Db, orgId: string, connectionId: string) {
  const [row] = await tx
    .select({
      id: channelConnection.id,
      provider: channelConnection.provider,
      status: channelConnection.status,
    })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conexión")
  if (!channelAdapters[row.provider as ChannelProvider]?.capabilities.templates) {
    throw validation("Este canal no usa mensajes aprobados")
  }
  return row
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
  entity: "clinic_message" | "channel_connection" = "clinic_message",
): Promise<void> {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, action, entity, entityId, metadata })
}

// ------------------------------------------------------------ validación ---

export interface TextCheck {
  ok: boolean
  text: string
}

export interface PreviewPart {
  text: string
  /** Lo pone el sistema al enviar. */
  data: boolean
  /** En una plantilla de la cuenta: posición del dato que escribe quien envía. */
  index?: number
}

function count(n: number): string {
  // Miles con espacio de no separación (ISO 80000-1), sin punto ni coma.
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")
}

const NUMBER_WORDS = ["", "el dato", "los dos datos", "los tres datos", "los cuatro datos"]

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim()
}

/**
 * Las reglas del texto de un mensaje, en un solo sitio: las aplican la vista
 * previa, guardar y crear. Cada falla lleva su frase tal como se muestra.
 */
function checkBody(raw: string, data: MessageDef["data"]): TextCheck[] {
  const body = normalizeBody(raw)
  if (!body) return [{ ok: false, text: "Escribe el texto del mensaje." }]
  const checks: TextCheck[] = []
  const names = dataNamesOf(body)
  const allowed = new Map(data.map((item) => [item.key as string, item]))
  const label = (name: string) => (isMessageVariable(name) ? MESSAGE_VARIABLES[name].label : name)
  const problems: string[] = []
  for (const name of new Set(names)) {
    if (!allowed.has(name)) problems.push(`«${name}» no es un dato de este mensaje: quítalo.`)
    else if (names.filter((item) => item === name).length > 1) {
      problems.push(`El dato «${label(name)}» está más de una vez: va una sola.`)
    }
  }
  for (const item of data) {
    if (item.required && !names.includes(item.key))
      problems.push(`Falta el dato «${label(item.key)}».`)
  }
  if (body.replace(/\{\{\s*[^{}\s]+\s*\}\}/g, "").match(/\{\{|\}\}/)) {
    problems.push("Hay llaves sueltas: un dato se elige de la lista, no se escribe a mano.")
  }
  if (problems.length > 0) checks.push(...problems.map((text) => ({ ok: false, text })))
  else {
    const required = data.filter((item) => item.required).length
    if (required > 0) {
      checks.push({
        ok: true,
        text: `Bien: ${required === 1 ? "está" : "están"} ${NUMBER_WORDS[required] ?? `los ${required} datos`}.`,
      })
    }
  }
  if (names.length > 0) {
    const edges = /^\{\{[^{}]*\}\}/.test(body) || /\{\{[^{}]*\}\}$/.test(body)
    checks.push(
      edges
        ? {
            ok: false,
            text: "No puede empezar ni terminar con un dato: WhatsApp pide texto antes y después.",
          }
        : { ok: true, text: "Bien: no empieza ni termina con un dato." },
    )
  }
  // WhatsApp cuenta el texto con cada dato en su forma corta (`{{1}}`).
  const length = positionalBody(body).body.length
  checks.push(
    length > MESSAGE_BODY_MAX
      ? {
          ok: false,
          text: `Tiene ${count(length)} caracteres y el máximo es ${count(MESSAGE_BODY_MAX)}.`,
        }
      : { ok: true, text: `Bien: ${count(length)} de ${count(MESSAGE_BODY_MAX)} caracteres.` },
  )
  if (body.includes("\t"))
    checks.push({ ok: false, text: "Tiene tabulaciones: cámbialas por un espacio." })
  if (/\n{3,}/.test(body)) {
    checks.push({
      ok: false,
      text: "Tiene más de dos saltos de línea seguidos: deja como mucho una línea en blanco.",
    })
  }
  return checks
}

function checkOwnParts(title: string | undefined, buttonTitle: string | undefined): TextCheck[] {
  const checks: TextCheck[] = []
  const name = (title ?? "").trim()
  if (!name) checks.push({ ok: false, text: "Escribe para qué sirve el mensaje." })
  else if (name.length > MESSAGE_TITLE_MAX) {
    checks.push({
      ok: false,
      text: `«Para qué sirve» admite hasta ${MESSAGE_TITLE_MAX} caracteres.`,
    })
  }
  const button = (buttonTitle ?? "").trim()
  if (button.length > MESSAGE_BUTTON_MAX) {
    checks.push({ ok: false, text: `El botón admite hasta ${MESSAGE_BUTTON_MAX} caracteres.` })
  }
  if (/[\n\t]/.test(buttonTitle ?? ""))
    checks.push({ ok: false, text: "El botón va en una sola línea." })
  return checks
}

/** Valores de ejemplo para la vista previa: los de la clínica donde se conocen. */
async function exampleValues(tx: Db, orgId: string): Promise<Record<MessageVariable, string>> {
  const clinic = await findClinicName(tx, orgId)
  const [site] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.organizationId, orgId))
    .orderBy(asc(branch.createdAt), asc(branch.id))
    .limit(1)
  const values = Object.fromEntries(
    Object.entries(MESSAGE_VARIABLES).map(([name, spec]) => [name, spec.example]),
  ) as Record<MessageVariable, string>
  // Sin perfil no se supone el nombre de la clínica: quedan los del ejemplo.
  if (clinic) {
    values.clinica = cleanVariable(clinic)
    values.lugar = cleanVariable(placePhrase(clinic, site?.name ?? "Centro"))
  }
  return values
}

function previewOf(body: string, values: Partial<Record<MessageVariable, string>>): PreviewPart[] {
  return splitNamedBody(body).map((part) =>
    part.name === null
      ? { text: part.text, data: false }
      : {
          text: isMessageVariable(part.name)
            ? (values[part.name] ?? MESSAGE_VARIABLES[part.name].label)
            : part.text,
          data: true,
        },
  )
}

/** Vista previa de una plantilla de la cuenta: sus datos van por posición y los escribe quien envía. */
function positionalPreview(body: string): PreviewPart[] {
  const parts: PreviewPart[] = []
  let last = 0
  for (const match of body.matchAll(/\{\{(\d+)\}\}/g)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: body.slice(last, at), data: false })
    parts.push({ text: `dato ${match[1]}`, data: true, index: Number(match[1]) })
    last = at + match[0].length
  }
  if (last < body.length) parts.push({ text: body.slice(last), data: false })
  return parts
}

export interface CheckMessageInput {
  /** Mensaje que se edita; sin él se comprueba uno nuevo de la clínica. */
  messageId?: string
  title?: string
  body: string
  buttonTitle?: string
}

/** Comprueba un texto mientras se escribe, sin guardar nada. */
export async function checkMessageText(
  tx: Db,
  orgId: string,
  connectionId: string,
  input: CheckMessageInput,
): Promise<{ ok: boolean; checks: TextCheck[]; previewParts: PreviewPart[] }> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const def = input.messageId ? await loadMessage(tx, orgId, input.messageId) : null
  const checks = checkBody(input.body, def?.data ?? OWN_DATA)
  if (!def) checks.unshift(...checkOwnParts(input.title, input.buttonTitle))
  else if (
    input.buttonTitle !== undefined &&
    (input.buttonTitle.trim() || "") !== (def.row?.buttonTitle ?? "")
  ) {
    checks.push({ ok: false, text: "Los botones de este mensaje no se cambian." })
  }
  return {
    ok: checks.every((check) => check.ok),
    checks,
    previewParts: previewOf(normalizeBody(input.body), await exampleValues(tx, orgId)),
  }
}

function assertValid(checks: TextCheck[]): void {
  const failed = checks.find((check) => !check.ok)
  if (failed) throw validation(failed.text)
}

// ------------------------------------------------- pedir y dejar vigente ---

export interface RequestOutcome {
  /** Solicitudes que el proveedor aceptó ahora. */
  requested: number
  /** Las que no aceptó, con su motivo. */
  failed: { title: string; detail: string }[]
}

/**
 * Pide a WhatsApp, en una conexión, los mensajes de la clínica que aún no
 * tiene: el texto vigente y el cambio pendiente de cada uno, los prenda o no
 * una línea. Una solicitud que el proveedor no acepta se anota y no se repite
 * ese día, salvo que lo pida una persona (`force`).
 */
export async function requestMissingTemplates(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  now: Date,
  deps: TemplateDeps,
  options: { force?: boolean } = {},
): Promise<RequestOutcome> {
  const { defs } = await loadMessages(tx, orgId)
  const have = await templatesOf(tx, orgId, connectionId)
  const day = now.toISOString().slice(0, 10)
  const attempted = options.force
    ? new Set<string>()
    : new Set(
        (
          await tx.execute<{ template: string | null }>(sql`
            select metadata->>'template' as template from audit_event
            where organization_id = ${orgId} and action = 'channel_template.request_failed'
              and entity_id = ${connectionId} and metadata->>'day' = ${day}`)
        ).map((row) => row.template),
      )
  const outcome: RequestOutcome = { requested: 0, failed: [] }
  for (const def of defs) {
    const texts = [currentText(def), pendingText(def)].filter((text): text is MessageText => !!text)
    for (const text of texts) {
      if (have.has(text.templateName) || attempted.has(text.templateName)) continue
      try {
        // Punto de retorno: un rechazo del proveedor no debe abortar lo demás.
        const item = await tx.transaction((inner) =>
          requestConnectionTemplate(
            inner,
            orgId,
            connectionId,
            orderOf(def, text),
            secretsKey,
            deps,
          ),
        )
        have.set(item.name, item)
        outcome.requested++
        await audit(
          tx,
          orgId,
          null,
          "channel_template.requested",
          connectionId,
          { messageKey: def.id, template: text.templateName },
          "channel_connection",
        )
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error
        const detail = error.message.slice(0, 300)
        outcome.failed.push({ title: def.title, detail })
        await audit(
          tx,
          orgId,
          null,
          "channel_template.request_failed",
          connectionId,
          { messageKey: def.id, template: text.templateName, day, detail },
          "channel_connection",
        )
      }
    }
  }
  return outcome
}

/**
 * Deja vigente el cambio de texto que ya puede serlo: lo aprobó WhatsApp, la
 * clínica no tiene WhatsApp, o el texto anterior tampoco está aprobado y el
 * nuevo no fue rechazado (entonces vale el último guardado). La aprobación se
 * mira en la conexión por la que salen los mensajes automáticos.
 */
export async function settleMessageTexts(tx: Db, orgId: string): Promise<number> {
  const waiting = await tx
    .select({ id: clinicMessage.id })
    .from(clinicMessage)
    .where(
      and(
        eq(clinicMessage.organizationId, orgId),
        isNotNull(clinicMessage.pendingVersion),
        isNull(clinicMessage.archivedAt),
      ),
    )
  if (waiting.length === 0) return 0
  const { defs } = await loadMessages(tx, orgId)
  const [primary] = await activeWhatsApps(tx, orgId)
  const templates = primary ? await templatesOf(tx, orgId, primary) : null
  let settled = 0
  for (const def of defs) {
    const pending = pendingText(def)
    if (!def.row || !pending) continue
    const next = templates ? statusIn(templates, pending) : null
    const inEffect = templates ? statusIn(templates, currentText(def)) : null
    const promote =
      !templates ||
      next === "aprobada" ||
      (inEffect !== "aprobada" && next !== "rechazada" && next !== "deshabilitada")
    if (!promote) continue
    await tx
      .update(clinicMessage)
      .set({ currentVersion: pending.number, pendingVersion: null, updatedAt: new Date() })
      .where(and(eq(clinicMessage.id, def.row.id), eq(clinicMessage.organizationId, orgId)))
    await audit(tx, orgId, null, "clinic_message.text_in_effect", def.row.id, {
      message: def.id,
      version: pending.number,
    })
    settled++
  }
  return settled
}

/** A qué mensaje de la clínica pertenece una plantilla, por su nombre. */
export async function messageOfTemplate(
  tx: Db,
  orgId: string,
  templateName: string,
): Promise<{
  id: string
  origin: Exclude<MessageOrigin, "cuenta">
  title: string
  isCurrent: boolean
  isPending: boolean
} | null> {
  const { defs } = await loadMessages(tx, orgId)
  for (const def of defs) {
    const isCurrent = currentText(def).templateName === templateName
    const isPending = pendingText(def)?.templateName === templateName
    const belongs =
      isCurrent ||
      isPending ||
      def.catalog?.template === templateName ||
      def.versions.some((version) => version.templateName === templateName)
    if (belongs) return { id: def.id, origin: def.origin, title: def.title, isCurrent, isPending }
  }
  return null
}

// --------------------------------------------- la lista de Configuración ---

export interface MessageTextState {
  /** El texto con sus datos por nombre (`{{persona}}`), como se edita. */
  body: string
  /** El mismo texto con datos de ejemplo, como le llega a la persona. */
  previewParts: PreviewPart[]
  status: MessageStatus
  statusLabel: string
  /** Motivo de WhatsApp cuando lo rechaza, lo pausa o lo retira. */
  reason: string | null
  /** Desde cuándo está en ese estado; nulo si no se sabe. */
  since: string | null
  /** Es el texto con el que viene odentIA. */
  isDefault: boolean
}

export interface ClinicMessageItem {
  /** Clave del catálogo, identificador del mensaje propio o de la plantilla de la cuenta. */
  id: string
  origin: MessageOrigin
  title: string
  /** Cuándo sale; en los que envía el agente y en «Presupuesto listo». */
  when: string | null
  /** Línea del Administrador que lo usa; `enabled`: prendida y con «el agente le escribe». */
  line: { key: string; title: string; enabled: boolean } | null
  current: MessageTextState
  /** Cambio de texto que espera a WhatsApp o que rechazó. */
  pending: MessageTextState | null
  buttons: { title: string; does: string }[]
  variables: { key: string; label: string; example: string; required: boolean }[]
  /** Tipo de mensaje según WhatsApp, en palabras. */
  category: string
  /** Qué pasa mientras no está aprobado; nulo si no hay nada que esperar. */
  meanwhile: string | null
  editable: boolean
  deletable: boolean
  canRevert: boolean
}

const HOURS = (n: number) => (n === 1 ? "una hora" : `${n} horas`)
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** «Cuándo sale» de cada mensaje del agente, con los tiempos vigentes de su línea. */
const WHEN: Record<AutomationMessageKey, (days: number | null, timing: LineTiming) => string> = {
  recordatorio_cita: (_, timing) => `${capital(beforePhrase(timing.hoursBefore))} de la cita.`,
  recordatorio_control: () => "Dos días antes de un control pendiente.",
  seguimiento_presupuesto: (days) =>
    `Cuando un presupuesto lleva ${days === 1 ? "1 día" : `${days ?? 2} días`} sin respuesta.`,
  seguimiento_comercial: () => "Cuando una oportunidad tiene su próxima acción vencida.",
  seguimiento_no_asistencia: (_, timing) =>
    `Al día siguiente de que una persona falta a su cita${timing.hour === undefined ? "" : `, a las ${hourPhrase(timing.hour)}`}.`,
  cita_cancelada: (_, timing) =>
    `${capital(HOURS(timing.delayHours ?? adminLineOf("cita_cancelada")?.delayHours ?? 1))} después de que se cancela una cita.`,
  aviso_cita_reservada: () => "Al reservar una cita desde la Agenda, la ficha o la conversación.",
  aviso_cita_movida: () => "Al cambiar la fecha o la hora de una cita.",
  aviso_cita_cancelada: () => "Al cancelar una cita que aún no llega, con la opción de reservar otra.",
}

function buttonDoes(def: MessageDef, button: MessageButton): string {
  if (button.action === "confirmar") return "La cita queda confirmada al momento."
  if (button.action === "baja") {
    const purpose =
      def.catalog && def.origin === "agente"
        ? AUTOMATION_MESSAGES[def.catalog.key as AutomationMessageKey].purpose
        : null
    return purpose === "recordatorio"
      ? "Deja de recibir recordatorios; lo demás no cambia."
      : "Deja de recibir estos mensajes; lo demás no cambia."
  }
  if (button.action === "presupuesto")
    return "Le llega el PDF del presupuesto en la conversación y puede decir ahí qué acepta."
  if (button.asks === "cambiar") return "Recepción le busca otra fecha en la conversación."
  if (button.asks === "reservar") return "Recepción le ofrece horarios en la conversación."
  if (def.origin === "agente") return "Recepción sigue la conversación con la persona."
  return "La persona responde y tu equipo puede escribirle con libertad durante 24 horas."
}

function stateOf(
  text: MessageText,
  templates: Map<string, TemplateItem>,
  values: Record<MessageVariable, string>,
): MessageTextState {
  const template = templates.get(text.templateName)
  const status: MessageStatus = template?.status ?? "sin_pedir"
  return {
    body: text.body,
    previewParts: previewOf(text.body, values),
    status,
    statusLabel: STATUS_LABELS[status],
    reason:
      status === "aprobada" || status === "en_revision"
        ? null
        : templateReasonWords(template?.reason ?? null),
    since:
      template?.statusSince ?? (status === "en_revision" ? (template?.requestedAt ?? null) : null),
    isDefault: text.isDefault,
  }
}

function meanwhileOf(
  def: MessageDef,
  current: MessageTextState,
  pending: MessageTextState | null,
  waiting: number,
): string | null {
  if (current.status === "aprobada") {
    if (!pending) return null
    return pending.status === "rechazada" || pending.status === "deshabilitada"
      ? "WhatsApp no aceptó el cambio: sigue saliendo el texto anterior."
      : "Tu cambio de texto está en revisión; sigue saliendo el anterior."
  }
  if (def.origin === "plan")
    return "Mientras tanto el presupuesto sale con su PDF a quien escribió en las últimas 24 horas, o por correo."
  if (def.origin !== "agente") return "Mientras tanto no se ofrece en la Bandeja."
  const people =
    waiting > 0
      ? ` ${waiting === 1 ? "1 persona lo tiene" : `${waiting} personas lo tienen`} por salir en las próximas 24 horas.`
      : ""
  return `Mientras tanto sale como respuesta a quien escribió en las últimas 24 horas, o por correo.${people}`
}

interface ListContext {
  defs: MessageDef[]
  known: Set<string>
  values: Record<MessageVariable, string>
  rules: Map<string, typeof automationRule.$inferSelect>
  waiting: Map<string, number>
}

async function listContext(tx: Db, orgId: string): Promise<ListContext> {
  const { defs, known } = await loadMessages(tx, orgId)
  const rules = await tx
    .select()
    .from(automationRule)
    .where(eq(automationRule.organizationId, orgId))
  // Personas con cada mensaje por salir en el próximo día.
  const soon = await tx.execute<{ kind: string; n: number }>(sql`
    select j.kind, count(distinct j.contact_id)::int as n from automation_job j
    where j.organization_id = ${orgId} and j.status = 'pendiente'
      and j.scheduled_for <= now() + interval '24 hours'
    group by j.kind`)
  return {
    defs,
    known,
    values: await exampleValues(tx, orgId),
    rules: new Map(rules.map((rule) => [rule.kind, rule])),
    waiting: new Map(soon.map((row) => [row.kind, Number(row.n)])),
  }
}

function itemOf(
  def: MessageDef,
  templates: Map<string, TemplateItem>,
  context: ListContext,
): ClinicMessageItem {
  const text = currentText(def)
  const current = stateOf(text, templates, context.values)
  const waitingText = pendingText(def)
  const pending = waitingText ? stateOf(waitingText, templates, context.values) : null
  // Un aviso de cita es de la línea «Recordar la cita»: su estado es el de ella.
  const line = def.origin === "agente" ? lineOfJobKind(def.id) : null
  const rule = context.rules.get(line?.key ?? def.id) ?? null
  const category = templates.get(text.templateName)?.category ?? def.category
  return {
    id: def.id,
    origin: def.origin,
    title: def.title,
    when: line
      ? WHEN[def.id as AutomationMessageKey](lineDays(rule, line.key), lineTiming(rule))
      : def.origin === "plan"
        ? "Al entregar un presupuesto: desde Plan, al cerrar la atención o cuando la persona lo pide por el chat."
        : null,
    line: line
      ? { key: line.key, title: line.name, enabled: !!rule?.enabled && rule.agentPart }
      : null,
    current,
    pending,
    buttons: def.buttons.map((button) => ({ title: button.title, does: buttonDoes(def, button) })),
    variables: def.data.map((item) => ({
      key: item.key,
      label: MESSAGE_VARIABLES[item.key].label,
      example: context.values[item.key],
      required: item.required,
    })),
    category: CATEGORY_LABELS[category] ?? category,
    meanwhile: meanwhileOf(def, current, pending, context.waiting.get(def.id) ?? 0),
    editable: true,
    deletable: def.origin === "clinica",
    canRevert:
      !!def.catalog &&
      !!def.row &&
      (def.row.currentVersion !== 0 || def.row.pendingVersion !== null),
  }
}

/** Plantillas que ya estaban en la cuenta: ni de odentIA ni creadas desde aquí. Las retiradas no se listan. */
function accountTemplates(templates: TemplateItem[], known: Set<string>): TemplateItem[] {
  return templates
    .filter((template) => !known.has(template.name) && template.status !== "deshabilitada")
    .sort((a, b) => a.name.localeCompare(b.name))
}

function accountItem(template: TemplateItem): ClinicMessageItem {
  const status = template.status
  return {
    id: template.id,
    origin: "cuenta",
    title: template.name,
    when: null,
    line: null,
    current: {
      body: template.body,
      previewParts: positionalPreview(template.body),
      status,
      statusLabel: STATUS_LABELS[status],
      reason:
        status === "aprobada" || status === "en_revision"
          ? null
          : templateReasonWords(template.reason),
      since: template.statusSince,
      isDefault: false,
    },
    pending: null,
    buttons: template.buttons.map((title) => ({ title, does: "La respuesta llega a la Bandeja." })),
    variables: [],
    category: CATEGORY_LABELS[template.category] ?? template.category,
    meanwhile: status === "aprobada" ? null : "Mientras tanto no se ofrece en la Bandeja.",
    // Se creó en la página de Meta: ahí se cambia y ahí se elimina.
    editable: false,
    deletable: false,
    canRevert: false,
  }
}

/** Los mensajes de la clínica en una conexión, con todo lo que la pantalla dice de cada uno. */
export async function listClinicMessages(
  tx: Db,
  orgId: string,
  connectionId: string,
): Promise<ClinicMessageItem[]> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const context = await listContext(tx, orgId)
  const all = await listChannelTemplates(tx, orgId, connectionId)
  const templates = byName(all)
  return [
    ...context.defs.map((def) => itemOf(def, templates, context)),
    ...accountTemplates(all, context.known).map(accountItem),
  ]
}

async function itemById(
  tx: Db,
  orgId: string,
  connectionId: string,
  id: string,
): Promise<ClinicMessageItem> {
  const item = (await listClinicMessages(tx, orgId, connectionId)).find((entry) => entry.id === id)
  if (!item) throw notFound("Mensaje")
  return item
}

export interface MessageCounts {
  aprobados: number
  enRevision: number
  rechazados: number
  pausados: number
  /** Los que WhatsApp retiró. */
  retirados: number
  sinPedir: number
}

/** Cuántos mensajes hay en cada estado por conexión, contando el texto vigente de cada uno. */
export async function countConnectionMessages(
  tx: Db,
  orgId: string,
  connectionIds: string[],
): Promise<Map<string, MessageCounts>> {
  const out = new Map<string, MessageCounts>()
  if (connectionIds.length === 0) return out
  const { defs, known } = await loadMessages(tx, orgId)
  const rows = await tx
    .select({
      connectionId: channelTemplate.connectionId,
      name: channelTemplate.name,
      language: channelTemplate.language,
      status: channelTemplate.status,
    })
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        inArray(channelTemplate.connectionId, connectionIds),
      ),
    )
  const bucket: Record<MessageStatus, keyof MessageCounts> = {
    aprobada: "aprobados",
    en_revision: "enRevision",
    rechazada: "rechazados",
    pausada: "pausados",
    deshabilitada: "retirados",
    sin_pedir: "sinPedir",
  }
  for (const id of connectionIds) {
    const counts: MessageCounts = {
      aprobados: 0,
      enRevision: 0,
      rechazados: 0,
      pausados: 0,
      retirados: 0,
      sinPedir: 0,
    }
    const mine = rows.filter((row) => row.connectionId === id)
    const own = new Map(
      mine
        .filter((row) => row.language === AUTOMATION_MESSAGE_LANGUAGE)
        .map((row) => [row.name, row.status as TemplateStatus]),
    )
    for (const def of defs) counts[bucket[own.get(currentText(def).templateName) ?? "sin_pedir"]]++
    for (const row of mine) {
      if (known.has(row.name) || row.status === "deshabilitada") continue
      counts[bucket[row.status as TemplateStatus] ?? "sinPedir"]++
    }
    out.set(id, counts)
  }
  return out
}

// ------------------------------------------------- cambiar, crear, quitar ---

export interface MessageWriteDeps extends TemplateDeps {
  secretsKey: Buffer
}

async function lockMessageRow(tx: Db, orgId: string, id: string): Promise<MessageRow> {
  const [row] = await tx
    .select()
    .from(clinicMessage)
    .where(and(eq(clinicMessage.id, id), eq(clinicMessage.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Mensaje")
  return row
}

/** La fila de un mensaje del catálogo, creada la primera vez que la clínica lo toca. */
async function ensureCatalogRow(
  tx: Db,
  orgId: string,
  key: string,
  actorUserId: string | null,
): Promise<MessageRow> {
  await tx
    .insert(clinicMessage)
    .values({ organizationId: orgId, key, createdBy: actorUserId })
    .onConflictDoNothing()
  const [row] = await tx
    .select({ id: clinicMessage.id })
    .from(clinicMessage)
    .where(and(eq(clinicMessage.organizationId, orgId), eq(clinicMessage.key, key)))
    .limit(1)
  if (!row) throw new Error("No se pudo preparar el mensaje")
  return lockMessageRow(tx, orgId, row.id)
}

function templateNameFor(def: MessageDef): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10)
  // `odentia_…`: texto de un mensaje con el que viene odentIA; `clinica_…`: uno
  // creado por la clínica. Nunca reutilizan un nombre: WhatsApp no deja pedir de
  // nuevo, durante 30 días, el de una plantilla aprobada que se eliminó.
  return def.catalog ? `odentia_${def.catalog.key}_t${suffix}` : `clinica_mensaje_${suffix}`
}

/** Si el texto vigente de un mensaje está aprobado en la conexión por la que sale lo automático. */
async function currentIsApproved(tx: Db, orgId: string, text: MessageText): Promise<boolean> {
  const [primary] = await activeWhatsApps(tx, orgId)
  if (!primary) return false
  return (await findTemplateByName(tx, orgId, primary, text.templateName))?.status === "aprobada"
}

/**
 * Cambia el texto de un mensaje: guarda una versión nueva y la pide a WhatsApp.
 * Si el texto vigente está aprobado, sigue saliendo hasta que aprueben el
 * nuevo; si no lo está, el nuevo vale desde ya. Escribir de nuevo el texto de
 * odentIA es volver a él.
 */
export async function saveMessageText(
  tx: Db,
  orgId: string,
  connectionId: string,
  actorUserId: string | null,
  messageId: string,
  rawBody: string,
  deps: MessageWriteDeps,
): Promise<ClinicMessageItem> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const found = await loadMessage(tx, orgId, messageId)
  const body = normalizeBody(rawBody)
  assertValid(checkBody(body, found.data))
  if (found.catalog && body === namedBody(found.catalog)) {
    if (!found.row || (found.row.currentVersion === 0 && found.row.pendingVersion === null)) {
      throw validation("Ese es el texto que ya tiene.")
    }
    return revertMessageText(tx, orgId, connectionId, actorUserId, messageId, deps)
  }
  const row = found.catalog
    ? await ensureCatalogRow(tx, orgId, found.catalog.key, actorUserId)
    : await lockMessageRow(tx, orgId, found.id)
  // Con la fila bloqueada: lo vigente y lo pendiente son los de ahora.
  const def = await loadMessage(tx, orgId, messageId)
  const current = currentText(def)
  const pending = pendingText(def)
  if (pending && body === pending.body) {
    throw validation(
      (await findTemplateByName(tx, orgId, connectionId, pending.templateName))?.status ===
        "rechazada"
        ? "Ese es el texto que WhatsApp rechazó: cámbialo antes de pedirlo de nuevo."
        : "Ese cambio ya está en revisión.",
    )
  }
  if (body === current.body) {
    if (!pending) throw validation("Ese es el texto que ya tiene.")
    // Volver a escribir el texto vigente es desistir del cambio pendiente.
    await tx
      .update(clinicMessage)
      .set({ pendingVersion: null, updatedAt: new Date() })
      .where(eq(clinicMessage.id, row.id))
    await audit(tx, orgId, actorUserId, "clinic_message.change_dropped", row.id, {
      message: def.id,
    })
    return itemById(tx, orgId, connectionId, messageId)
  }
  const number = (def.versions.at(-1)?.number ?? 0) + 1
  const text: MessageText = { number, body, templateName: templateNameFor(def), isDefault: false }
  await tx.insert(clinicMessageVersion).values({
    organizationId: orgId,
    messageId: row.id,
    number,
    body,
    templateName: text.templateName,
    createdBy: actorUserId,
  })
  // Si WhatsApp no acepta la solicitud, el cambio no se guarda y la pantalla dice por qué.
  await requestConnectionTemplate(
    tx,
    orgId,
    connectionId,
    orderOf(def, text),
    deps.secretsKey,
    deps,
  )
  const waits = await currentIsApproved(tx, orgId, current)
  await tx
    .update(clinicMessage)
    .set(
      waits
        ? { pendingVersion: number, updatedAt: new Date() }
        : { currentVersion: number, pendingVersion: null, updatedAt: new Date() },
    )
    .where(eq(clinicMessage.id, row.id))
  // La auditoría dice qué cambió, no copia el texto.
  await audit(tx, orgId, actorUserId, "clinic_message.text_changed", row.id, {
    message: def.id,
    version: number,
    waits,
  })
  return itemById(tx, orgId, connectionId, messageId)
}

/**
 * Vuelve al texto con el que viene odentIA. Si su plantilla ya está aprobada
 * (o el texto vigente tampoco lo está) vale desde ya, sin otra revisión; si no,
 * se pide y el texto vigente sigue saliendo mientras tanto.
 */
export async function revertMessageText(
  tx: Db,
  orgId: string,
  connectionId: string,
  actorUserId: string | null,
  messageId: string,
  deps: MessageWriteDeps,
): Promise<ClinicMessageItem> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const found = await loadMessage(tx, orgId, messageId)
  if (!found.catalog)
    throw validation("Solo un mensaje que viene con odentIA tiene un texto al que volver.")
  if (!found.row || (found.row.currentVersion === 0 && found.row.pendingVersion === null)) {
    throw validation("Ya tiene el texto de odentIA.")
  }
  const row = await lockMessageRow(tx, orgId, found.row.id)
  const def = await loadMessage(tx, orgId, messageId)
  const original = textOf(def, 0)
  if (!original) throw notFound("Mensaje")
  let waits = false
  if (row.currentVersion !== 0) {
    await requestConnectionTemplate(
      tx,
      orgId,
      connectionId,
      orderOf(def, original),
      deps.secretsKey,
      deps,
    )
    waits =
      (await currentIsApproved(tx, orgId, currentText(def))) &&
      !(await currentIsApproved(tx, orgId, original))
  }
  await tx
    .update(clinicMessage)
    .set(
      waits
        ? { pendingVersion: 0, updatedAt: new Date() }
        : { currentVersion: 0, pendingVersion: null, updatedAt: new Date() },
    )
    .where(eq(clinicMessage.id, row.id))
  await audit(tx, orgId, actorUserId, "clinic_message.reverted", row.id, { message: def.id, waits })
  return itemById(tx, orgId, connectionId, messageId)
}

export interface CreateMessageInput {
  title: string
  body: string
  buttonTitle?: string
}

/**
 * Crea un mensaje propio de la clínica para la Bandeja: para qué sirve, un
 * texto cuyos únicos datos son el nombre de la persona y el de la clínica, y un
 * botón de respuesta si lo quiere. Se pide a WhatsApp en el momento.
 */
export async function createClinicMessage(
  tx: Db,
  orgId: string,
  connectionId: string,
  actorUserId: string | null,
  input: CreateMessageInput,
  deps: MessageWriteDeps,
): Promise<ClinicMessageItem> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const body = normalizeBody(input.body)
  assertValid([...checkOwnParts(input.title, input.buttonTitle), ...checkBody(body, OWN_DATA)])
  const title = input.title.trim()
  const buttonTitle = input.buttonTitle?.trim() || null
  const existing = await tx
    .select({ title: clinicMessage.title })
    .from(clinicMessage)
    .where(
      and(
        eq(clinicMessage.organizationId, orgId),
        isNull(clinicMessage.key),
        isNull(clinicMessage.archivedAt),
      ),
    )
  if (existing.length >= OWN_MESSAGES_MAX) {
    throw validation(
      `La clínica ya tiene ${OWN_MESSAGES_MAX} mensajes propios: elimina uno antes de crear otro.`,
    )
  }
  if (existing.some((item) => item.title?.trim().toLowerCase() === title.toLowerCase())) {
    throw validation("Ya hay un mensaje con ese nombre.")
  }
  const [row] = await tx
    .insert(clinicMessage)
    .values({
      organizationId: orgId,
      title,
      buttonTitle,
      currentVersion: 1,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear el mensaje")
  const def = ownDef(row, [])
  const text: MessageText = {
    number: 1,
    body,
    templateName: templateNameFor(def),
    isDefault: false,
  }
  await tx.insert(clinicMessageVersion).values({
    organizationId: orgId,
    messageId: row.id,
    number: 1,
    body,
    templateName: text.templateName,
    createdBy: actorUserId,
  })
  await requestConnectionTemplate(
    tx,
    orgId,
    connectionId,
    orderOf(def, text),
    deps.secretsKey,
    deps,
  )
  await audit(tx, orgId, actorUserId, "clinic_message.created", row.id, { button: !!buttonTitle })
  return itemById(tx, orgId, connectionId, row.id)
}

/**
 * Elimina un mensaje creado por la clínica: quita sus plantillas de la cuenta
 * de WhatsApp y archiva el mensaje. Uno del catálogo no se elimina nunca. Si
 * WhatsApp no deja quitarlas, no se archiva y se dice por qué.
 */
export async function deleteClinicMessage(
  tx: Db,
  orgId: string,
  connectionId: string,
  actorUserId: string | null,
  messageId: string,
  deps: MessageWriteDeps,
): Promise<{ ok: true }> {
  await requireTemplateConnection(tx, orgId, connectionId)
  const def = await loadMessage(tx, orgId, messageId)
  if (def.catalog || !def.row) {
    throw validation(
      "Los mensajes que vienen con odentIA no se eliminan: se apaga su línea o se les cambia el texto.",
    )
  }
  const row = await lockMessageRow(tx, orgId, def.row.id)
  const names = def.versions.map((version) => version.templateName)
  if (deps.validateExternal !== false) {
    for (const id of new Set([connectionId, ...(await activeWhatsApps(tx, orgId))])) {
      const { adapter, config } = await connectionWithAdapter(tx, orgId, id, deps.secretsKey)
      if (!adapter?.deleteTemplate || !adapter.listTemplates) continue
      let inAccount: ProviderTemplate[]
      try {
        inAccount = await adapter.listTemplates(config, { fetch: deps.fetch })
      } catch (error) {
        throw new ServiceError(
          "TEMPLATE_DELETE_FAILED",
          502,
          `No se pudo leer la cuenta de WhatsApp para eliminar el mensaje: ${error instanceof Error ? error.message : "sin detalle"}`,
        )
      }
      // Solo lo que sigue en la cuenta; una plantilla que WhatsApp deshabilitó no se deja eliminar.
      const present = new Set(
        inAccount
          .filter((template) => template.status !== "deshabilitada")
          .map((template) => template.name),
      )
      for (const name of names) {
        if (!present.has(name)) continue
        try {
          await adapter.deleteTemplate(config, { name }, { fetch: deps.fetch })
        } catch (error) {
          throw new ServiceError(
            "TEMPLATE_DELETE_FAILED",
            502,
            error instanceof Error ? error.message : "WhatsApp no eliminó el mensaje",
          )
        }
      }
    }
  }
  await retireTemplates(tx, orgId, names, "Eliminado por la clínica")
  await tx
    .update(clinicMessage)
    .set({ archivedAt: new Date(), pendingVersion: null, updatedAt: new Date() })
    .where(eq(clinicMessage.id, row.id))
  await audit(tx, orgId, actorUserId, "clinic_message.deleted", row.id, { templates: names.length })
  return { ok: true }
}

// --------------------------------------------- Bandeja, pasadas 24 horas ---

export interface ApprovedMessageOption {
  id: string
  title: string
  /** El texto con los datos de esa persona ya puestos. */
  previewParts: PreviewPart[]
  buttons: string[]
  /** Datos que escribe quien envía: solo en plantillas de la cuenta que los piden. */
  fields: { index: number; label: string }[]
}

export interface ApprovedMessages {
  data: ApprovedMessageOption[]
  /** Por qué no hay ninguno, y adónde ir si el rol puede abrir Configuración. */
  none: { text: string; fixHref: string | null } | null
}

interface Sendable extends ApprovedMessageOption {
  name: string
  language: string
  /** Datos ya resueltos; nulo si los escribe quien envía. */
  params: string[] | null
  variables: number
  body: string
  reply: readonly MessageButton[]
}

const APPROVED_WAIT_MS = 24 * 3_600_000

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

/** «hoy», «ayer», «mañana» o «el 3 de octubre», en la zona de la clínica. */
function dayWords(date: Date, now: Date, zone: { timezone: string; locale: string }): string {
  const key = dayKey(date, zone.timezone)
  if (key === dayKey(now, zone.timezone)) return "hoy"
  if (key === dayKey(new Date(now.getTime() - 24 * 3_600_000), zone.timezone)) return "ayer"
  if (key === dayKey(new Date(now.getTime() + 24 * 3_600_000), zone.timezone)) return "mañana"
  return `el ${new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" }).format(date)}`
}

function momentWords(date: Date, now: Date, zone: { timezone: string; locale: string }): string {
  const time = new Intl.DateTimeFormat(zone.locale, {
    timeZone: zone.timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
  return `${dayWords(date, now, zone)} a las ${time}`
}

async function sendables(
  tx: Db,
  orgId: string,
  conversationId: string,
  now: Date,
): Promise<{ options: Sendable[]; why: string | null; fixable: boolean }> {
  const [row] = await tx
    .select({
      lastInboundAt: conversation.lastInboundAt,
      connectionId: channelConnection.id,
      provider: channelConnection.provider,
      givenNames: contact.givenNames,
      displayName: contact.displayName,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  if (!channelAdapters[row.provider as ChannelProvider]?.capabilities.templates) {
    return {
      options: [],
      why: "Este canal no usa mensajes aprobados: solo se le responde a quien escribió.",
      fixable: false,
    }
  }
  const zone = await findOrgLocale(tx, orgId)
  // Un segundo mensaje aprobado espera a que la persona responda o a que pase un día.
  const [last] = await tx
    .select({ createdAt: message.createdAt })
    .from(message)
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.conversationId, conversationId),
        eq(message.direction, "out"),
        eq(message.contentType, "template"),
        ne(message.status, "failed"),
        gt(message.createdAt, new Date(now.getTime() - APPROVED_WAIT_MS)),
        ...(row.lastInboundAt ? [gt(message.createdAt, row.lastInboundAt)] : []),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(1)
  if (last) {
    const again = new Date(last.createdAt.getTime() + APPROVED_WAIT_MS)
    return {
      options: [],
      why: `Ya se le envió un mensaje aprobado ${momentWords(last.createdAt, now, zone)}. Cuando responda podrás escribirle con libertad; si no responde, podrás enviarle otro ${momentWords(again, now, zone)}.`,
      fixable: false,
    }
  }
  const { defs, known } = await loadMessages(tx, orgId)
  const all = await listChannelTemplates(tx, orgId, row.connectionId)
  const templates = byName(all)
  const values = {
    persona: cleanVariable(firstName(row)),
    clinica: cleanVariable(await clinicName(tx, orgId)),
  }
  const wrote = row.lastInboundAt !== null
  const options: Sendable[] = []
  for (const def of defs) {
    // Los que envía el agente piden los datos de una cita, un presupuesto o una oportunidad: no se envían a mano.
    // «Presupuesto listo» sale al entregar el presupuesto, con su PDF, no desde la Bandeja.
    if (def.origin === "agente" || def.origin === "plan") continue
    // «Retomar» continúa una consulta: solo donde la persona ya escribió.
    if (def.origin === "bandeja" && !wrote) continue
    const text = currentText(def)
    if (templates.get(text.templateName)?.status !== "aprobada") continue
    const { body, variables } = positionalBody(text.body)
    options.push({
      id: def.id,
      title: def.title,
      previewParts: previewOf(text.body, values),
      buttons: def.buttons.map((button) => button.title),
      fields: [],
      name: text.templateName,
      language: AUTOMATION_MESSAGE_LANGUAGE,
      params: variables.map((name) => (name === "persona" ? values.persona : values.clinica)),
      variables: variables.length,
      body,
      reply: def.buttons,
    })
  }
  for (const template of accountTemplates(all, known)) {
    if (template.status !== "aprobada") continue
    options.push({
      id: template.id,
      title: template.name,
      previewParts: positionalPreview(template.body),
      buttons: template.buttons,
      fields: Array.from({ length: template.variables }, (_, index) => ({
        index: index + 1,
        label: `Dato ${index + 1}`,
      })),
      name: template.name,
      language: template.language,
      params: template.variables === 0 ? [] : null,
      variables: template.variables,
      body: template.body,
      reply: [],
    })
  }
  if (options.length > 0) return { options, why: null, fixable: false }
  const resume = defs.find((def) => def.id === RESUME_MESSAGE_KEY)
  const title = `«${resume?.title ?? "Retomar la conversación"}»`
  if (!wrote) {
    return {
      options,
      // Que nunca escribió ya lo dice la zona de escritura (`whatsappWindow`): aquí solo por qué no hay mensaje.
      why: `${title} solo sirve para continuar una consulta; para escribirle primero hace falta un mensaje aprobado creado por la clínica.`,
      fixable: true,
    }
  }
  const template = resume ? templates.get(currentText(resume).templateName) : undefined
  const since = template?.statusSince ?? template?.requestedAt ?? null
  const why: Record<MessageStatus, string> = {
    aprobada: "",
    en_revision: `Aún no se le puede escribir. ${title} está en revisión${since ? ` desde ${dayWords(new Date(since), now, zone)}` : ""}; WhatsApp puede tardar hasta un día.`,
    rechazada: `Aún no se le puede escribir: WhatsApp rechazó ${title}. Hay que cambiarle el texto.`,
    pausada: `Aún no se le puede escribir: WhatsApp pausó ${title}. Suele reactivarlo solo en unas horas.`,
    deshabilitada: `Aún no se le puede escribir: WhatsApp retiró ${title}. Hay que cambiarle el texto y pedirlo de nuevo.`,
    sin_pedir: `Aún no se le puede escribir: ${title} todavía no se pidió a WhatsApp.`,
  }
  return { options, why: why[template?.status ?? "sin_pedir"], fixable: true }
}

/**
 * Los mensajes aprobados que una persona puede enviar a mano en una
 * conversación de WhatsApp: «Retomar la conversación», los que creó la clínica
 * y las plantillas aprobadas que ya estaban en la cuenta, con los datos de esa
 * persona ya puestos. Los seis del agente no se ofrecen.
 */
export async function listApprovedMessages(
  tx: Db,
  orgId: string,
  conversationId: string,
  can: (permission: string) => boolean,
  now: Date = new Date(),
): Promise<ApprovedMessages> {
  const { options, why, fixable } = await sendables(tx, orgId, conversationId, now)
  const data = options.map(({ id, title, previewParts, buttons, fields }) => ({
    id,
    title,
    previewParts,
    buttons,
    fields,
  }))
  if (data.length > 0 || !why) return { data, none: null }
  // Los mensajes se administran en Configuración: solo se ofrece ir a quien puede abrirla.
  // A quien no puede, se le dice a quién pedírselo, con su nombre.
  const fix = fixable && can("settings.read")
  return {
    data,
    none: {
      text: fixable && !fix ? `${why} ${await askAdminWords(tx, orgId)}` : why,
      fixHref: fix ? MESSAGES_HREF : null,
    },
  }
}

/** «Pídeselo a Ana Torres, que administra la clínica.»: quién puede crear o arreglar un mensaje. */
async function askAdminWords(tx: Db, orgId: string): Promise<string> {
  const rows = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .orderBy(asc(member.createdAt))
    .limit(2)
  const names = rows.map((row) => row.name.trim()).filter(Boolean)
  if (names.length === 0) return "Pídeselo a quien administra la clínica."
  return names.length === 1
    ? `Pídeselo a ${names[0]}, que administra la clínica.`
    : `Pídeselo a ${names[0]} o a ${names[1]}, que administran la clínica.`
}

/**
 * Envía a mano un mensaje aprobado. Pasa por la misma regla que todo envío de
 * plantilla (`assertTemplateSendable`) y guarda el texto ya armado.
 */
export async function sendApprovedMessage(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: { conversationId: string; senderUserId: string; messageId: string; values?: string[] },
  now: Date = new Date(),
): Promise<MessageItem> {
  // Dos envíos a la vez no deben pasar ambos la espera de un día.
  await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .for("update")
  const { options, why } = await sendables(tx, orgId, input.conversationId, now)
  const option = options.find((item) => item.id === input.messageId)
  if (!option) {
    throw new ServiceError(
      "APPROVED_MESSAGE_UNAVAILABLE",
      409,
      why ?? "Ese mensaje no se puede enviar en esta conversación.",
    )
  }
  const params = option.params ?? (input.values ?? []).map(cleanVariable)
  if (params.length !== option.variables || params.some((value) => !value)) {
    throw validation(
      option.variables === 1
        ? "Completa el dato del mensaje."
        : `Completa los ${option.variables} datos del mensaje.`,
    )
  }
  return sendTemplateOutbound(tx, orgId, secretsKey, {
    conversationId: input.conversationId,
    senderKind: "user",
    senderUserId: input.senderUserId,
    name: option.name,
    language: option.language,
    params,
    // Un botón de respuesta sigue la conversación: no lo resuelve el sistema.
    ...(option.reply.length
      ? {
          buttons: option.reply.map((button) => ({
            id: replyId(button.action, randomUUID()),
            title: button.title,
          })),
        }
      : {}),
    preview: option.body.replace(
      /\{\{(\d+)\}\}/g,
      (_, position: string) => params[Number(position) - 1] ?? "",
    ),
  })
}
