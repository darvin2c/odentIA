import {
  type ChannelProvider,
  channelAdapters,
  type NormalizedTemplateStatus,
  type ProviderTemplate,
  type TemplateStatus,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection, channelTemplate } from "@odentia/db/schema/crm"
import { and, asc, eq, inArray } from "drizzle-orm"
import {
  AUTOMATION_MESSAGE_KEYS,
  AUTOMATION_MESSAGE_LANGUAGE,
  AUTOMATION_MESSAGES,
  type AutomationMessageKey,
  messageExamples,
} from "./automation-messages.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { decryptConfig } from "./secrets.js"

/**
 * Catálogo de plantillas por conexión. Lo que hay en la cuenta del proveedor
 * manda: se lee de ahí, se actualiza cuando el proveedor avisa y solo una
 * plantilla `aprobada` se puede enviar. odentIA pide las que necesitan sus
 * propios mensajes (`AUTOMATION_MESSAGES`); la clínica no escribe nombres.
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
  /** Mensaje de odentIA al que sirve; nulo si es una plantilla propia de la clínica. */
  messageKey: string | null
  requestedAt: string | null
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
    requestedAt: row.requestedAt?.toISOString() ?? null,
    syncedAt: row.syncedAt?.toISOString() ?? null,
  }
}

/** Mensaje de odentIA al que corresponde un nombre de plantilla, si es una de las suyas. */
function messageKeyOfTemplate(name: string): AutomationMessageKey | null {
  return AUTOMATION_MESSAGE_KEYS.find((key) => AUTOMATION_MESSAGES[key].template === name) ?? null
}

async function connectionWithAdapter(tx: Db, orgId: string, connectionId: string, secretsKey: Buffer) {
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
 * Regla única antes de enviar una plantilla, la use una persona, una
 * automatización o el agente: existe en la conexión, está aprobada y lleva
 * tantos datos como variables tiene.
 */
export async function assertTemplateSendable(
  tx: Db,
  orgId: string,
  connectionId: string,
  input: { name: string; language: string; params: number },
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
  return toItem(row)
}

async function upsertFromProvider(
  tx: Db,
  orgId: string,
  connectionId: string,
  template: ProviderTemplate,
  now: Date,
): Promise<void> {
  const values = {
    category: template.category,
    status: template.status,
    reason: template.reason,
    body: template.body,
    variables: template.variables,
    buttons: template.buttons,
    externalId: template.externalId,
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
      messageKey: messageKeyOfTemplate(template.name),
      ...values,
    })
    .onConflictDoUpdate({
      target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
      set: values,
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
  for (const template of fetched) await upsertFromProvider(tx, orgId, connectionId, template, now)
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
      .set({ status: "deshabilitada", reason: "Ya no está en la cuenta", syncedAt: now, updatedAt: now })
      .where(
        inArray(
          channelTemplate.id,
          gone.map((row) => row.id),
        ),
      )
  }
  return listChannelTemplates(tx, orgId, connectionId)
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
        messageKey: messageKeyOfTemplate(template.name),
      })
      .onConflictDoNothing({
        target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
      })
  }
}

/**
 * Pide al proveedor la plantilla de un mensaje de odentIA, una sola vez por
 * conexión: si ya está en el catálogo (en cualquier estado) no se vuelve a
 * pedir. El proveedor decide el estado y la categoría.
 */
export async function requestMessageTemplate(
  tx: Db,
  orgId: string,
  connectionId: string,
  messageKey: AutomationMessageKey,
  secretsKey: Buffer,
  deps: TemplateDeps,
): Promise<TemplateItem> {
  const spec = AUTOMATION_MESSAGES[messageKey]
  const language = AUTOMATION_MESSAGE_LANGUAGE
  const [existing] = await tx
    .select()
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        eq(channelTemplate.connectionId, connectionId),
        eq(channelTemplate.name, spec.template),
        eq(channelTemplate.language, language),
      ),
    )
    .limit(1)
  if (existing) return toItem(existing)
  const { adapter, config } = await connectionWithAdapter(tx, orgId, connectionId, secretsKey)
  const buttons = spec.buttons.map((button) => button.title)
  let answer: { externalId: string | null; status: TemplateStatus; category: string } = {
    externalId: null,
    status: "en_revision",
    category: spec.category,
  }
  if (deps.validateExternal !== false) {
    if (!adapter?.requestTemplate) throw validation("Este canal no usa plantillas")
    try {
      answer = await adapter.requestTemplate(
        config,
        { name: spec.template, language, category: spec.category, body: spec.body, examples: messageExamples(spec), buttons },
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
      name: spec.template,
      language,
      category: answer.category,
      status: answer.status,
      body: spec.body,
      variables: spec.variables.length,
      buttons,
      externalId: answer.externalId,
      messageKey,
      requestedAt: now,
    })
    .onConflictDoNothing({
      target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
    })
    .returning()
  if (created) return toItem(created)
  const [row] = await tx
    .select()
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.connectionId, connectionId),
        eq(channelTemplate.name, spec.template),
        eq(channelTemplate.language, language),
      ),
    )
    .limit(1)
  if (!row) throw new Error("No se pudo registrar la plantilla solicitada")
  return toItem(row)
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
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(channelTemplate.id, current.id))
      .returning()
    if (row) changes.push({ template: toItem(row), previous: current.status as TemplateStatus })
  }
  return changes
}

/** Plantilla de un mensaje de odentIA en una conexión, en el estado que tenga. */
export async function findMessageTemplate(
  tx: Db,
  orgId: string,
  connectionId: string,
  messageKey: AutomationMessageKey,
): Promise<TemplateItem | null> {
  const [row] = await tx
    .select()
    .from(channelTemplate)
    .where(
      and(
        eq(channelTemplate.organizationId, orgId),
        eq(channelTemplate.connectionId, connectionId),
        eq(channelTemplate.name, AUTOMATION_MESSAGES[messageKey].template),
        eq(channelTemplate.language, AUTOMATION_MESSAGE_LANGUAGE),
      ),
    )
    .limit(1)
  return row ? toItem(row) : null
}
