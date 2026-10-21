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

/**
 * Una persona del equipo la lleva entera: alguien apagó el agente en el hilo
 * con el interruptor manual. Un tema abierto no cuenta: el agente sigue con lo
 * demás (ADR 0050).
 */
export function personInChargeSql(conv: SQL): SQL {
  return sql`(${conv}.agent_status = 'off')`
}

/** Minutos que el agente espera después del último mensaje de una persona del equipo (ADR 0050). */
export const TEAM_LIVE_MINUTES = 15

/** Una persona del equipo escribió en el hilo hace menos de `TEAM_LIVE_MINUTES`: conversa en vivo. */
export function teamLiveSql(conv: SQL): SQL {
  return sql`exists (select 1 from message m_live
    where m_live.organization_id = ${conv}.organization_id and m_live.conversation_id = ${conv}.id
      and m_live.direction = 'out' and m_live.sender_kind = 'user'
      and m_live.created_at > now() - make_interval(mins => ${TEAM_LIVE_MINUTES}))`
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

/** Con el equipo: un tema sin resolver o una persona a cargo. */
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
 * «Por atender» (ADR 0050): abierta y con un tema sin resolver, o una que el
 * agente no atiende (apagado en el hilo, en la clínica o en ese canal) y no
 * espera al paciente. Es lo único que pide a una persona.
 */
export function needsPersonSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and (${handoffOpenExistsSql(conv)}
    or (not ${agentAttendingSql(conv)} and not ${awaitingPatientSql(conv)})))`
}

/**
 * Sigue abierta con una persona a cargo (ADR 0024): con Recepción encendida,
 * una persona la lleva (o el agente no atiende su canal), no espera respuesta ni tiene un caso abierto y nadie
 * escribe desde hace las horas que la clínica eligió para cerrar
 * (`close_after_hours`). El ciclo no la cierra sola: la muestra «Te espera».
 */
export function stillOpenWithPersonSql(conv: SQL): SQL {
  return sql`(${conv}.status = 'open' and not ${screenedSql(conv)} and (${personInChargeSql(conv)} or not ${agentAttendingSql(conv)}) and not ${unansweredSql(conv)} and not ${handoffOpenExistsSql(conv)}
    and exists (select 1 from agent_config ac_q where ac_q.organization_id = ${conv}.organization_id and ac_q.enabled
      and greatest(coalesce(${conv}.last_message_at, '-infinity'::timestamptz), ${conv}.attention_started_at)
        <= now() - make_interval(hours => ac_q.close_after_hours)))`
}

/**
 * Su persona está en Spam o bloqueada (ADR 0054): el agente no la atiende y
 * no sale en ninguna de las cuatro pestañas, ni en Inicio ni en Reportes.
 */
export function screenedSql(conv: SQL): SQL {
  return sql`exists (select 1 from contact c_scr
    where c_scr.organization_id = ${conv}.organization_id and c_scr.id = ${conv}.contact_id and c_scr.screen is not null)`
}

/**
 * No cuenta en Reportes: su persona está en Spam o bloqueada, o es una prueba
 * del chat web desde Configuración (fase 6 del pulido de la Bandeja).
 */
export function uncountedSql(conv: SQL): SQL {
  return sql`(${screenedSql(conv)} or ${conv}.is_test)`
}

/**
 * Una persona que solo existe por una prueba del chat web: no sale en
 * Pacientes ni en el buscador (fase 6 del pulido). `person` es el alias de `contact`.
 */
export function testOnlyPersonSql(person: SQL): SQL {
  return sql`(exists (select 1 from conversation t_only where t_only.organization_id = ${person}.organization_id and t_only.contact_id = ${person}.id and t_only.is_test)
    and not exists (select 1 from conversation t_real where t_real.organization_id = ${person}.organization_id and t_real.contact_id = ${person}.id and not t_real.is_test))`
}

/** Días de la lista de Spam: lo más viejo queda en la persona, no en la lista. */
export const SPAM_VIEW_DAYS = 30

/**
 * Vistas de la Bandeja (ADR 0050 y 0054): las cuatro pestañas no se
 * superponen, así cada conversación cae en una sola y los totales suman; Spam
 * y Bloqueados son dos listas aparte, junto a las pestañas.
 * - `attend`, «Por atender»: pide a una persona (`needsPersonSql`).
 * - `awaiting_patient`: no tiene temas y espera al paciente.
 * - `agent`: la atiende el agente, sin temas y sin esperar al paciente.
 * - `closed`.
 * - `spam`: su persona está en Spam y escribió en los últimos `SPAM_VIEW_DAYS`.
 * - `blocked`: su persona está bloqueada.
 */
export const CONVERSATION_VIEWS = ["attend", "agent", "awaiting_patient", "closed", "spam", "blocked"] as const
export type ConversationView = (typeof CONVERSATION_VIEWS)[number]
/** Las cuatro pestañas: Spam y Bloqueados no cuentan en los totales de la Bandeja. */
export const INBOX_TABS = ["attend", "agent", "awaiting_patient", "closed"] as const satisfies readonly ConversationView[]

function screenIsSql(conv: SQL, screen: "spam" | "blocked"): SQL {
  return sql`exists (select 1 from contact c_is
    where c_is.organization_id = ${conv}.organization_id and c_is.id = ${conv}.contact_id and c_is.screen = ${screen})`
}

export function conversationViewSql(conv: SQL, view: ConversationView): SQL {
  switch (view) {
    case "attend":
      return sql`(${needsPersonSql(conv)} and not ${screenedSql(conv)})`
    case "awaiting_patient":
      return sql`(${awaitingPatientSql(conv)} and not ${needsPersonSql(conv)} and not ${screenedSql(conv)})`
    case "agent":
      return sql`(${agentAttendingSql(conv)} and not ${needsPersonSql(conv)} and not ${awaitingPatientSql(conv)} and not ${screenedSql(conv)})`
    case "closed":
      return sql`(${conv}.status = 'closed' and not ${screenedSql(conv)})`
    case "spam":
      return sql`(${screenIsSql(conv, "spam")}
        and coalesce(${conv}.last_message_at, ${conv}.created_at) > now() - make_interval(days => ${SPAM_VIEW_DAYS}))`
    case "blocked":
      return screenIsSql(conv, "blocked")
  }
}

/**
 * «Solo las mías» en «Por atender»: los temas que tiene la persona o que nadie
 * tomó; sin tema, lo que nadie tiene asignado o tiene ella.
 */
export function mineOrUnclaimedSql(conv: SQL, userId: string): SQL {
  return sql`(case when ${handoffOpenExistsSql(conv)} then exists (select 1 from agent_handoff h_mine
      where h_mine.organization_id = ${conv}.organization_id and h_mine.conversation_id = ${conv}.id
        and ${handoffOpenSql(sql.raw("h_mine"))} and (h_mine.assignee_user_id is null or h_mine.assignee_user_id = ${userId}))
    else (${conv}.assigned_user_id is null or ${conv}.assigned_user_id = ${userId}) end)`
}
