import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { agentPersonFact } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { channelConnection, conversation } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm"
import { requireContact } from "./contacts.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { normalizeForSearch } from "./knowledge.js"
import type { OrgLocale } from "./locale.js"
import { listPatientsByContact } from "./patients.js"

/* ---------- Memoria de la persona: lo que el agente recuerda entre conversaciones ---------- */

export const PERSON_FACT_CHARS = 200
/** Datos activos por persona: es una memoria corta, no una ficha. */
export const PERSON_FACT_LIMIT = 20
/** Citas recientes que deben coincidir para decir que suele atenderse en una sede. */
const USUAL_BRANCH_VISITS = 3

/**
 * Palabras que delatan información de salud. La memoria de la persona no la
 * guarda: su sitio es la historia clínica, que lleva el equipo con sus
 * permisos. Es un filtro por palabras, deliberadamente amplio: prefiere
 * rechazar un dato inocente a guardar uno clínico, y no sustituye el criterio
 * de quien revisa.
 */
const CLINICAL_STEMS = [
  "dolor", "duele", "sintoma", "diagnost", "caries", "infecc", "sangr", "inflam", "hinchaz", "absceso", "fiebre",
  "alergi", "medic", "pastilla", "antibiot", "receta", "embaraz", "diabet", "hipertens", "presion alta", "cardia",
  "cancer", "vih", "sida", "epilep", "asma", "anestes", "cirug", "operac", "extracc", "endodonc", "conducto",
  "periodont", "gingivit", "tratamiento", "enfermedad", "hepatit", "anticoagul", "depres", "ansiedad", "psiqui",
  "protesis", "implante", "fractur", "bruxis", "historia clinica", "radiograf",
]

/** ¿El texto parece información de salud? Ver `CLINICAL_STEMS`. */
export function looksClinical(text: string): boolean {
  const clean = ` ${normalizeForSearch(text)} `
  return CLINICAL_STEMS.some((stem) => clean.includes(` ${stem}`))
}

export interface PersonFact {
  id: string
  text: string
  source: "agente" | "equipo"
  channel: string | null
  createdByName: string | null
  createdAt: string
}

export interface PersonMemory {
  contactId: string
  /** Datos guardados: los únicos que se pueden corregir o quitar aquí. */
  facts: PersonFact[]
  /** Lo que sale de datos que ya están en el sistema; se cambia en su fuente. */
  derived: Array<{ label: string; text: string; origin: string }>
}

function cleanFact(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw validation("Escribe el dato")
  const text = value.replace(/[ \t\r\n]+/g, " ").trim()
  if (text.length > PERSON_FACT_CHARS) throw validation(`El dato admite hasta ${PERSON_FACT_CHARS} caracteres`)
  if (looksClinical(text)) {
    throw new ServiceError(
      "PERSON_FACT_CLINICAL",
      400,
      "Eso parece información de salud: no se guarda en la memoria del agente. Su lugar es la historia clínica.",
    )
  }
  return text
}

export async function listPersonFacts(tx: Db, orgId: string, contactId: string): Promise<PersonFact[]> {
  const rows = await tx
    .select({ fact: agentPersonFact, createdByName: user.name })
    .from(agentPersonFact)
    .leftJoin(user, eq(user.id, agentPersonFact.createdBy))
    .where(
      and(
        eq(agentPersonFact.organizationId, orgId),
        eq(agentPersonFact.contactId, contactId),
        eq(agentPersonFact.status, "activo"),
      ),
    )
    .orderBy(asc(agentPersonFact.createdAt))
    .limit(PERSON_FACT_LIMIT)
  return rows.map(({ fact, createdByName }) => ({
    id: fact.id,
    text: fact.text,
    source: fact.source as PersonFact["source"],
    channel: fact.channel,
    createdByName,
    createdAt: fact.createdAt.toISOString(),
  }))
}

export interface AddPersonFactInput {
  contactId: string
  text: unknown
  /** Dato activo al que sustituye; queda en la historia como reemplazado. */
  replacesId?: string | null
  /** Conversación donde se dijo, cuando lo registra el agente. */
  conversationId?: string | null
}

/**
 * Guarda un dato sobre una persona. Lo registra el agente al oírlo o alguien
 * del equipo; en los dos casos pasa el mismo filtro: nada clínico. Repetir un
 * dato que ya está no lo duplica.
 */
export async function addPersonFact(
  tx: Db,
  orgId: string,
  actor: { userId: string | null; source: "agente" | "equipo" },
  input: AddPersonFactInput,
): Promise<PersonFact> {
  await requireContact(tx, orgId, input.contactId)
  const text = cleanFact(input.text)
  const active = await tx
    .select()
    .from(agentPersonFact)
    .where(
      and(
        eq(agentPersonFact.organizationId, orgId),
        eq(agentPersonFact.contactId, input.contactId),
        eq(agentPersonFact.status, "activo"),
      ),
    )
    .for("update")
  const replaced = input.replacesId ? active.find((row) => row.id === input.replacesId) : undefined
  if (input.replacesId && !replaced) throw notFound("Dato a reemplazar")
  const same = active.find((row) => row.id !== replaced?.id && normalizeForSearch(row.text) === normalizeForSearch(text))
  if (same) {
    const [existing] = (await listPersonFacts(tx, orgId, input.contactId)).filter((fact) => fact.id === same.id)
    if (existing) return existing
  }
  if (!replaced && active.length >= PERSON_FACT_LIMIT) {
    throw new ServiceError("PERSON_FACT_LIMIT", 409, `La memoria guarda hasta ${PERSON_FACT_LIMIT} datos por persona; quita o reemplaza uno`)
  }
  let channel: string | null = null
  if (input.conversationId) {
    const [thread] = await tx
      .select({ channel: channelConnection.channel })
      .from(conversation)
      .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.id, input.conversationId),
          eq(conversation.contactId, input.contactId),
        ),
      )
      .limit(1)
    if (!thread) throw notFound("Conversación de la persona")
    channel = thread.channel
  }
  const [row] = await tx
    .insert(agentPersonFact)
    .values({
      organizationId: orgId,
      contactId: input.contactId,
      text,
      source: actor.source,
      conversationId: input.conversationId ?? null,
      channel,
      createdBy: actor.userId,
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar el dato")
  if (replaced) {
    await tx
      .update(agentPersonFact)
      .set({ status: "reemplazado", replacedById: row.id })
      .where(eq(agentPersonFact.id, replaced.id))
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor.userId,
    action: "agent.person_fact_added",
    entity: "agent_person_fact",
    entityId: row.id,
    // La auditoría no repite el dato: basta con saber quién, cuándo y de quién.
    metadata: { contactId: input.contactId, source: actor.source, replaced: replaced?.id ?? null },
  })
  const [fact] = (await listPersonFacts(tx, orgId, input.contactId)).filter((item) => item.id === row.id)
  if (!fact) throw new Error("No se pudo leer el dato guardado")
  return fact
}

/** Quitar un dato: el agente deja de usarlo al instante; la fila queda como historia. */
export async function removePersonFact(tx: Db, orgId: string, actorUserId: string, contactId: string, factId: string): Promise<void> {
  const [row] = await tx
    .update(agentPersonFact)
    .set({ status: "quitado", removedBy: actorUserId, removedAt: new Date() })
    .where(
      and(
        eq(agentPersonFact.organizationId, orgId),
        eq(agentPersonFact.contactId, contactId),
        eq(agentPersonFact.id, factId),
        eq(agentPersonFact.status, "activo"),
      ),
    )
    .returning({ id: agentPersonFact.id })
  if (!row) throw notFound("Dato de la persona")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.person_fact_removed",
    entity: "agent_person_fact",
    entityId: factId,
    metadata: { contactId },
  })
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  madre: "su hijo o hija",
  padre: "su hijo o hija",
  tutor: "la persona a su cargo",
  conyuge: "su pareja",
  hijo: "su madre o padre",
  hija: "su madre o padre",
}

/** Lo que el agente recuerda de una persona: sus datos guardados y lo que sale de vínculos y citas. */
export async function getPersonMemory(tx: Db, orgId: string, contactId: string): Promise<PersonMemory> {
  await requireContact(tx, orgId, contactId)
  const facts = await listPersonFacts(tx, orgId, contactId)
  const derived: PersonMemory["derived"] = []
  const links = await listPatientsByContact(tx, orgId, contactId)
  for (const link of links) {
    if (link.relationship === "self" || !link.isActive) continue
    const whom = RELATIONSHIP_LABEL[link.relationship]
    derived.push({
      label: "Por quién escribe",
      text: `También escribe por ${link.displayName}${whom ? `, ${whom}` : ""}`,
      origin: "Vínculo registrado por tu equipo",
    })
  }
  const own = links.find((link) => link.relationship === "self")
  if (own) {
    const visits = await tx
      .select({ branchId: appointment.branchId, branchName: branch.name })
      .from(appointment)
      .innerJoin(branch, eq(branch.id, appointment.branchId))
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, own.id),
          ne(appointment.status, "cancelada"),
        ),
      )
      .orderBy(desc(appointment.startsAt))
      .limit(USUAL_BRANCH_VISITS)
    const [first] = visits
    if (first && visits.length === USUAL_BRANCH_VISITS && visits.every((visit) => visit.branchId === first.branchId)) {
      derived.push({
        label: "Sede",
        text: `Suele atenderse en la sede ${first.branchName}`,
        origin: `Por sus ${USUAL_BRANCH_VISITS} últimas citas`,
      })
    }
  }
  return { contactId, facts, derived }
}

const CHANNEL_NAME: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  email: "correo",
  gmail: "correo",
  microsoft365: "correo",
  webchat: "el chat web",
  web_chat: "el chat web",
}

const SOURCE_PHRASE = (fact: PersonFact, zone: OrgLocale): string => {
  const day = new Date(fact.createdAt).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
  if (fact.source === "equipo") return `lo anotó el equipo el ${day}`
  return `lo dijo${fact.channel ? ` por ${CHANNEL_NAME[fact.channel] ?? fact.channel}` : ""} el ${day}`
}

/**
 * La memoria de la persona, tal como la lee el agente. Son preferencias y
 * datos prácticos, no instrucciones: si la persona dice otra cosa hoy, manda
 * lo de hoy.
 */
export function formatPersonMemoryForPrompt(memory: PersonMemory, zone: OrgLocale): string | null {
  const lines = [
    ...memory.facts.map((fact) => `- ${fact.text} (id ${fact.id}; ${SOURCE_PHRASE(fact, zone)})`),
    ...memory.derived.map((item) => `- ${item.text} (${item.origin.toLowerCase()})`),
  ]
  if (lines.length === 0) return null
  return [
    "Lo que recuerdas de esta persona de conversaciones anteriores (datos prácticos, no clínicos; si hoy dice otra cosa, vale lo de hoy y reemplazas el dato con recordar_dato):",
    ...lines,
  ].join("\n")
}

/** Datos guardados de varias personas a la vez, para listados. */
export async function countPersonFacts(tx: Db, orgId: string, contactIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(contactIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select({ contactId: agentPersonFact.contactId })
    .from(agentPersonFact)
    .where(
      and(
        eq(agentPersonFact.organizationId, orgId),
        eq(agentPersonFact.status, "activo"),
        inArray(agentPersonFact.contactId, ids),
      ),
    )
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.contactId, (totals.get(row.contactId) ?? 0) + 1)
  return totals
}
