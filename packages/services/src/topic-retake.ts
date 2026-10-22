import type { Db } from "@odentia/db"
import { crmTask } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { resumeConversationBySystem } from "./clinic-messages.js"
import { canWriteNow, type ClinicVoice, type ConversationCareDeps, clinicVoiceOf, greetingName } from "./conversation-close.js"
import { sendOutbound } from "./conversations.js"
import { ServiceError } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgLocale } from "./locale.js"
import { updateTask } from "./tasks.js"
import type { TopicKind } from "./topic-urgency.js"
import { createWorkspaceNotification } from "./workspace.js"
import { isWritingTime, writingScheduleOf } from "./writing-hours.js"

/** «A la hora de apertura»: la primera hora del «Horario para escribir» de ese día. */
const OPENING_MS = 60 * 60_000
/** Por ciclo, para no escribirle a muchas personas de golpe; lo demás, en el siguiente. */
const RETAKE_LIMIT = 20
const SETTLED = "Lo retomó Sofi: el equipo no alcanzó a responder"

type ForgottenTopic = {
  id: string
  task_id: string | null
  assignee_user_id: string | null
  reason: string
  kind: TopicKind
  created_at: Date | string
  conversation_id: string
  contact_id: string
  display_name: string
  last_inbound_at: Date | string | null
  provider: string
  channel: string
  connection_status: string
  quote: string | null
}

/**
 * «Sofi se ofrece» (decisión 5 del pulido de la Bandeja): un tema de cita o de
 * precio de lista que quedó sin respuesta desde un día anterior lo retoma Sofi
 * a la hora de apertura, con un texto fijo en la voz de la clínica que le
 * ofrece seguir por aquí; lo que la persona responda lo atiende Sofi. Si la
 * ventana de 24 horas se cerró, sale «Retomar la conversación»; si no se puede
 * escribir, el tema sigue esperando al equipo. El tema queda resuelto («Lo
 * retomó Sofi») y quien lo tenía recibe el aviso. Nunca una duda clínica, un
 * pago ni otra cosa: un precio solo si Sofi puede decir precios («Informar»
 * encendido) y una cita solo si agenda. Tampoco si alguien del equipo ya le
 * escribió después del tema: ese tema tiene quien lo siga.
 */
export async function retakeForgottenTopics(
  tx: Db,
  orgId: string,
  now: Date,
  deps: ConversationCareDeps & { secretsKey: Buffer },
): Promise<number> {
  const cfg = await getAgentConfig(tx, orgId)
  if (!cfg.enabled) return 0
  const kinds: TopicKind[] = []
  if (!cfg.disabledFunctions.includes("agendar")) kinds.push("cita")
  if (!cfg.disabledFunctions.includes("informar")) kinds.push("precio")
  if (kinds.length === 0) return 0
  const schedule = await writingScheduleOf(tx, orgId)
  if (!isWritingTime(now, schedule) || isWritingTime(new Date(now.getTime() - OPENING_MS), schedule)) return 0
  const zone = await findOrgLocale(tx, orgId)
  const rows = await tx.execute<ForgottenTopic>(sql`
    select h.id, h.task_id, h.assignee_user_id, h.reason, h.kind, h.created_at, h.conversation_id,
      c.id as contact_id, c.display_name, conv.last_inbound_at, conn.provider, conn.channel, conn.status as connection_status,
      (select m.body from message m where m.id = h.source_message_id and m.organization_id = h.organization_id) as quote
    from agent_handoff h
    join conversation conv on conv.id = h.conversation_id and conv.organization_id = h.organization_id
    join contact c on c.id = conv.contact_id
    join channel_connection conn on conn.id = conv.channel_connection_id
    where h.organization_id = ${orgId}
      and ${handoffOpenSql(sql.raw("h"))}
      and h.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
      and (h.created_at at time zone ${zone.timezone})::date < (${now.toISOString()}::timestamptz at time zone ${zone.timezone})::date
      and conv.status = 'open' and conv.agent_status = 'on' and c.screen is null
      -- El chat web no tiene a nadie mirando al día siguiente: la respuesta va por donde dejó (forwardWebchatReply), no aquí.
      and conn.provider <> 'web_chat' and not conv.is_test
      ${cfg.channels !== null ? sql`and conn.channel in (${sql.join([...cfg.channels, ""].map((channel) => sql`${channel}`), sql`, `)})` : sql``}
      -- Instagram y Messenger cerrados no admiten «Retomar»: no ocupan lugar en la fila.
      and not (conn.provider in ('instagram', 'messenger') and (conv.last_inbound_at is null or conv.last_inbound_at < ${now.toISOString()}::timestamptz - interval '24 hours'))
      -- Uno que no pudo salir hoy no se vuelve a intentar hasta mañana.
      and not exists (select 1 from audit_event a where a.organization_id = h.organization_id and a.entity_id = h.id::text
        and a.action = 'agent.handoff_retake_skipped' and a.created_at > ${now.toISOString()}::timestamptz - interval '20 hours')
      and not exists (select 1 from message m where m.organization_id = h.organization_id and m.conversation_id = h.conversation_id
        and m.direction = 'out' and m.sender_kind = 'user' and m.created_at > h.created_at)
    order by h.created_at
    limit ${RETAKE_LIMIT}`)
  const voice = clinicVoiceOf(cfg)
  const name = cfg.personaName
  let retaken = 0
  for (const row of rows) {
    // Cada tema en su punto de guardado: uno que no puede salir no frena a los demás.
    const done = await tx
      .transaction(async (inner) => {
        const thread = {
          provider: row.provider,
          connectionStatus: row.connection_status,
          lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at) : null,
        }
        if (canWriteNow(thread, now)) {
          const text = retakeText(voice, greetingName(row.display_name), {
            day: dayWords(new Date(row.created_at), now, zone),
            quote: shortQuote(row.quote),
            kind: row.kind,
            canBook: kinds.includes("cita"),
          })
          await sendOutbound(inner, orgId, {
            conversationId: row.conversation_id,
            senderKind: "agent",
            content: { type: "text", text: deps.format ? deps.format(text, row.channel, { emojis: cfg.emojis }) : text },
          })
        } else {
          // Pasadas las 24 horas: «Retomar la conversación», con la misma regla de la Bandeja.
          const resumed = await resumeConversationBySystem(inner, orgId, deps.secretsKey, row.conversation_id, now)
          if (!resumed.sent) return false
        }
        if (row.task_id) {
          await updateTask(inner, orgId, row.task_id, { status: "done" })
          await inner
            .update(crmTask)
            .set({ settledReason: SETTLED.replace("Sofi", name) })
            .where(and(eq(crmTask.id, row.task_id), eq(crmTask.organizationId, orgId)))
        }
        await inner.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: null,
          action: "agent.handoff_retaken",
          entity: "agent_handoff",
          entityId: row.id,
          metadata: { origin: "agent", kind: row.kind, conversationId: row.conversation_id, from: row.assignee_user_id },
        })
        if (row.assignee_user_id) {
          await createWorkspaceNotification(inner, orgId, {
            userId: row.assignee_user_id,
            dedupeKey: `tema:${row.id}:retomado`,
            title: `${name} retomó el tema de ${row.display_name}`,
            body: row.reason,
            href: `/inbox?conversation=${row.conversation_id}`,
            permission: "conversations.read",
            actorUserId: null,
          })
        }
        return true
      })
      .catch((error: unknown) => {
        if (error instanceof ServiceError) return false
        throw error
      })
    if (done) retaken++
    else {
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: null,
        action: "agent.handoff_retake_skipped",
        entity: "agent_handoff",
        entityId: row.id,
        metadata: { origin: "agent", conversationId: row.conversation_id },
      })
    }
  }
  return retaken
}

/**
 * Lo que dice Sofi al retomar, fijo y en la voz de la clínica: cuándo quedó
 * pendiente, su pregunta con sus palabras y qué le ofrece. No responde la
 * pregunta: eso lo hace Sofi con lo que sabe cuando la persona contesta.
 */
export function retakeText(
  voice: ClinicVoice,
  name: string | null,
  input: { day: string; quote: string | null; kind: TopicKind; canBook?: boolean },
): string {
  const usted = voice.treatment === "usted"
  const hello = name ? `Hola, ${name}.` : "Hola."
  const pending = `${input.day.charAt(0).toUpperCase()}${input.day.slice(1)} quedó pendiente ${usted ? "su" : "tu"} consulta${input.quote ? `: «${input.quote}»` : ""}.`
  const offer =
    input.kind === "cita"
      ? usted
        ? "¿Le ayudo a reservar su cita? Dígame qué día le queda mejor."
        : "¿Te ayudo a reservar tu cita? Dime qué día te queda mejor."
      : input.canBook === false
        ? usted
          ? "¿Le ayudo con eso ahora?"
          : "¿Te ayudo con eso ahora?"
        : usted
          ? "¿Le ayudo con eso ahora? Si desea, también le reservo una evaluación."
          : "¿Te ayudo con eso ahora? Si quieres, también te reservo una evaluación."
  return `${hello} ${pending} ${offer}`
}

/** «ayer», «el sábado» (esta semana) o «el 3 de octubre», en la zona de la clínica. */
function dayWords(date: Date, now: Date, zone: { timezone: string; locale: string }): string {
  const key = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value)
  if (key(date) === key(new Date(now.getTime() - 24 * 3_600_000))) return "ayer"
  if (now.getTime() - date.getTime() < 6 * 24 * 3_600_000) {
    return `el ${new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, weekday: "long" }).format(date)}`
  }
  return `el ${new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" }).format(date)}`
}

/** Su pregunta en una línea, recortada; nula si no hay texto. */
function shortQuote(body: string | null): string | null {
  const line = (body ?? "").replace(/\s+/g, " ").trim()
  if (!line) return null
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}
