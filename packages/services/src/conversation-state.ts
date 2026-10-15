import { type SQL, sql } from "drizzle-orm"
import { handoffOpenSql } from "./handoff-state.js"
import { proposalPendingSql } from "./proposal-state.js"

/**
 * Qué espera cada conversación, dicho una sola vez (ADR 0024). Lo usan la
 * lista y los totales de la Bandeja, el detalle del hilo, el panel de
 * contexto, Inicio y el ciclo que insiste y cierra: ninguno reescribe estas
 * reglas. `conv` es la tabla o el alias de `conversation` en la consulta.
 */

/**
 * Saliente aceptado por el canal: salió y el proveedor lo tomó. Lo que sigue en
 * cola, falló o lo «envió» el modo de demostración (`mock-`) no cuenta como
 * respuesta.
 */
export function acceptedOutSql(m: SQL): SQL {
  return sql`(${m}.direction = 'out' and ${m}.status in ('sent', 'delivered', 'read') and coalesce(${m}.external_id, '') not like 'mock-%')`
}

/** Último entrante de la persona en el hilo. */
export function lastInboundSql(conv: SQL): SQL {
  return sql`(select max(m_in.created_at) from message m_in
    where m_in.organization_id = ${conv}.organization_id and m_in.conversation_id = ${conv}.id and m_in.direction = 'in')`
}

/** Último saliente aceptado del hilo. */
export function lastAcceptedOutSql(conv: SQL): SQL {
  return sql`(select max(m_out.created_at) from message m_out
    where m_out.organization_id = ${conv}.organization_id and m_out.conversation_id = ${conv}.id and ${acceptedOutSql(sql.raw("m_out"))})`
}

/** Espera respuesta de la clínica: abierta y con un entrante posterior al último saliente aceptado. */
export function unansweredSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and ${lastInboundSql(conv)} is not null
    and (${lastAcceptedOutSql(conv)} is null or ${lastInboundSql(conv)} > ${lastAcceptedOutSql(conv)}))`
}

/** Desde cuándo espera respuesta: el primer entrante sin responder. Nulo si no espera. */
export function unansweredSinceSql(conv: SQL): SQL {
  return sql`(case when ${unansweredSql(conv)} then (select min(m_wait.created_at) from message m_wait
    where m_wait.organization_id = ${conv}.organization_id and m_wait.conversation_id = ${conv}.id and m_wait.direction = 'in'
      and m_wait.created_at > coalesce(${lastAcceptedOutSql(conv)}, '-infinity'::timestamptz)) end)`
}

/** Tiene una derivación sin resolver. */
export function handoffOpenExistsSql(conv: SQL): SQL {
  return sql`exists (select 1 from agent_handoff h_open
    where h_open.organization_id = ${conv}.organization_id and h_open.conversation_id = ${conv}.id and ${handoffOpenSql(sql.raw("h_open"))})`
}

/** Tiene una propuesta vigente que espera el sí del interlocutor. */
export function proposalPendingExistsSql(conv: SQL): SQL {
  return sql`exists (select 1 from agent_proposal p_wait
    where p_wait.organization_id = ${conv}.organization_id and p_wait.conversation_id = ${conv}.id and ${proposalPendingSql(sql.raw("p_wait"))})`
}

/** Una persona del equipo la lleva: alguien la tiene asignada o apagó el agente en el hilo. */
export function personInChargeSql(conv: SQL): SQL {
  return sql`(${conv}.assigned_user_id is not null or ${conv}.agent_status = 'off')`
}

/**
 * La atiende el agente: abierta, encendido en el hilo, Recepción encendida en
 * la organización y atendiendo el canal del hilo.
 */
export function agentAttendingSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and ${conv}.agent_status = 'on' and exists (
    select 1 from agent_config ac_on join channel_connection cc_on on cc_on.id = ${conv}.channel_connection_id
    where ac_on.organization_id = ${conv}.organization_id and ac_on.enabled
      and (ac_on.channels is null or cc_on.channel = any(ac_on.channels))))`
}

/** Con el equipo: derivación sin resolver o una persona a cargo. */
export function withTeamSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and (${handoffOpenExistsSql(conv)} or ${personInChargeSql(conv)}))`
}

/** El último mensaje del hilo es un saliente aceptado (de agente o equipo). */
export function lastIsAcceptedOutSql(conv: SQL): SQL {
  return sql`exists (select 1 from (select m_last.direction, m_last.status, m_last.external_id from message m_last
      where m_last.organization_id = ${conv}.organization_id and m_last.conversation_id = ${conv}.id
      order by m_last.created_at desc, m_last.id desc limit 1) as last_msg
    where ${acceptedOutSql(sql.raw("last_msg"))})`
}

/**
 * Desde cuándo se espera al paciente: abierta, el último mensaje es un
 * saliente aceptado y no hay derivación abierta. Cuenta desde el primer
 * saliente aceptado después de su último entrante. Nulo si no.
 */
export function awaitingPatientSinceSql(conv: SQL): SQL {
  return sql`(case when ${conv}.status = 'open' and not ${handoffOpenExistsSql(conv)} and ${lastIsAcceptedOutSql(conv)}
    then (select min(m_aw.created_at) from message m_aw
      where m_aw.organization_id = ${conv}.organization_id and m_aw.conversation_id = ${conv}.id
        and ${acceptedOutSql(sql.raw("m_aw"))}
        and m_aw.created_at > coalesce(${lastInboundSql(conv)}, '-infinity'::timestamptz)) end)`
}

/** Espera al paciente: se le respondió y no contesta, o una propuesta espera su sí. */
export function awaitingPatientSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and (${awaitingPatientSinceSql(conv)} is not null or ${proposalPendingExistsSql(conv)}))`
}

/**
 * Sigue abierta con una persona a cargo (ADR 0024): con Recepción encendida,
 * una persona la lleva (o el agente no atiende su canal), no espera respuesta ni tiene un caso abierto y nadie
 * escribe desde hace las horas que la clínica eligió para cerrar
 * (`close_after_hours`). El ciclo no la cierra sola: la muestra «Te espera».
 */
export function stillOpenWithPersonSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and (${personInChargeSql(conv)} or not ${agentAttendingSql(conv)}) and not ${unansweredSql(conv)} and not ${handoffOpenExistsSql(conv)}
    and exists (select 1 from agent_config ac_q where ac_q.organization_id = ${conv}.organization_id and ac_q.enabled
      and greatest(coalesce(${conv}.last_message_at, '-infinity'::timestamptz), ${conv}.attention_started_at)
        <= now() - make_interval(hours => ac_q.close_after_hours)))`
}

/** Vistas de la Bandeja, cada una con su regla. */
export const CONVERSATION_VIEWS = ["unanswered", "team", "awaiting_patient", "agent", "closed"] as const
export type ConversationView = (typeof CONVERSATION_VIEWS)[number]

export function conversationViewSql(conv: SQL, view: ConversationView): SQL {
  switch (view) {
    case "unanswered":
      return unansweredSql(conv)
    case "team":
      return withTeamSql(conv)
    case "awaiting_patient":
      return awaitingPatientSql(conv)
    case "agent":
      return agentAttendingSql(conv)
    case "closed":
      return sql`(${conv}.status = 'closed')`
  }
}
