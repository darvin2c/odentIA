import type { Db } from "@odentia/db"
import {
  agentKnowledgeEntry,
  agentKnowledgeGap,
  agentKnowledgeRevision,
  agentLesson,
  KNOWLEDGE_GAP_STATUSES,
  type KnowledgeGapStatus,
  type KnowledgeKind,
  type KnowledgeStatus,
} from "@odentia/db/schema/agent"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { message } from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, gt, ilike, inArray, ne, or, sql } from "drizzle-orm"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { branchNotFound, notFound, validation } from "./errors.js"
import { getOrgLocale, NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { listPaymentMethods } from "./payment-methods.js"
import { listClinicPromotionSummaries } from "./promotions.js"

const KINDS = ["faq", "info_sede", "politica"] as const
const STATUSES = ["borrador", "publicada"] as const
const MAX_LIMIT = 100
const ASK_FORM_LIMIT = 20
const ASK_FORM_CHARS = 120

/**
 * Lo que una clínica debería tener respondido antes de dejar al agente
 * atender solo. `auto` se cubre con datos que ya están en el sistema (sedes,
 * servicios y medios de pago); el resto, con una respuesta oficial vigente
 * marcada con su clave.
 */
export const KNOWLEDGE_BASICS: ReadonlyArray<{ key: string; question: string; auto?: string }> = [
  { key: "horario", question: "¿Cuál es el horario de atención?" },
  { key: "ubicacion", question: "¿Dónde están y cómo llego?", auto: "Sedes con dirección" },
  { key: "telefono", question: "¿A qué número puedo llamar?", auto: "Sedes con teléfono" },
  { key: "estacionamiento", question: "¿Tienen estacionamiento?" },
  { key: "accesibilidad", question: "¿El local es accesible para silla de ruedas?" },
  { key: "servicios", question: "¿Qué tratamientos ofrecen?", auto: "Servicios activos" },
  { key: "precios", question: "¿Cuánto cuesta una consulta o un tratamiento?", auto: "Precios de los servicios" },
  { key: "presupuesto", question: "¿Cómo obtengo un presupuesto?" },
  { key: "medios_pago", question: "¿Qué medios de pago aceptan?", auto: "Medios de pago activos" },
  { key: "cuotas", question: "¿Se puede pagar en cuotas?" },
  { key: "seguros", question: "¿Trabajan con seguros o convenios?" },
  // Neutral respecto del país: cada uno llama distinto a su comprobante (boleta, factura, recibo…).
  { key: "comprobante", question: "¿Emiten comprobante de pago?" },
  { key: "sin_cita", question: "¿Atienden sin cita?" },
  { key: "urgencias", question: "¿Atienden urgencias?" },
  { key: "primera_cita", question: "¿Qué necesito llevar a mi primera cita?" },
  { key: "duracion", question: "¿Cuánto dura una cita?" },
  { key: "cambiar_cita", question: "¿Cómo cambio o cancelo mi cita?" },
  { key: "tardanza", question: "¿Qué pasa si llego tarde o no puedo ir?" },
  { key: "ninos", question: "¿Atienden a niños? ¿Desde qué edad?" },
  { key: "embarazo", question: "¿Atienden a embarazadas?" },
  { key: "especialistas", question: "¿Qué especialistas atienden?" },
  { key: "dolor", question: "¿El tratamiento duele? ¿Usan anestesia?" },
  { key: "radiografias", question: "¿Toman radiografías en la clínica?" },
  { key: "garantia", question: "¿Los tratamientos tienen garantía?" },
  { key: "reclamos", question: "¿Dónde presento una queja o una sugerencia?" },
]

/** `vigente` es lo único que llega al agente. */
export type KnowledgeState = "borrador" | "programada" | "vigente" | "vencida"

export interface KnowledgeEntryItem {
  id: string
  kind: KnowledgeKind
  title: string
  body: string
  branchId: string | null
  branchName: string | null
  status: KnowledgeStatus
  /** Estado efectivo hoy en la zona de la clínica, contando la vigencia. */
  state: KnowledgeState
  /** Fechas de la clínica (AAAA-MM-DD), inclusive; nulo = sin límite. */
  validFrom: string | null
  validUntil: string | null
  askForms: string[]
  basicKey: string | null
  version: number
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Una respuesta en la lista de la clínica, con lo que «Aprender» sabe de ella. */
export interface KnowledgeEntryListItem extends KnowledgeEntryItem {
  /** Lección propuesta que cambiaría esta respuesta: hay un cambio por aprobar. */
  pendingLessonId: string | null
  /** Si la creó o la cambió una corrección aprobada, y cuántas veces se usó desde entonces. */
  learned: { uses: number } | null
}

type EntryRow = typeof agentKnowledgeEntry.$inferSelect

function stateOf(row: Pick<EntryRow, "status" | "validFrom" | "validUntil">, today: string): KnowledgeState {
  if (row.status !== "publicada") return "borrador"
  if (row.validFrom && row.validFrom > today) return "programada"
  if (row.validUntil && row.validUntil < today) return "vencida"
  return "vigente"
}

function toItem(row: EntryRow, today: string, branchName: string | null = null): KnowledgeEntryItem {
  return {
    id: row.id,
    kind: row.kind as KnowledgeKind,
    title: row.title,
    body: row.body,
    branchId: row.branchId,
    branchName,
    status: row.status as KnowledgeStatus,
    state: stateOf(row, today),
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    askForms: row.askForms,
    basicKey: row.basicKey,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Fecha de hoy en la zona de la clínica: la vigencia se cuenta en sus días, no en UTC. */
async function orgToday(tx: Db, orgId: string): Promise<string> {
  const zone = await getOrgLocale(tx, orgId)
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone }).format(new Date())
}

function assertKind(kind: string): asserts kind is KnowledgeKind {
  if (!(KINDS as readonly string[]).includes(kind)) throw validation("kind debe ser faq|info_sede|politica")
}

function assertStatus(status: string): asserts status is KnowledgeStatus {
  if (!(STATUSES as readonly string[]).includes(status)) throw validation("status debe ser borrador|publicada")
}

function cleanText(value: string | undefined, field: string, max: number): string {
  const text = value?.trim() ?? ""
  if (!text) throw validation(`${field} es obligatorio`)
  if (text.length > max) throw validation(`${field} supera ${max} caracteres`)
  return text
}

function cleanDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw validation(`${field} debe ser una fecha AAAA-MM-DD`)
  }
  return value
}

/** Minúsculas y sin tildes: así se comparan preguntas y títulos. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function cleanAskForms(value: unknown, title: string): string[] {
  if (!Array.isArray(value)) throw validation("Las formas de preguntar deben ser una lista")
  const seen = new Set([normalizeForSearch(title)])
  const forms: string[] = []
  for (const raw of value) {
    if (typeof raw !== "string") throw validation("Cada forma de preguntar debe ser texto")
    const form = raw.replace(/\s+/g, " ").trim()
    if (!form) continue
    if (form.length > ASK_FORM_CHARS) throw validation(`Cada forma de preguntar admite hasta ${ASK_FORM_CHARS} caracteres`)
    const key = normalizeForSearch(form)
    if (!key || seen.has(key)) continue
    seen.add(key)
    forms.push(form)
  }
  if (forms.length > ASK_FORM_LIMIT) throw validation(`Hasta ${ASK_FORM_LIMIT} formas de preguntar por respuesta`)
  return forms
}

function cleanBasicKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null
  if (!KNOWLEDGE_BASICS.some((item) => item.key === value)) throw validation("basicKey no es una pregunta básica conocida")
  return value
}

function assertValidity(validFrom: string | null, validUntil: string | null): void {
  if (validFrom && validUntil && validUntil < validFrom) {
    throw validation("La vigencia termina antes de empezar")
  }
}

async function requireBranchOfOrg(tx: Db, orgId: string, branchId: string): Promise<string> {
  const [row] = await tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, branchId)))
    .limit(1)
  if (!row) throw branchNotFound()
  return row.name
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, entityId: string, metadata?: Record<string, unknown>) {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "agent_knowledge_entry",
    entityId,
    metadata,
  })
}

export interface KnowledgeEntryInput {
  kind: string
  title: string
  body: string
  branchId?: string | null
  validFrom?: string | null
  validUntil?: string | null
  askForms?: string[]
  basicKey?: string | null
}

/** Alta de entrada en borrador con su revisión v1. */
export async function createKnowledgeEntry(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: KnowledgeEntryInput,
): Promise<KnowledgeEntryItem> {
  assertKind(input.kind)
  const title = cleanText(input.title, "El título", 200)
  const body = cleanText(input.body, "El contenido", 8000)
  const validFrom = cleanDate(input.validFrom, "validFrom")
  const validUntil = cleanDate(input.validUntil, "validUntil")
  assertValidity(validFrom, validUntil)
  let branchName: string | null = null
  const branchId = input.branchId ?? null
  if (branchId) branchName = await requireBranchOfOrg(tx, orgId, branchId)
  const [row] = await tx
    .insert(agentKnowledgeEntry)
    .values({
      organizationId: orgId,
      kind: input.kind,
      title,
      body,
      branchId,
      validFrom,
      validUntil,
      askForms: input.askForms === undefined ? [] : cleanAskForms(input.askForms, title),
      basicKey: cleanBasicKey(input.basicKey),
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear la entrada de conocimiento")
  await tx.insert(agentKnowledgeRevision).values({
    organizationId: orgId,
    entryId: row.id,
    version: 1,
    title,
    body,
    createdBy: actorUserId,
  })
  await audit(tx, orgId, actorUserId, "agent.knowledge_created", row.id, { kind: input.kind })
  return toItem(row, await orgToday(tx, orgId), branchName)
}

async function requireEntry(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(agentKnowledgeEntry)
    .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, id)))
    .limit(1)
  if (!row) throw notFound("Entrada de conocimiento")
  return row
}

export async function getKnowledgeEntry(tx: Db, orgId: string, id: string): Promise<KnowledgeEntryItem> {
  const row = await requireEntry(tx, orgId, id)
  let branchName: string | null = null
  if (row.branchId) {
    const [b] = await tx.select({ name: branch.name }).from(branch).where(eq(branch.id, row.branchId)).limit(1)
    branchName = b?.name ?? null
  }
  return toItem(row, await orgToday(tx, orgId), branchName)
}

/**
 * Edición: bloquea la fila y, si cambian el título o el texto, congela la
 * versión en revisiones y sube `version`. Vigencia, sede, formas de preguntar
 * y clave básica son de catalogación: no cambian lo que la respuesta dice y
 * no generan revisión.
 */
export async function updateKnowledgeEntry(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  input: Partial<Omit<KnowledgeEntryInput, "kind">>,
): Promise<KnowledgeEntryItem> {
  const [locked] = await tx
    .select()
    .from(agentKnowledgeEntry)
    .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, id)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Entrada de conocimiento")
  const current = locked
  const title = input.title === undefined ? current.title : cleanText(input.title, "El título", 200)
  const body = input.body === undefined ? current.body : cleanText(input.body, "El contenido", 8000)
  const validFrom = input.validFrom === undefined ? current.validFrom : cleanDate(input.validFrom, "validFrom")
  const validUntil = input.validUntil === undefined ? current.validUntil : cleanDate(input.validUntil, "validUntil")
  assertValidity(validFrom, validUntil)
  const askForms = cleanAskForms(input.askForms === undefined ? current.askForms : input.askForms, title)
  const basicKey = input.basicKey === undefined ? current.basicKey : cleanBasicKey(input.basicKey)
  let branchId = current.branchId
  let branchName: string | null = null
  if (input.branchId !== undefined) {
    branchId = input.branchId
    if (branchId) branchName = await requireBranchOfOrg(tx, orgId, branchId)
  } else if (branchId) {
    const [b] = await tx.select({ name: branch.name }).from(branch).where(eq(branch.id, branchId)).limit(1)
    branchName = b?.name ?? null
  }
  const contentChanged = title !== current.title || body !== current.body
  const version = contentChanged ? current.version + 1 : current.version
  const [row] = await tx
    .update(agentKnowledgeEntry)
    .set({ title, body, branchId, validFrom, validUntil, askForms, basicKey, version, updatedAt: new Date() })
    .where(eq(agentKnowledgeEntry.id, id))
    .returning()
  if (!row) throw new Error("No se pudo actualizar la entrada")
  if (contentChanged) {
    await tx.insert(agentKnowledgeRevision).values({
      organizationId: orgId,
      entryId: id,
      version,
      title,
      body,
      createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "agent.knowledge_updated", id, { version, contentChanged })
  return toItem(row, await orgToday(tx, orgId), branchName)
}

/** Publica o devuelve a borrador. Solo lo publicado y vigente alimenta al agente. */
export async function setKnowledgeStatus(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  status: string,
): Promise<KnowledgeEntryItem> {
  assertStatus(status)
  await requireEntry(tx, orgId, id)
  const [row] = await tx
    .update(agentKnowledgeEntry)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentKnowledgeEntry.id, id))
    .returning()
  if (!row) throw new Error("No se pudo cambiar el estado")
  await audit(tx, orgId, actorUserId, "agent.knowledge_status", id, { status })
  return getKnowledgeEntry(tx, orgId, id)
}

export interface ListKnowledgeInput {
  kind?: string
  status?: string
  branchId?: string
  q?: string
  limit?: number
  /** Desde dónde seguir (`nextCursor` de la página anterior). */
  cursor?: string
}

export interface KnowledgePage {
  items: KnowledgeEntryListItem[]
  /** Nulo si no hay más. */
  nextCursor: string | null
  /** Todas las que cumplen el filtro, no solo las de esta página. */
  total: number
}

/**
 * La pantalla de Conocimiento, por páginas (topes de la fase 4, B6): la
 * respuesta 101 también se abre, se corrige y se retira. La búsqueda se hace
 * en el servidor; el orden es la última edición.
 */
export async function listKnowledgePage(tx: Db, orgId: string, input: ListKnowledgeInput = {}): Promise<KnowledgePage> {
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), MAX_LIMIT)
  const rows = await listKnowledgeEntries(tx, orgId, { ...input, limit: limit + 1 }, true)
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  const [counted] = await tx.select({ total: count() }).from(agentKnowledgeEntry).where(and(...knowledgeConditions(orgId, input)))
  return {
    items: items.map(({ cursorTs: _ts, ...item }) => item),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorTs, last.id) : null,
    total: Number(counted?.total ?? 0),
  }
}

function knowledgeConditions(orgId: string, input: ListKnowledgeInput) {
  const conditions = [eq(agentKnowledgeEntry.organizationId, orgId)]
  if (input.kind) {
    assertKind(input.kind)
    conditions.push(eq(agentKnowledgeEntry.kind, input.kind))
  }
  if (input.status) {
    assertStatus(input.status)
    conditions.push(eq(agentKnowledgeEntry.status, input.status))
  }
  if (input.branchId) conditions.push(eq(agentKnowledgeEntry.branchId, input.branchId))
  const q = input.q?.trim()
  if (q) {
    const like = `%${q}%`
    conditions.push(or(ilike(agentKnowledgeEntry.title, like), ilike(agentKnowledgeEntry.body, like))!)
  }
  return conditions
}

export async function listKnowledgeEntries(tx: Db, orgId: string, input?: ListKnowledgeInput): Promise<KnowledgeEntryListItem[]>
export async function listKnowledgeEntries(
  tx: Db,
  orgId: string,
  input: ListKnowledgeInput,
  withCursor: true,
): Promise<Array<KnowledgeEntryListItem & { cursorTs: string }>>
export async function listKnowledgeEntries(
  tx: Db,
  orgId: string,
  input: ListKnowledgeInput = {},
  withCursor = false,
): Promise<Array<KnowledgeEntryListItem & { cursorTs?: string }>> {
  const conditions = knowledgeConditions(orgId, input)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!cursor || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw validation("Cursor inválido")
    conditions.push(sql`(${agentKnowledgeEntry.updatedAt}, ${agentKnowledgeEntry.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`)
  }
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), MAX_LIMIT + 1)
  const rows = await tx
    .select({ entry: agentKnowledgeEntry, branchName: branch.name, cursorTs: sql<string>`${agentKnowledgeEntry.updatedAt}::text` })
    .from(agentKnowledgeEntry)
    .leftJoin(branch, eq(branch.id, agentKnowledgeEntry.branchId))
    .where(and(...conditions))
    .orderBy(desc(agentKnowledgeEntry.updatedAt), desc(agentKnowledgeEntry.id))
    .limit(limit)
  const today = await orgToday(tx, orgId)
  // Lo que «Aprender» sabe de cada respuesta: la lección propuesta que la
  // cambiaría (la más reciente) y las activas que la crearon o la cambiaron.
  const ids = rows.map(({ entry }) => entry.id)
  const lessons = ids.length
    ? await tx
        .select({ id: agentLesson.id, entryId: agentLesson.knowledgeEntryId, status: agentLesson.status, uses: agentLesson.uses })
        .from(agentLesson)
        .where(
          and(
            eq(agentLesson.organizationId, orgId),
            eq(agentLesson.kind, "respuesta_oficial"),
            inArray(agentLesson.status, ["propuesta", "activa"]),
            inArray(agentLesson.knowledgeEntryId, ids),
          ),
        )
        .orderBy(desc(agentLesson.createdAt), asc(agentLesson.id))
    : []
  const pending = new Map<string, string>()
  const learned = new Map<string, number>()
  for (const lesson of lessons) {
    if (!lesson.entryId) continue
    if (lesson.status === "propuesta") {
      if (!pending.has(lesson.entryId)) pending.set(lesson.entryId, lesson.id)
    } else learned.set(lesson.entryId, (learned.get(lesson.entryId) ?? 0) + lesson.uses)
  }
  return rows.map(({ entry, branchName, cursorTs }) => ({
    ...toItem(entry, today, branchName),
    pendingLessonId: pending.get(entry.id) ?? null,
    learned: learned.has(entry.id) ? { uses: learned.get(entry.id) ?? 0 } : null,
    ...(withCursor ? { cursorTs } : {}),
  }))
}

export async function listKnowledgeRevisions(tx: Db, orgId: string, entryId: string) {
  await requireEntry(tx, orgId, entryId)
  const rows = await tx
    .select()
    .from(agentKnowledgeRevision)
    .where(and(eq(agentKnowledgeRevision.organizationId, orgId), eq(agentKnowledgeRevision.entryId, entryId)))
    .orderBy(desc(agentKnowledgeRevision.version))
  return rows.map((r) => ({
    version: r.version,
    title: r.title,
    body: r.body,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }))
}

/**
 * Todo lo que el agente puede citar hoy: publicado y dentro de su vigencia.
 * Orden estable (alta y luego id) para que el bloque del prompt no cambie
 * entre turnos mientras nadie edite el conocimiento.
 */
export async function listActiveKnowledge(tx: Db, orgId: string): Promise<KnowledgeEntryItem[]> {
  const today = await orgToday(tx, orgId)
  const rows = await tx
    .select({ entry: agentKnowledgeEntry, branchName: branch.name })
    .from(agentKnowledgeEntry)
    .leftJoin(branch, eq(branch.id, agentKnowledgeEntry.branchId))
    .where(
      and(
        eq(agentKnowledgeEntry.organizationId, orgId),
        eq(agentKnowledgeEntry.status, "publicada"),
        sql`(${agentKnowledgeEntry.validFrom} is null or ${agentKnowledgeEntry.validFrom} <= ${today})`,
        sql`(${agentKnowledgeEntry.validUntil} is null or ${agentKnowledgeEntry.validUntil} >= ${today})`,
      ),
    )
    // Todas, sin tope: cuando no caben en el prompt va el índice y el texto se pide por su título.
    .orderBy(asc(agentKnowledgeEntry.createdAt), asc(agentKnowledgeEntry.id))
  return rows.map(({ entry, branchName }) => toItem(entry, today, branchName))
}

const STOPWORDS = new Set(
  "a al algo como con cual cuales cuando de del donde el ella ellos en es esa ese eso esta este esto hay la las le lo los me mi mis muy no nos o para pero por que se si sin su sus te tienen tiene tu un una unas unos y ya yo hola buenas buenos dias tardes noches gracias favor quiero quisiera puedo puede pueden saber".split(
    " ",
  ),
)

function significantTokens(text: string): string[] {
  return normalizeForSearch(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

/**
 * Puntúa una respuesta frente a una pregunta. Sin vectores: el conocimiento
 * de una clínica son decenas o pocos cientos de textos cortos y basta con
 * título, formas de preguntar y palabras significativas. El título exacto
 * gana siempre: así se pide el texto completo de una respuesta recortada.
 */
export function scoreKnowledgeMatch(
  query: string,
  entry: Pick<KnowledgeEntryItem, "title" | "body" | "askForms">,
): number {
  const wanted = normalizeForSearch(query)
  if (!wanted) return 0
  const title = normalizeForSearch(entry.title)
  const forms = entry.askForms.map(normalizeForSearch)
  const body = normalizeForSearch(entry.body)
  if (title === wanted) return 1000
  if (forms.includes(wanted)) return 900
  let score = 0
  if (title.includes(wanted)) score += 400
  else if (forms.some((form) => form.includes(wanted))) score += 350
  else if (body.includes(wanted)) score += 200
  const tokens = [...new Set(significantTokens(query))]
  if (!tokens.length) return score
  const titleWords = `${title} ${forms.join(" ")}`.split(" ")
  const bodyWords = body.split(" ")
  let matched = 0
  for (const token of tokens) {
    // Coincidencia por raíz corta: «pago» encuentra «pagos» y «ninos», «nino».
    const stem = token.length > 4 ? token.slice(0, -1) : token
    if (titleWords.some((word) => word.startsWith(stem))) {
      matched += 1
      score += 30
    } else if (bodyWords.some((word) => word.startsWith(stem))) {
      matched += 1
      score += 10
    }
  }
  // Menos de la mitad de las palabras de la pregunta es parecido casual, no respuesta.
  if (score < 200 && matched * 2 < tokens.length) return 0
  return score
}

/**
 * Búsqueda sobre lo vigente (lo único que el agente puede citar). `rankedIds`
 * pone delante lo que la búsqueda por significado ya encontró, en su orden.
 */
export async function searchPublishedKnowledge(
  tx: Db,
  orgId: string,
  q: string,
  limit = 5,
  rankedIds: string[] = [],
): Promise<KnowledgeEntryItem[]> {
  const query = q.trim()
  if (!query) return []
  const active = await listActiveKnowledge(tx, orgId)
  const ranked = new Map(rankedIds.map((id, index) => [id, index]))
  return active
    .map((entry) => {
      const position = ranked.get(entry.id)
      return { entry, score: scoreKnowledgeMatch(query, entry) + (position === undefined ? 0 : 1000 - position) }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id))
    .slice(0, Math.min(Math.max(limit, 1), 10))
    .map((item) => item.entry)
}

export interface ClinicInfoSnapshot {
  clinicName: string
  /** Teléfono para urgencias de la clínica (E.164); nulo si no lo registró. */
  emergencyPhone?: string | null
  timezone: string
  /** Formato regional de la clínica (BCP 47): con él se escriben los importes. */
  locale: string
  /** Todas las sedes activas: son pocas y el agente necesita el id de cada una. */
  branches: Array<{ id: string; name: string; address: string | null; phone: string | null; mapsUrl: string | null; timezone: string | null }>
  paymentMethods: Array<{ id: string; name: string; typeCode: string }>
  /** Medios que la clínica desactivó: se dicen como no aceptados para que el agente no los ofrezca. */
  refusedPaymentMethods: string[]
  /** Promociones vigentes: el agente las nombra sin inventar precios finales. */
  promotions: Array<{ id: string; name: string; endsAt: string | null }>
}

/**
 * Información de la clínica desde catálogo y sedes (fuente de verdad para el
 * agente: nunca inventa precios ni direcciones). Incluye los medios de pago
 * activos y las promociones vigentes: el agente responde con estas mismas
 * listas que ofrece caja.
 */
export async function getClinicInfoSnapshot(tx: Db, orgId: string): Promise<ClinicInfoSnapshot> {
  const [profile] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      timezone: orgProfile.timezone,
      locale: orgProfile.locale,
      emergencyPhone: orgProfile.emergencyPhone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const branchRows = await tx
    .select({
      id: branch.id,
      name: branch.name,
      address: branch.addressLine1,
      phone: branch.phone,
      mapsUrl: branch.mapsUrl,
      timezone: branch.timezone,
    })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.name), asc(branch.id))
  const allMethods = await listPaymentMethods(tx, orgId, { activeOnly: false })
  const methods = allMethods.filter((m) => m.isActive)
  const promos = await listClinicPromotionSummaries(tx, orgId)
  return {
    clinicName: profile?.tradeName ?? profile?.legalName ?? "la clínica",
    emergencyPhone: profile?.emergencyPhone ?? null,
    timezone: profile?.timezone ?? NEUTRAL_TIMEZONE,
    locale: profile?.locale || NEUTRAL_LOCALE,
    branches: branchRows.map((b) => ({ ...b, address: b.address ?? null })),
    paymentMethods: methods.map((m) => ({ id: m.id, name: m.name, typeCode: m.typeCode })),
    refusedPaymentMethods: allMethods.filter((m) => !m.isActive).map((m) => m.name),
    promotions: promos.map((p) => ({ id: p.id, name: p.name, endsAt: p.endsAt ? p.endsAt.toISOString() : null })),
  }
}

export interface KnowledgeDataSources {
  /**
   * Servicios activos con tarifa mayor que cero que el agente puede decir
   * («Precio exacto» o «Desde»): de ahí salen los precios que da. Los de
   * «Solo con evaluación» no cuentan, porque su número no le llega.
   */
  pricedServices: number
  /** Servicios activos, con o sin costo. */
  services: number
  /** Sedes activas. */
  branches: number
}

/**
 * Cuánto hay en el sistema de lo que el agente lee en el momento. Cuenta todo,
 * sin el tope del bloque del prompt (`getClinicInfoSnapshot`).
 */
export async function getKnowledgeDataSources(tx: Db, orgId: string): Promise<KnowledgeDataSources> {
  const [services] = await tx
    .select({
      total: count(),
      priced: sql<number>`count(*) filter (where ${serviceCatalog.priceCents} > 0 and ${serviceCatalog.priceDisclosure} in ('exacto', 'desde'))::int`,
    })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true), ne(serviceCatalog.source, "legacy")))
  const [branches] = await tx
    .select({ total: count() })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
  return { pricedServices: services?.priced ?? 0, services: services?.total ?? 0, branches: branches?.total ?? 0 }
}

/**
 * Tope por respuesta oficial dentro del prompt. El bloque viaja en cada
 * llamada al modelo; una respuesta extensa (un protocolo pegado entero) se
 * recorta con aviso y su texto completo se pide con `consultar_conocimiento`.
 */
export const KNOWLEDGE_PROMPT_ENTRY_CHARS = 600
/**
 * Tope del bloque de respuestas oficiales. Si todas caben (ya recortadas), van
 * con su texto; si no, va solo el índice y cada texto se pide por su título.
 */
export const KNOWLEDGE_PROMPT_BUDGET_CHARS = 12_000
const KNOWLEDGE_INDEX_HINT_CHARS = 90

function clip(text: string, max: number): string {
  // El corte no deja medio carácter (un emoji ocupa dos unidades).
  return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "").trimEnd()
}

function entryHeading(entry: KnowledgeEntryItem): string {
  return entry.branchName ? `${entry.title} (solo sede ${entry.branchName})` : entry.title
}

/** Texto de una respuesta para el modelo, recortado con aviso si es extensa. */
export function formatKnowledgeEntry(entry: KnowledgeEntryItem): string {
  const body =
    entry.body.length > KNOWLEDGE_PROMPT_ENTRY_CHARS
      ? `${clip(entry.body, KNOWLEDGE_PROMPT_ENTRY_CHARS)}… (recortada)`
      : entry.body
  return `- ${entryHeading(entry)}: ${body}`
}

/** Una línea por respuesta: lo que hace falta para saber si aplica y pedirla por su título. */
export function formatKnowledgeIndexLine(entry: KnowledgeEntryItem): string {
  const hint = entry.body.replace(/\s+/g, " ")
  return `- ${entryHeading(entry)} — ${hint.length > KNOWLEDGE_INDEX_HINT_CHARS ? `${clip(hint, KNOWLEDGE_INDEX_HINT_CHARS)}…` : hint}`
}

/** `completo`: todas las respuestas con su texto. `indice`: solo títulos; el texto se pide o se elige por turno. */
export type KnowledgePromptMode = "completo" | "indice"

/** ¿Caben todas las respuestas, ya recortadas, en el bloque estable del prompt? */
export function knowledgeFitsPrompt(entries: KnowledgeEntryItem[]): boolean {
  let total = 0
  for (const entry of entries) {
    total += formatKnowledgeEntry(entry).length + 1
    if (total > KNOWLEDGE_PROMPT_BUDGET_CHARS) return false
  }
  return true
}

/**
 * Bloque de sistema con conocimiento vigente, catálogo y sedes. Es igual para
 * toda la clínica mientras nadie edite el conocimiento: `mode` lo decide la
 * organización (si caben todas o hay modelo de decisión), nunca el hilo. Los
 * servicios, promociones y profesionales son las líneas de «Informar»
 * (`formatAgentClinicData`): no hay otra lista de servicios ni de tarifas.
 * Con «Informar» apagado (`informs: false`) tampoco van los medios de pago.
 */
export function formatKnowledgeForPrompt(
  snapshot: ClinicInfoSnapshot,
  entries: KnowledgeEntryItem[],
  mode?: KnowledgePromptMode,
  clinicLines: string[] = [],
  options: { informs?: boolean } = {},
): string {
  const lines = [`Clínica: ${snapshot.clinicName}.`]
  if (snapshot.branches.length) {
    lines.push("Sedes:")
    for (const b of snapshot.branches) {
      const parts = [`- ${b.name} (id ${b.id})`, b.address ? `dir. ${b.address}` : null, b.phone ? `tel. ${b.phone}` : null, b.mapsUrl ? `mapa: ${b.mapsUrl}` : null]
        .filter(Boolean)
        .join(" · ")
      lines.push(parts)
    }
  }
  lines.push(
    snapshot.emergencyPhone
      ? `Teléfono para urgencias de la clínica (también fuera de horario): ${snapshot.emergencyPhone}.`
      : "La clínica no registró un teléfono para urgencias: ante una urgencia, que acuda al servicio de emergencias más cercano.",
  )
  lines.push(...clinicLines)
  // Los medios activos de caja, en una línea: viajan en cada turno para que
  // «¿aceptan …?» se responda con el dato del sistema y no con un texto escrito.
  // Con «Informar» apagado no se informa de pagos (ADR 0021): nada que decir.
  if (options.informs === false) {
    // Sin medios ni la frase de que no se registraron: no se habla de pagos.
  } else if (snapshot.paymentMethods.length) {
    lines.push(
      `Medios de pago que acepta la clínica (lista completa; ningún otro): ${snapshot.paymentMethods.map((m) => m.name).join(", ")}.`,
    )
    if (snapshot.refusedPaymentMethods.length) {
      lines.push(`La clínica NO acepta: ${snapshot.refusedPaymentMethods.join(", ")}.`)
    }
    lines.push("Si preguntan por un medio que no está en esa lista, di que no figura entre los que acepta la clínica.")
  } else {
    // Sin medios registrados no se afirma ninguno: ni los habituales ni los que pregunten.
    lines.push("La clínica no registró sus medios de pago: no digas cuáles acepta; ofrece confirmarlo con el equipo.")
  }
  const active = entries.filter((entry) => entry.state === "vigente")
  if (active.length) {
    const effective = mode ?? (knowledgeFitsPrompt(active) ? "completo" : "indice")
    if (effective === "completo") {
      lines.push(
        "Respuestas oficiales (cítalas tal cual; si una aparece recortada, pide su texto completo a consultar_conocimiento con su título exacto antes de citarla):",
      )
      for (const entry of active) lines.push(formatKnowledgeEntry(entry))
    } else {
      lines.push(
        `Índice de las ${active.length} respuestas oficiales (solo título y arranque; antes de responder sobre uno de estos temas pide su texto a consultar_conocimiento con el título exacto y cítalo tal cual):`,
      )
      for (const entry of active) lines.push(formatKnowledgeIndexLine(entry))
    }
  }
  return lines.join("\n")
}

/** Todo lo publicado y vigente, para el prompt. */
export async function listPublishedForPrompt(tx: Db, orgId: string): Promise<KnowledgeEntryItem[]> {
  return listActiveKnowledge(tx, orgId)
}

/* ---------- Lo básico de una clínica ---------- */

export interface KnowledgeBasicItem {
  key: string
  question: string
  covered: boolean
  /** `respuesta`: hay una respuesta oficial vigente; `datos`: lo cubre lo que ya está en el sistema. */
  coveredBy: "respuesta" | "datos" | null
  entryId: string | null
  /** De qué datos sale cuando no hace falta escribir nada. */
  dataSource: string | null
}

export interface KnowledgeBasics {
  items: KnowledgeBasicItem[]
  covered: number
  total: number
}

/** Qué preguntas básicas ya puede responder el agente y cuáles faltan. */
export async function getKnowledgeBasics(tx: Db, orgId: string): Promise<KnowledgeBasics> {
  const active = await listActiveKnowledge(tx, orgId)
  const snapshot = await getClinicInfoSnapshot(tx, orgId)
  const sources = await getKnowledgeDataSources(tx, orgId)
  const fromData: Record<string, boolean> = {
    ubicacion: snapshot.branches.some((b) => Boolean(b.address?.trim())),
    telefono: snapshot.branches.some((b) => Boolean(b.phone?.trim())),
    servicios: sources.services > 0,
    // Solo cuentan los precios que el agente puede decir: con todo «Solo con evaluación» no da ninguno.
    precios: sources.pricedServices > 0,
    medios_pago: snapshot.paymentMethods.length > 0,
  }
  const items = KNOWLEDGE_BASICS.map((basic): KnowledgeBasicItem => {
    const entry = active.find((item) => item.basicKey === basic.key)
    const data = fromData[basic.key] === true
    return {
      key: basic.key,
      question: basic.question,
      covered: Boolean(entry) || data,
      coveredBy: entry ? "respuesta" : data ? "datos" : null,
      entryId: entry?.id ?? null,
      dataSource: basic.auto ?? null,
    }
  })
  return { items, covered: items.filter((item) => item.covered).length, total: items.length }
}

/* ---------- Lo que el agente no supo responder ---------- */

const GAP_QUESTION_CHARS = 500
const GAP_DEDUPE_MS = 24 * 60 * 60 * 1000
const GAP_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f-]{36}$/i

/**
 * Deja constancia de una búsqueda sin resultado. La misma pregunta en el mismo
 * hilo no se repite durante un día: una ráfaga no llena la lista.
 */
export async function recordKnowledgeGap(
  tx: Db,
  orgId: string,
  input: { conversationId: string; triggerMessageId?: string | null; question: string; query: string; agent?: string },
): Promise<string | null> {
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, GAP_QUESTION_CHARS)
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, 300)
  if (!question || !query) return null
  const recent = await tx
    .select({ question: agentKnowledgeGap.question })
    .from(agentKnowledgeGap)
    .where(
      and(
        eq(agentKnowledgeGap.organizationId, orgId),
        eq(agentKnowledgeGap.conversationId, input.conversationId),
        gt(agentKnowledgeGap.createdAt, new Date(Date.now() - GAP_DEDUPE_MS)),
      ),
    )
    .limit(50)
  const key = normalizeForSearch(question)
  if (recent.some((row) => normalizeForSearch(row.question) === key)) return null
  const [row] = await tx
    .insert(agentKnowledgeGap)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId && UUID.test(input.triggerMessageId) ? input.triggerMessageId : null,
      agent: input.agent ?? "recepcion",
      question,
      query,
    })
    .returning({ id: agentKnowledgeGap.id })
  return row?.id ?? null
}

export interface KnowledgeGapItem {
  /** Todas las veces que se hizo la misma pregunta, la más reciente primero. */
  ids: string[]
  question: string
  count: number
  /** De esas veces, cuántas en los últimos siete días. */
  weekCount: number
  lastAt: string
  conversationId: string
  status: KnowledgeGapStatus
  /** Lo primero que respondió una persona del equipo en ese hilo después; nulo si nadie respondió. */
  teamAnswer: string | null
}

/**
 * Preguntas sin respuesta agrupadas por texto (la misma pregunta de varias
 * personas cuenta una vez con su total), con lo que respondió el equipo.
 */
export async function listKnowledgeGaps(
  tx: Db,
  orgId: string,
  input: { status?: string; limit?: number } = {},
): Promise<KnowledgeGapItem[]> {
  const status = input.status ?? "abierta"
  if (!(KNOWLEDGE_GAP_STATUSES as readonly string[]).includes(status)) throw validation("status inválido")
  const rows = await tx
    .select({
      id: agentKnowledgeGap.id,
      question: agentKnowledgeGap.question,
      conversationId: agentKnowledgeGap.conversationId,
      createdAt: agentKnowledgeGap.createdAt,
      // Columnas de la consulta exterior escritas con su tabla: sin ella, dentro
      // de la subconsulta se resolverían contra el propio mensaje.
      teamAnswer: sql<string | null>`(
        select m.body from ${message} m
        where m.organization_id = ${orgId}
          and m.conversation_id = "agent_knowledge_gap"."conversation_id"
          and m.direction = 'out' and m.sender_kind = 'user' and m.body is not null
          and m.created_at > "agent_knowledge_gap"."created_at"
        order by m.created_at asc limit 1)`,
    })
    .from(agentKnowledgeGap)
    .where(and(eq(agentKnowledgeGap.organizationId, orgId), eq(agentKnowledgeGap.status, status)))
    .orderBy(desc(agentKnowledgeGap.createdAt), asc(agentKnowledgeGap.id))
    .limit(300)
  const groups = new Map<string, KnowledgeGapItem>()
  const weekStart = Date.now() - GAP_WEEK_MS
  for (const row of rows) {
    const key = normalizeForSearch(row.question)
    const group = groups.get(key)
    const thisWeek = row.createdAt.getTime() > weekStart ? 1 : 0
    if (group) {
      group.ids.push(row.id)
      group.count += 1
      group.weekCount += thisWeek
      group.teamAnswer ??= row.teamAnswer
      continue
    }
    groups.set(key, {
      ids: [row.id],
      question: row.question,
      count: 1,
      weekCount: thisWeek,
      lastAt: row.createdAt.toISOString(),
      conversationId: row.conversationId,
      status: status as KnowledgeGapStatus,
      teamAnswer: row.teamAnswer,
    })
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  return [...groups.values()].slice(0, limit)
}

export async function countOpenKnowledgeGaps(tx: Db, orgId: string): Promise<number> {
  return (await listKnowledgeGaps(tx, orgId, { status: "abierta", limit: 100 })).length
}

async function closeGaps(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  ids: string[],
  patch: { status: KnowledgeGapStatus; resolvedEntryId: string | null },
): Promise<string[]> {
  if (!ids.length) throw validation("Indica qué pregunta sin respuesta cierras")
  if (ids.some((id) => !UUID.test(id))) throw validation("Identificador de pregunta inválido")
  const closed = await tx
    .update(agentKnowledgeGap)
    .set({ ...patch, resolvedBy: actorUserId, resolvedAt: new Date() })
    .where(
      and(
        eq(agentKnowledgeGap.organizationId, orgId),
        inArray(agentKnowledgeGap.id, ids),
        eq(agentKnowledgeGap.status, "abierta"),
      ),
    )
    .returning({ question: agentKnowledgeGap.question })
  if (!closed.length) throw notFound("Pregunta sin respuesta")
  return closed.map((row) => row.question)
}

/**
 * Cierra preguntas sin respuesta con una respuesta oficial: una nueva (queda
 * publicada) o una que ya existía. En ambos casos la pregunta se suma a las
 * formas de preguntar de esa respuesta: la próxima vez el agente la encuentra.
 */
export async function answerKnowledgeGaps(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  ids: string[],
  input: { entryId: string } | { title: string; body: string; basicKey?: string | null },
): Promise<KnowledgeEntryItem> {
  let entryId: string
  if ("entryId" in input) {
    entryId = (await requireEntry(tx, orgId, input.entryId)).id
  } else {
    const created = await createKnowledgeEntry(tx, orgId, actorUserId, {
      kind: "faq",
      title: input.title,
      body: input.body,
      basicKey: input.basicKey ?? null,
    })
    await setKnowledgeStatus(tx, orgId, actorUserId, created.id, "publicada")
    entryId = created.id
  }
  const questions = await closeGaps(tx, orgId, actorUserId, ids, { status: "resuelta", resolvedEntryId: entryId })
  const current = await requireEntry(tx, orgId, entryId)
  const merged = [...current.askForms]
  const seen = new Set([normalizeForSearch(current.title), ...merged.map(normalizeForSearch)])
  for (const question of questions) {
    const form = question.slice(0, ASK_FORM_CHARS)
    const key = normalizeForSearch(form)
    if (!key || seen.has(key) || merged.length >= ASK_FORM_LIMIT) continue
    seen.add(key)
    merged.push(form)
  }
  if (merged.length !== current.askForms.length) {
    await tx
      .update(agentKnowledgeEntry)
      .set({ askForms: merged, updatedAt: new Date() })
      .where(eq(agentKnowledgeEntry.id, entryId))
  }
  await audit(tx, orgId, actorUserId, "agent.knowledge_gap_answered", entryId, { gaps: ids.length })
  return getKnowledgeEntry(tx, orgId, entryId)
}

/** Descarta preguntas que no corresponde responder (ruido, fuera de tema). */
export async function discardKnowledgeGaps(tx: Db, orgId: string, actorUserId: string | null, ids: string[]): Promise<void> {
  await closeGaps(tx, orgId, actorUserId, ids, { status: "descartada", resolvedEntryId: null })
}
