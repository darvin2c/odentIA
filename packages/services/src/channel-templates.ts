import {
  type ChannelProvider,
  channelAdapters,
  type NormalizedTemplateCategory,
  type NormalizedTemplateStatus,
  type ProviderTemplate,
  type TemplateCategory,
  type TemplateStatus,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection, channelTemplate, clinicMessage, clinicMessageVersion } from "@odentia/db/schema/crm"
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm"
import { AUTOMATION_MESSAGE_LANGUAGE, CATALOG_MESSAGE_KEYS, catalogTemplatesOf } from "./automation-messages.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { acceptsPromotions } from "./message-permission.js"
import { decryptConfig } from "./secrets.js"

/**
 * Catálogo de plantillas por conexión. Lo que hay en la cuenta del proveedor
 * manda: se lee de ahí, se actualiza cuando el proveedor avisa y solo una
 * plantilla `aprobada` se puede enviar. odentIA pide las de los mensajes de la
 * clínica (`clinic-messages.ts`); nadie escribe nombres de plantilla.
 *
 * Sin proveedor (pruebas, desarrollo) nada de esto acredita que el proveedor
 * acepte una plantilla: una solicitud queda `en_revision` y no cambia sola.
 */

export type ChannelTemplateRow = typeof channelTemplate.$inferSelect

export interface TemplateItem {
  id: string
  name: string
  language: string
  category: string
  status: TemplateStatus
  reason: string | null
  body: string
  variables: number
  buttons: string[]
  /** Mensaje del catálogo de odentIA al que sirve; nulo si es propio de la clínica o ya estaba en la cuenta. */
  messageKey: string | null
  /**
   * Por qué odentIA no sabe enviarla (`encabezado`, `datos_por_nombre`): se
   * muestra y no se ofrece. Nulo: se puede enviar.
   */
  unsupported: string | null
  requestedAt: string | null
  /** Desde cuándo está en ese estado; nulo si ya estaba así en la cuenta. */
  statusSince: string | null
  syncedAt: string | null
}

export interface TemplateDeps {
  fetch: typeof fetch
  /** false en desarrollo y pruebas: no se llama al proveedor. */
  validateExternal?: boolean
}

function toItem(row: ChannelTemplateRow): TemplateItem {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status as TemplateStatus,
    reason: row.reason,
    body: row.body,
    variables: row.variables,
    buttons: Array.isArray(row.buttons) ? row.buttons : [],
    messageKey: row.messageKey,
    unsupported: row.unsupported,
    requestedAt: row.requestedAt?.toISOString() ?? null,
    statusSince: row.statusSince?.toISOString() ?? null,
    syncedAt: row.syncedAt?.toISOString() ?? null,
  }
}

/** Mensaje del catálogo al que corresponde el nombre de la plantilla con la que viene escrito. */
function catalogKeyOfTemplate(name: string): string | null {
  return CATALOG_MESSAGE_KEYS.find((key) => catalogTemplatesOf(key).includes(name)) ?? null
}

/**
 * A qué mensaje del catálogo sirve cada nombre de plantilla de la organización:
 * los textos con los que viene y los que la clínica guardó para ellos.
 */
async function catalogKeysByTemplate(tx: Db, orgId: string): Promise<(name: string) => string | null> {
  const edited = await tx
    .select({ name: clinicMessageVersion.templateName, key: clinicMessage.key })
    .from(clinicMessageVersion)
    .innerJoin(
      clinicMessage,
      and(
        eq(clinicMessage.id, clinicMessageVersion.messageId),
        eq(clinicMessage.organizationId, clinicMessageVersion.organizationId),
      ),
    )
    .where(and(eq(clinicMessageVersion.organizationId, orgId), isNotNull(clinicMessage.key)))
  const byName = new Map(edited.map((row) => [row.name, row.key]))
  return (name) => byName.get(name) ?? catalogKeyOfTemplate(name)
}

export async function connectionWithAdapter(tx: Db, orgId: string, connectionId: string, secretsKey: Buffer) {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conexión")
  const adapter = channelAdapters[row.provider as ChannelProvider]
  return { row, adapter, config: decryptConfig(secretsKey, row.configEncrypted) }
}

export async function listChannelTemplates(
  tx: Db,
  orgId: string,
  connectionId: string,
): Promise<TemplateItem[]> {
  const rows = await tx
    .select()
    .from(channelTemplate)
    .where(and(eq(channelTemplate.organizationId, orgId), eq(channelTemplate.connectionId, connectionId)))
    .orderBy(asc(channelTemplate.name), asc(channelTemplate.language))
  return rows.map(toItem)
}

const STATUS_WORDS: Record<TemplateStatus, string> = {
  en_revision: "en revisión",
  aprobada: "aprobada",
  rechazada: "rechazada",
  pausada: "pausada",
  deshabilitada: "deshabilitada",
}

/**
 * ¿WhatsApp cuenta como promoción un mensaje que se pidió como otra cosa? La
 * categoría la decide el proveedor: un aviso de servicio que pasó a marketing
 * solo sale a quien aceptó novedades (ADR 0040, «la categoría manda»).
 */
export function isPromotionFor(template: Pick<TemplateItem, "category">, expected: TemplateCategory): boolean {
  return template.category === "marketing" && expected !== "marketing"
}

/** Lo que dice la página de cada plantilla que odentIA no sabe enviar. */
export const UNSUPPORTED_WORDS: Record<string, string> = {
  encabezado: "lleva un encabezado con datos o con un archivo",
  datos_por_nombre: "sus datos van por nombre",
}

/**
 * Regla única antes de enviar una plantilla, la use una persona, una
 * automatización o el sistema: existe en la conexión, odentIA la sabe enviar,
 * está aprobada, lleva tantos datos como variables tiene y la categoría manda
 * (ADR 0040): lo que WhatsApp cuenta como promoción, si se pidió como otra
 * cosa, solo sale a quien aceptó novedades (`contactId`, la persona del hilo).
 */
export async function assertTemplateSendable(
  tx: Db,
  orgId: string,
  connectionId: string,
  input: { name: string; language: string; params: number; category: TemplateCategory; contactId: string | null },
): Promise<TemplateItem> {
  const [row] = await tx
    .select()
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        eq(channelTemplate.connectionId, connectionId),
        eq(channelTemplate.name, input.name),
        eq(channelTemplate.language, input.language),
      ),
    )
    .limit(1)
  if (!row) throw validation("Plantilla no autorizada en esta conexión")
  if (row.unsupported) {
    throw validation(
      `La plantilla «${row.name}» ${UNSUPPORTED_WORDS[row.unsupported] ?? "tiene partes"} que odentIA no sabe enviar`,
    )
  }
  if (row.status !== "aprobada") {
    const status = STATUS_WORDS[row.status as TemplateStatus] ?? row.status
    throw validation(
      `La plantilla «${row.name}» está ${status}${row.reason ? ` (${row.reason})` : ""}: no se puede enviar`,
    )
  }
  // Sin cuerpo conocido (plantilla declarada sin proveedor) no hay con qué comparar.
  if (row.body && row.variables !== input.params) {
    throw validation(
      `La plantilla «${row.name}» lleva ${row.variables} ${row.variables === 1 ? "dato" : "datos"} y se ${input.params === 1 ? "envió" : "enviaron"} ${input.params}`,
    )
  }
  if (
    isPromotionFor({ category: row.category }, input.category) &&
    !(input.contactId && (await acceptsPromotions(tx, orgId, input.contactId)))
  ) {
    throw new ServiceError(
      "TEMPLATE_IS_PROMOTION",
      409,
      `WhatsApp considera «${row.name}» como promoción: solo se envía a quien aceptó novedades`,
    )
  }
  return toItem(row)
}

async function upsertFromProvider(
  tx: Db,
  orgId: string,
  connectionId: string,
  template: ProviderTemplate,
  now: Date,
  keyOf: (name: string) => string | null,
): Promise<void> {
  const values = {
    category: template.category,
    status: template.status,
    reason: template.reason,
    body: template.body,
    variables: template.variables,
    buttons: template.buttons,
    externalId: template.externalId,
    unsupported: template.unsupported ?? null,
    syncedAt: now,
    updatedAt: now,
  }
  await tx
    .insert(channelTemplate)
    .values({
      organizationId: orgId,
      connectionId,
      name: template.name,
      language: template.language,
      messageKey: keyOf(template.name),
      ...values,
    })
    .onConflictDoUpdate({
      target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
      set: {
        ...values,
        // Solo cambia la fecha cuando cambia el estado.
        statusSince: sql`case when ${channelTemplate.status} is distinct from ${template.status}
          then ${now.toISOString()}::timestamptz else ${channelTemplate.statusSince} end`,
      },
    })
}

/** Una solicitud reciente puede no aparecer aún en la lectura de la cuenta. */
const REQUEST_GRACE_MS = 60 * 60_000

/**
 * Lee las plantillas de la cuenta y deja el catálogo igual. Lo que ya no está
 * en la cuenta queda `deshabilitada` (no se borra: los mensajes que la usaron
 * siguen diciendo cuál fue).
 */
export async function syncConnectionTemplates(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  deps: TemplateDeps,
): Promise<TemplateItem[]> {
  const { adapter, config } = await connectionWithAdapter(tx, orgId, connectionId, secretsKey)
  if (!adapter?.listTemplates || deps.validateExternal === false) {
    return listChannelTemplates(tx, orgId, connectionId)
  }
  let fetched: ProviderTemplate[]
  try {
    fetched = await adapter.listTemplates(config, { fetch: deps.fetch })
  } catch (error) {
    throw new ServiceError(
      "TEMPLATES_UNAVAILABLE",
      502,
      `No se pudieron leer las plantillas de la cuenta: ${error instanceof Error ? error.message : "sin detalle"}. Revisa que el token de la conexión tenga permiso para administrar plantillas.`,
    )
  }
  const now = new Date()
  const keyOf = await catalogKeysByTemplate(tx, orgId)
  for (const template of fetched) await upsertFromProvider(tx, orgId, connectionId, template, now, keyOf)
  // La revisión diaria (`reviewConnectionTemplates`) se guía por esta fecha.
  await tx
    .update(channelConnection)
    .set({ templatesSyncedAt: now })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
  const known = new Set(fetched.map((template) => `${template.name}\n${template.language}`))
  const current = await tx
    .select()
    .from(channelTemplate)
    .where(and(eq(channelTemplate.organizationId, orgId), eq(channelTemplate.connectionId, connectionId)))
  const gone = current.filter(
    (row) =>
      !known.has(`${row.name}\n${row.language}`) &&
      row.status !== "deshabilitada" &&
      !(row.requestedAt && now.getTime() - row.requestedAt.getTime() < REQUEST_GRACE_MS),
  )
  if (gone.length > 0) {
    await tx
      .update(channelTemplate)
      .set({ status: "deshabilitada", reason: "Ya no está en la cuenta", statusSince: now, syncedAt: now, updatedAt: now })
      .where(
        inArray(
          channelTemplate.id,
          gone.map((row) => row.id),
        ),
      )
  }
  return listChannelTemplates(tx, orgId, connectionId)
}

/** Cada cuánto se vuelve a leer la cuenta de una conexión, por si se perdió un aviso del proveedor. */
export const TEMPLATE_REVIEW_MS = 24 * 3_600_000

/**
 * La revisión diaria de una conexión (ADR 0040): si su cuenta no se leyó en
 * las últimas 24 horas, se lee ahora y quedan al día estados y categorías. Si
 * el proveedor no responde no pasa nada: se intenta en el ciclo siguiente.
 * Devuelve si leyó la cuenta.
 */
export async function reviewConnectionTemplates(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  now: Date,
  deps: TemplateDeps,
): Promise<boolean> {
  if (deps.validateExternal === false) return false
  const [row] = await tx
    .select({ syncedAt: channelConnection.templatesSyncedAt })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  // Sin lectura previa (conexión sin proveedor, en pruebas y desarrollo) no hay cuenta que revisar:
  // la primera lectura la hace conectar o «Actualizar».
  if (!row?.syncedAt || now.getTime() - row.syncedAt.getTime() < TEMPLATE_REVIEW_MS) return false
  try {
    await tx.transaction((inner) => syncConnectionTemplates(inner, orgId, connectionId, secretsKey, deps))
    return true
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    console.warn(`[plantillas] no se pudo revisar la conexión ${connectionId}: ${error.message}`)
    return false
  }
}

/**
 * Deja en el catálogo, como aprobadas, las plantillas que una conexión declara
 * en su configuración. Solo vale donde no hay proveedor que leer (pruebas y
 * desarrollo): con proveedor, el catálogo sale de `syncConnectionTemplates`.
 */
export async function declareConfigTemplates(
  tx: Db,
  orgId: string,
  connectionId: string,
  templates: unknown,
): Promise<void> {
  if (!Array.isArray(templates)) return
  for (const template of templates) {
    if (
      !template ||
      typeof template !== "object" ||
      !("name" in template) ||
      typeof template.name !== "string" ||
      !("language" in template) ||
      typeof template.language !== "string"
    ) {
      continue
    }
    await tx
      .insert(channelTemplate)
      .values({
        organizationId: orgId,
        connectionId,
        name: template.name,
        language: template.language,
        status: "aprobada",
        messageKey: catalogKeyOfTemplate(template.name),
      })
      .onConflictDoNothing({
        target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
      })
  }
}

/** Lo que se pide aprobar para un mensaje de la clínica. */
export interface TemplateOrder {
  name: string
  category: TemplateCategory
  /** Cuerpo con variables por posición. */
  body: string
  /** Un ejemplo por variable, en orden. */
  examples: string[]
  /** Títulos de los botones de respuesta. */
  buttons: string[]
  /** Botón que abre «Su enlace»: su dirección con el token al final (`{{1}}`) y un ejemplo. */
  link?: { title: string; url: string; example: string }
  /** Mensaje del catálogo al que sirve; nulo si es un mensaje propio de la clínica. */
  messageKey: string | null
}

/** Plantilla de la conexión por su nombre, en el estado que tenga. */
export async function findTemplateByName(
  tx: Db,
  orgId: string,
  connectionId: string,
  name: string,
  language: string = AUTOMATION_MESSAGE_LANGUAGE,
): Promise<TemplateItem | null> {
  const [row] = await tx
    .select()
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        eq(channelTemplate.connectionId, connectionId),
        eq(channelTemplate.name, name),
        eq(channelTemplate.language, language),
      ),
    )
    .limit(1)
  return row ? toItem(row) : null
}

/**
 * Pide al proveedor la aprobación de una plantilla, una sola vez por conexión:
 * si ya está en el catálogo (en cualquier estado) no se vuelve a pedir. El
 * proveedor decide el estado y la categoría.
 */
export async function requestConnectionTemplate(
  tx: Db,
  orgId: string,
  connectionId: string,
  order: TemplateOrder,
  secretsKey: Buffer,
  deps: TemplateDeps,
): Promise<TemplateItem> {
  const language = AUTOMATION_MESSAGE_LANGUAGE
  const existing = await findTemplateByName(tx, orgId, connectionId, order.name, language)
  if (existing) return existing
  const { adapter, config } = await connectionWithAdapter(tx, orgId, connectionId, secretsKey)
  let answer: { externalId: string | null; status: TemplateStatus; category: string } = {
    externalId: null,
    status: "en_revision",
    category: order.category,
  }
  if (deps.validateExternal !== false) {
    if (!adapter?.requestTemplate) throw validation("Este canal no usa plantillas")
    try {
      answer = await adapter.requestTemplate(
        config,
        {
          name: order.name,
          language,
          category: order.category,
          body: order.body,
          examples: order.examples,
          buttons: order.buttons,
          ...(order.link ? { link: order.link } : {}),
        },
        { fetch: deps.fetch },
      )
    } catch (error) {
      throw new ServiceError(
        "TEMPLATE_REQUEST_FAILED",
        502,
        error instanceof Error ? error.message : "El proveedor no aceptó la solicitud",
      )
    }
  }
  const now = new Date()
  const [created] = await tx
    .insert(channelTemplate)
    .values({
      organizationId: orgId,
      connectionId,
      name: order.name,
      language,
      category: answer.category,
      status: answer.status,
      body: order.body,
      variables: order.examples.length,
      buttons: order.buttons,
      externalId: answer.externalId,
      messageKey: order.messageKey,
      requestedAt: now,
      statusSince: now,
    })
    .onConflictDoNothing({
      target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
    })
    .returning()
  if (created) return toItem(created)
  const row = await findTemplateByName(tx, orgId, connectionId, order.name, language)
  if (!row) throw new Error("No se pudo registrar la plantilla solicitada")
  return row
}

export interface TemplateStatusChange {
  template: TemplateItem
  previous: TemplateStatus
}

/** Aplica los avisos de cambio de estado del proveedor. Devuelve solo lo que cambió. */
export async function applyTemplateStatuses(
  tx: Db,
  orgId: string,
  connectionId: string,
  statuses: NormalizedTemplateStatus[],
): Promise<TemplateStatusChange[]> {
  const changes: TemplateStatusChange[] = []
  const now = new Date()
  for (const update of statuses) {
    const [current] = await tx
      .select()
      .from(channelTemplate)
      .where(
        and(
          eq(channelTemplate.organizationId, orgId),
          eq(channelTemplate.connectionId, connectionId),
          eq(channelTemplate.name, update.name),
          eq(channelTemplate.language, update.language),
        ),
      )
      .for("update")
      .limit(1)
    // Una plantilla que el catálogo aún no conoce llegará con la próxima lectura de la cuenta.
    if (!current || (current.status === update.status && current.reason === update.reason)) continue
    const [row] = await tx
      .update(channelTemplate)
      .set({
        status: update.status,
        reason: update.reason,
        ...(update.externalId ? { externalId: update.externalId } : {}),
        ...(current.status === update.status ? {} : { statusSince: now }),
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(channelTemplate.id, current.id))
      .returning()
    if (row) changes.push({ template: toItem(row), previous: current.status as TemplateStatus })
  }
  return changes
}

export interface TemplateCategoryChange {
  template: TemplateItem
  previous: string
}

/**
 * Aplica los avisos de cambio de categoría del proveedor (en WhatsApp,
 * `template_category_update`). Devuelve solo lo que cambió. Lo que dice a quien
 * administra lo calcula «Te espera» con el estado (`listRecategorizedMessages`).
 */
export async function applyTemplateCategories(
  tx: Db,
  orgId: string,
  connectionId: string,
  updates: NormalizedTemplateCategory[],
): Promise<TemplateCategoryChange[]> {
  const changes: TemplateCategoryChange[] = []
  const now = new Date()
  for (const update of updates) {
    const [current] = await tx
      .select()
      .from(channelTemplate)
      .where(
        and(
          eq(channelTemplate.organizationId, orgId),
          eq(channelTemplate.connectionId, connectionId),
          eq(channelTemplate.name, update.name),
          eq(channelTemplate.language, update.language),
        ),
      )
      .for("update")
      .limit(1)
    // Una plantilla que el catálogo aún no conoce llega con la próxima lectura de la cuenta.
    if (!current || current.category === update.category) continue
    const [row] = await tx
      .update(channelTemplate)
      .set({ category: update.category, syncedAt: now, updatedAt: now })
      .where(eq(channelTemplate.id, current.id))
      .returning()
    if (row) changes.push({ template: toItem(row), previous: current.category })
  }
  return changes
}

/**
 * Deja de servir una plantilla que la clínica eliminó. La fila se conserva: los
 * mensajes que la usaron siguen diciendo cuál fue.
 */
export async function retireTemplates(tx: Db, orgId: string, names: string[], reason: string): Promise<void> {
  if (names.length === 0) return
  const now = new Date()
  await tx
    .update(channelTemplate)
    .set({ status: "deshabilitada", reason, statusSince: now, syncedAt: now, updatedAt: now })
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        inArray(channelTemplate.name, names),
        ne(channelTemplate.status, "deshabilitada"),
      ),
    )
}
