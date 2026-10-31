import type { Db } from "@odentia/db"
import { agentLesson, type LessonSource } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { contact, conversation } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"

/**
 * «Lo que el agente debe saber» (decisión 24 de la fase 4): una sola lista con
 * lo que escribe la clínica y las reglas que aprendió de sus correcciones y
 * alguien aprobó. Cada línea dice de dónde viene. Todas son reglas activas de
 * Recepción (`agent_lesson`, `kind = regla`): las escritas nacen activas; las
 * aprendidas pasan por «Aprender» y, al aprobarlas, se avisa si contradicen
 * otra. Al agente le llega una sola lista (`lessonsForTurn`), primero lo
 * escrito por la clínica. Todas se editan y se borran igual.
 */

const AGENT = "recepcion"
const BODY_CHARS = 2000
const TITLE_CHARS = 200
/** Líneas que muestra la lista: el agente recibe hasta `LESSON_RULE_LIMIT`. */
const LIST_LIMIT = 300

export interface GuidanceItem {
  id: string
  body: string
  source: LessonSource
  /** Escrita: quién la escribió. Aprendida: quién la aprobó. Nulo si no consta. */
  byName: string | null
  /** Cuándo se escribió o se aprobó. */
  at: string
  /** Aprendida: la conversación de la que salió y con quién. */
  conversationId: string | null
  contactName: string | null
}

export interface GuidanceList {
  items: GuidanceItem[]
  counts: { all: number; escrita: number; aprendida: number }
}

const activeRules = (orgId: string) =>
  and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), eq(agentLesson.kind, "regla"), eq(agentLesson.scope, AGENT))

function clean(value: unknown): string {
  if (typeof value !== "string") throw invalidField("body", "Escribe qué debe saber el agente")
  const text = value.trim().replace(/\s+/g, " ")
  if (!text) throw invalidField("body", "Escribe qué debe saber el agente")
  if (text.length > BODY_CHARS) throw invalidField("body", `Como mucho ${BODY_CHARS} caracteres`)
  return text
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, id: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "agent_lesson", entityId: id, metadata })
}

/** La lista, con el filtro «Todas · Escritas por la clínica · Aprendidas». */
export async function listAgentGuidance(tx: Db, orgId: string, input: { source?: string } = {}): Promise<GuidanceList> {
  if (input.source !== undefined && input.source !== "escrita" && input.source !== "aprendida") {
    throw validation("Filtro inválido (escrita|aprendida)")
  }
  const totals = await tx
    .select({ source: agentLesson.source, total: sql<number>`count(*)::int` })
    .from(agentLesson)
    .where(activeRules(orgId))
    .groupBy(agentLesson.source)
  const escrita = Number(totals.find((row) => row.source === "escrita")?.total ?? 0)
  const aprendida = Number(totals.find((row) => row.source === "aprendida")?.total ?? 0)
  const rows = await tx
    .select({
      id: agentLesson.id,
      body: agentLesson.body,
      source: agentLesson.source,
      proposedBy: agentLesson.proposedBy,
      approvedBy: agentLesson.approvedBy,
      approvedAt: agentLesson.approvedAt,
      createdAt: agentLesson.createdAt,
      conversationId: agentLesson.conversationId,
    })
    .from(agentLesson)
    .where(and(activeRules(orgId), input.source ? eq(agentLesson.source, input.source as LessonSource) : undefined))
    // Lo escrito por la clínica primero y en su orden; después lo aprendido, lo último arriba.
    .orderBy(
      sql`case ${agentLesson.source} when 'escrita' then 0 else 1 end`,
      sql`case ${agentLesson.source} when 'escrita' then ${agentLesson.createdAt} end asc`,
      desc(agentLesson.approvedAt),
      asc(agentLesson.id),
    )
    .limit(LIST_LIMIT)
  const people = [...new Set(rows.flatMap((row) => [row.source === "escrita" ? row.proposedBy : row.approvedBy]).filter((id): id is string => !!id))]
  const names = people.length
    ? new Map((await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, people))).map((row) => [row.id, row.name]))
    : new Map<string, string>()
  const threads = [...new Set(rows.map((row) => row.conversationId).filter((id): id is string => !!id))]
  const contacts = threads.length
    ? new Map(
        (
          await tx
            .select({ id: conversation.id, name: contact.displayName })
            .from(conversation)
            .leftJoin(contact, eq(contact.id, conversation.contactId))
            .where(and(eq(conversation.organizationId, orgId), inArray(conversation.id, threads)))
        ).map((row) => [row.id, row.name]),
      )
    : new Map<string, string | null>()
  return {
    items: rows.map((row) => ({
      id: row.id,
      body: row.body,
      source: row.source,
      byName: names.get(row.source === "escrita" ? row.proposedBy : (row.approvedBy ?? "")) ?? null,
      at: (row.source === "escrita" ? row.createdAt : (row.approvedAt ?? row.createdAt)).toISOString(),
      conversationId: row.conversationId,
      contactName: row.conversationId ? (contacts.get(row.conversationId) ?? null) : null,
    })),
    counts: { all: escrita + aprendida, escrita, aprendida },
  }
}

/** «Agregar»: lo que escribe la clínica vale desde que se guarda. */
export async function addAgentGuidance(tx: Db, orgId: string, actorUserId: string, body: unknown): Promise<GuidanceItem> {
  const text = clean(body)
  const now = new Date()
  const [row] = await tx
    .insert(agentLesson)
    .values({
      organizationId: orgId,
      kind: "regla",
      scope: AGENT,
      title: text.slice(0, TITLE_CHARS),
      body: text,
      status: "activa",
      source: "escrita",
      proposedBy: actorUserId,
      approvedBy: actorUserId,
      approvedAt: now,
    })
    .returning({ id: agentLesson.id })
  if (!row) throw new Error("No se pudo guardar")
  await audit(tx, orgId, actorUserId, "agent.guidance_added", row.id)
  return requireGuidance(tx, orgId, row.id)
}

/** «Editar»: igual para lo escrito y lo aprendido; queda auditado el texto anterior. */
export async function editAgentGuidance(tx: Db, orgId: string, actorUserId: string, id: string, body: unknown): Promise<GuidanceItem> {
  const text = clean(body)
  const current = await lockRule(tx, orgId, id)
  await tx
    .update(agentLesson)
    .set({ body: text, title: text.slice(0, TITLE_CHARS), updatedAt: new Date() })
    .where(and(eq(agentLesson.id, id), eq(agentLesson.organizationId, orgId)))
  await audit(tx, orgId, actorUserId, "agent.guidance_edited", id, { previous: current.body.slice(0, 500), source: current.source })
  return requireGuidance(tx, orgId, id)
}

/**
 * «Borrar»: deja de llegarle al agente al instante. No se pierde la historia:
 * una aprendida queda retirada (se puede restaurar desde «Aprender»), igual
 * que una escrita.
 */
export async function removeAgentGuidance(tx: Db, orgId: string, actorUserId: string, id: string): Promise<void> {
  const current = await lockRule(tx, orgId, id)
  const now = new Date()
  await tx
    .update(agentLesson)
    .set({ status: "retirada", withdrawnBy: actorUserId, withdrawnAt: now, updatedAt: now })
    .where(and(eq(agentLesson.id, id), eq(agentLesson.organizationId, orgId)))
  await audit(tx, orgId, actorUserId, "agent.guidance_removed", id, { source: current.source })
}

async function lockRule(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(agentLesson)
    .where(and(eq(agentLesson.id, id), activeRules(orgId)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Línea")
  return row
}

async function requireGuidance(tx: Db, orgId: string, id: string): Promise<GuidanceItem> {
  const { items } = await listAgentGuidance(tx, orgId)
  const item = items.find((row) => row.id === id)
  if (!item) throw notFound("Línea")
  return item
}

/* ---------- ¿Contradice otra? ---------- */

/**
 * Pregunta al modelo de decisión si dos reglas se contradicen. La arma el
 * agente (`packages/agent`) solo si la clínica tiene un modelo de decisión
 * configurado; sin él se usa `simpleRulesConflict`.
 */
export type RuleConflictModel = (candidate: string, existing: string) => Promise<boolean>

export interface RuleConflict {
  /** La regla activa con la que choca, o nula. */
  conflictWith: { id: string; body: string } | null
  /** Cómo se detectó: con el modelo de decisión o con la comparación simple. */
  method: "modelo" | "comparacion"
}

const STOP = new Set([
  "para", "pero", "como", "cuando", "donde", "desde", "hasta", "entre", "sobre", "solo", "siempre", "todos", "todas",
  "esta", "este", "estos", "estas", "tiene", "tienen", "puede", "pueden", "debe", "deben", "nunca", "jamas", "dile",
  "decir", "ofrece", "ofrezcas", "ofrecer", "atiende", "atender", "persona", "paciente", "pacientes", "cita", "citas",
  "clinica", "agente", "porque", "tambien", "menos", "mas", "algun", "alguna", "ningun", "ninguna", "otra", "otro",
])
const NEGATION = /(^| )(no|nunca|jamas|ni|evita|evites|prohibido|sin)( |$)/

function normal(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Palabras de tema: largas, sin las de relleno y sin el plural. */
function topics(text: string): Set<string> {
  return new Set(
    normal(text)
      .split(" ")
      .filter((word) => word.length >= 4 && !STOP.has(word))
      .map((word) => word.replace(/(es|s)$/, "")),
  )
}

/** ¿Hablan de lo mismo? Comparten al menos una palabra de tema. */
export function shareTopic(a: string, b: string): boolean {
  const left = topics(a)
  for (const word of topics(b)) if (left.has(word)) return true
  return false
}

/**
 * La comparación simple, sin modelo: dos reglas chocan si hablan de lo mismo
 * (comparten una palabra de tema) y una lo prohíbe y la otra no. Es una
 * aproximación: no entiende sinónimos ni excepciones.
 * «No ofrezcas citas los sábados» y «Los sábados atiende la Dra. Ana» chocan.
 */
export function simpleRulesConflict(candidate: string, existing: string): boolean {
  if (!shareTopic(candidate, existing)) return false
  return NEGATION.test(normal(candidate)) !== NEGATION.test(normal(existing))
}

/** Como mucho estas preguntas al modelo por aprobación: solo las reglas que hablan de lo mismo. */
const MODEL_CHECKS = 5

/**
 * ¿La regla que se va a aprobar contradice otra activa? Con el modelo de
 * decisión de la clínica si está configurado; si no (o si falla), con la
 * comparación simple. Solo mira las que hablan de lo mismo.
 */
export async function findRuleConflict(
  tx: Db,
  orgId: string,
  lessonId: string,
  model: RuleConflictModel | null = null,
): Promise<RuleConflict> {
  const [lesson] = await tx
    .select({ body: agentLesson.body, kind: agentLesson.kind, status: agentLesson.status })
    .from(agentLesson)
    .where(and(eq(agentLesson.id, lessonId), eq(agentLesson.organizationId, orgId)))
    .limit(1)
  if (!lesson) throw notFound("Lección")
  if (lesson.kind !== "regla") return { conflictWith: null, method: model ? "modelo" : "comparacion" }
  if (lesson.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, `La lección ya está ${lesson.status}`)
  const others = await tx
    .select({ id: agentLesson.id, body: agentLesson.body })
    .from(agentLesson)
    .where(and(activeRules(orgId), ne(agentLesson.id, lessonId)))
    .orderBy(desc(agentLesson.approvedAt))
  const related = others.filter((other) => shareTopic(lesson.body, other.body))
  if (model) {
    try {
      for (const other of related.slice(0, MODEL_CHECKS)) {
        if (await model(lesson.body, other.body)) return { conflictWith: other, method: "modelo" }
      }
      return { conflictWith: null, method: "modelo" }
    } catch {
      // Sin respuesta del modelo, la comparación simple.
    }
  }
  const found = related.find((other) => simpleRulesConflict(lesson.body, other.body)) ?? null
  return { conflictWith: found, method: "comparacion" }
}
