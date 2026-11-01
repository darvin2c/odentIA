import type { Db } from "@odentia/db"
import { appointment, OCCUPYING_STATUSES } from "@odentia/db/schema/agenda"
import { agentHandoff, agentPersonFact } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { channelConnection, conversation } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, or } from "drizzle-orm"
import { requireContact } from "./contacts.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { normalizeForSearch } from "./knowledge.js"
import { getOrgLocale, type OrgLocale } from "./locale.js"
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

/**
 * La última vez que se supo de la persona, con lo que el sistema ya guarda y
 * sin modelo: cuándo escribió, su cita y si su caso pasó a alguien del equipo.
 * Nada clínico: de la cita solo cuándo, dónde y con quién, nunca el servicio
 * ni el motivo.
 */
export interface PersonLastTime {
  /** Zona y formato de la organización, para escribir las fechas. */
  timezone: string
  locale: string
  /** Su último mensaje, en cualquiera de sus conversaciones. */
  wrote: { at: string; channel: string } | null
  /** Su próxima cita en pie o, si no tiene, la última que ya pasó. Nulo también si quien lee no ve la agenda. */
  appointment: {
    startsAt: string
    status: string
    upcoming: boolean
    branchName: string
    professionalName: string | null
  } | null
  /** La última vez que su caso pasó a una persona. El motivo se omite si parece información de salud. */
  handoff: { at: string; reason: string | null } | null
}

export interface PersonMemory {
  contactId: string
  /** Datos guardados: los únicos que se pueden corregir o quitar aquí. */
  facts: PersonFact[]
  /** Lo que sale de datos que ya están en el sistema; se cambia en su fuente (`managedIn`). */
  derived: Array<{ label: string; text: string; origin: string; managedIn: "ficha" | "agenda" }>
  /** Solo cuando se pide (la pantalla); el agente no lo recibe por esta vía. */
  lastTime?: PersonLastTime
}

function cleanFact(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalidField("text", "Escribe el dato")
  const text = value.replace(/[ \t\r\n]+/g, " ").trim()
  if (text.length > PERSON_FACT_CHARS) throw invalidField("text", `El dato admite hasta ${PERSON_FACT_CHARS} caracteres`)
  if (looksClinical(text)) {
    const message = "Eso parece información de salud: no se guarda en la memoria del agente. Su lugar es la historia clínica."
    throw new ServiceError("PERSON_FACT_CLINICAL", 400, message, { text: message })
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
    const message = `La memoria guarda hasta ${PERSON_FACT_LIMIT} datos por persona; quita o reemplaza uno`
    throw new ServiceError("PERSON_FACT_LIMIT", 409, message, { text: message })
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

/** Ver `PersonLastTime`. `ownPatientId` es la ficha de la propia persona, si la tiene y quien lee ve la agenda. */
async function getPersonLastTime(tx: Db, orgId: string, contactId: string, ownPatientId: string | null): Promise<PersonLastTime> {
  const zone = await getOrgLocale(tx, orgId)
  const [thread] = await tx
    .select({ at: conversation.lastInboundAt, channel: channelConnection.channel })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, contactId), isNotNull(conversation.lastInboundAt)))
    .orderBy(desc(conversation.lastInboundAt))
    .limit(1)

  let visit: PersonLastTime["appointment"] = null
  if (ownPatientId) {
    const now = new Date()
    const fields = { startsAt: appointment.startsAt, status: appointment.status, branchName: branch.name, professionalName: user.name }
    const mine = and(eq(appointment.organizationId, orgId), eq(appointment.patientId, ownPatientId))
    const [next] = await tx
      .select(fields)
      .from(appointment)
      .innerJoin(branch, eq(branch.id, appointment.branchId))
      .leftJoin(user, eq(user.id, appointment.professionalUserId))
      .where(and(mine, inArray(appointment.status, [...OCCUPYING_STATUSES]), gte(appointment.startsAt, now)))
      .orderBy(asc(appointment.startsAt))
      .limit(1)
    const [row] = next
      ? [next]
      : await tx
          .select(fields)
          .from(appointment)
          .innerJoin(branch, eq(branch.id, appointment.branchId))
          .leftJoin(user, eq(user.id, appointment.professionalUserId))
          .where(and(mine, ne(appointment.status, "cancelada"), lt(appointment.startsAt, now)))
          .orderBy(desc(appointment.startsAt))
          .limit(1)
    if (row) {
      visit = {
        startsAt: row.startsAt.toISOString(),
        status: row.status,
        upcoming: next !== undefined,
        branchName: row.branchName,
        professionalName: row.professionalName,
      }
    }
  }

  const [passed] = await tx
    .select({ at: agentHandoff.createdAt, reason: agentHandoff.reason })
    .from(agentHandoff)
    .leftJoin(conversation, eq(conversation.id, agentHandoff.conversationId))
    .where(and(eq(agentHandoff.organizationId, orgId), or(eq(agentHandoff.contactId, contactId), eq(conversation.contactId, contactId))))
    .orderBy(desc(agentHandoff.createdAt))
    .limit(1)

  return {
    timezone: zone.timezone,
    locale: zone.locale,
    wrote: thread?.at ? { at: thread.at.toISOString(), channel: thread.channel } : null,
    appointment: visit,
    handoff: passed
      ? { at: passed.at.toISOString(), reason: passed.reason.trim() && !looksClinical(passed.reason) ? passed.reason.trim() : null }
      : null,
  }
}

/**
 * Lo que el agente recuerda de una persona: sus datos guardados y lo que sale
 * de vínculos y citas. La pantalla pide además «la última vez»
 * (`options.lastTime`), diciendo si quien lee ve la agenda.
 */
export async function getPersonMemory(
  tx: Db,
  orgId: string,
  contactId: string,
  options: { lastTime?: { appointments: boolean } } = {},
): Promise<PersonMemory> {
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
      managedIn: "ficha",
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
        text: `Suele atenderse en ${/^sede\b/i.test(first.branchName) ? first.branchName : `la sede ${first.branchName}`}`,
        origin: `Por sus ${USUAL_BRANCH_VISITS} últimas citas`,
        managedIn: "agenda",
      })
    }
  }
  if (!options.lastTime) return { contactId, facts, derived }
  const lastTime = await getPersonLastTime(tx, orgId, contactId, options.lastTime.appointments && own?.isActive ? own.id : null)
  return { contactId, facts, derived, lastTime }
}

/** Cómo se nombra cada canal en una frase: «por WhatsApp», «por correo». */
export const CHANNEL_NAME: Record<string, string> = {
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
