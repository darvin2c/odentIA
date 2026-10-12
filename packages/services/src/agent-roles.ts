import { AUTONOMY_ACTIONS, type AutonomyAction, type AutonomyMode, DEFAULT_AUTONOMY_MODES } from "@odentia/db/schema/agent"

/**
 * Ficha de cada agente: su manual de funciones. Es la fuente única de lo que
 * el agente puede hacer (qué herramientas trae cada función), de lo que se le
 * dice en el prompt y de lo que la clínica ve en su página. Una herramienta
 * que no figure en ninguna función ni en `always` no llega al modelo: lo fija
 * una prueba del paquete del agente.
 */
/**
 * La base fija: lo que odentIA establece para todos los agentes y ninguna
 * clínica, indicación ni lección puede cambiar. La misma lista va al prompt y
 * a la pantalla «La base».
 */
export const AGENT_BASE_PRINCIPLES = [
  "Es parte del equipo de la clínica y dice que es un asistente virtual.",
  "Responde solo con datos reales. Si no tiene el dato, lo dice.",
  "Ante la duda, pasa el caso a una persona.",
  "Cada quien ve solo lo que le corresponde.",
  "No diagnostica, no receta y no decide por el profesional.",
] as const

export const AGENT_ROLE_IDS = ["recepcion", "asistente_clinico", "asesor", "ayuda"] as const
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]

export interface AgentFunction {
  id: string
  label: string
  /** Una línea para la página del agente. */
  description: string
  /** `true`: forma parte del agente y la clínica no la apaga. */
  fixed: boolean
  /** Herramientas que la función aporta; una herramienta sirve si alguna función encendida la trae. */
  tools: readonly string[]
  /** Cómo trabaja, paso a paso, tal como se le explica a la clínica. */
  steps?: readonly string[]
  /** Qué hace el agente cuando la función está apagada y alguien la pide. */
  whenOff?: string
  /** Lo mismo, dicho a la clínica en la página del agente. */
  offNote?: string
}

export interface AgentRole {
  id: AgentRoleId
  name: string
  audience: string
  /** Una frase: para qué existe. */
  role: string
  /** `false`: definido en el manual, todavía sin construir. */
  available: boolean
  /** La clínica lo enciende; `false` = viene con el sistema. */
  switchable: boolean
  functions: readonly AgentFunction[]
  /** Herramientas que el agente tiene siempre, sin pertenecer a una función. */
  always: readonly string[]
  sees: string
  notSees: string
  never: string
  confirms: string
  learnsFrom: string
  /** «Cómo se comporta», tal como trabaja hoy. Lo fijo de todos los agentes va aparte, en `AGENT_BASE_PRINCIPLES`. */
  behaves?: string
  /** «Cómo se prueba»: con qué lo prueba la clínica antes de usarlo. */
  testedWith?: string
  /** De quién es lo que aprende o lo que se le ajusta. */
  learningOwner?: string
  /** Lo previsto que todavía no existe: la página lo anuncia como «Más adelante», nunca como hecho. */
  later?: string
  /** Lo mismo, para lo que aprenderá. */
  learnsLater?: string
}

export const AGENT_ROLES: Record<AgentRoleId, AgentRole> = {
  recepcion: {
    id: "recepcion",
    name: "Recepción",
    audience: "Para pacientes y contactos, en todos los canales",
    role: "Atiende a quien escribe a la clínica: responde, agenda y hace seguimiento, y pasa el caso a una persona cuando corresponde.",
    available: true,
    switchable: true,
    functions: [
      {
        id: "informar",
        label: "Informar",
        description: "Sedes, servicios, precios y las respuestas oficiales de la clínica.",
        fixed: false,
        tools: ["ver_sedes_y_servicios", "consultar_conocimiento"],
        whenOff: "No respondes preguntas de información general (precios, servicios, horarios): pasa el caso a una persona.",
        offNote: "Apagada: si preguntan por precios, servicios u horarios, pasa el caso a una persona.",
      },
      {
        id: "agendar",
        label: "Agendar, mover y cancelar citas",
        description: "Busca horarios reales, reserva con el sí del paciente, reprograma y cancela.",
        fixed: false,
        tools: ["ver_sedes_y_servicios", "buscar_huecos", "proponer_cita", "enviar_enlace_cita", "reprogramar_cita", "cancelar_cita"],
        steps: [
          "Confirma la sede y el servicio.",
          "Busca huecos reales en la agenda.",
          "Propone la cita.",
          "Pide el sí del paciente o la aprobación del equipo, según el nivel.",
          "Reserva y avisa.",
        ],
        whenOff: "No reservas, mueves ni cancelas citas: si lo piden, pasa el caso a una persona.",
        offNote: "Apagada: si piden una cita, moverla o cancelarla, pasa el caso a una persona.",
      },
      {
        id: "seguimiento",
        label: "Seguimiento comercial",
        description: "Registra al interesado, mueve su oportunidad y retoma el contacto.",
        fixed: false,
        tools: ["create_opportunity", "update_followup", "close_opportunity", "move_to_stage", "listar_oportunidades"],
        whenOff: "No creas ni cambias oportunidades ni seguimientos comerciales.",
        offNote: "Apagada: no crea ni mueve oportunidades. Tu equipo lleva el seguimiento.",
      },
      {
        id: "ordenar",
        label: "Ordenar el caso",
        description: "Actualiza datos de contacto, pone etiquetas, deja tareas a tu equipo y recuerda las preferencias de cada persona. Lo ves y lo deshaces en la ficha.",
        fixed: true,
        tools: ["add_tags", "update_contact", "create_task", "listar_tareas", "anotar_caso", "recordar_dato"],
      },
      {
        id: "derivar",
        label: "Pasar a una persona",
        description: "Con el resumen del caso.",
        fixed: true,
        tools: ["request_human_handoff"],
      },
    ],
    always: [
      "send_reply",
      "send_template",
      "confirmar_propuesta",
      "ver_contexto_paciente",
      "ver_resumen_paciente",
      "leer_contexto_comercial",
      "ver_otros_canales",
    ],
    sees: "La conversación y lo acordado. Agenda, servicios y precios. El conocimiento de la clínica. Las citas y los datos de contacto de la persona; su saldo solo si la clínica lo autoriza.",
    notSees: "Historia clínica ni caja.",
    never: "Diagnosticar o recetar. Inventar precios, horarios o disponibilidad. Ver o mencionar la historia clínica.",
    confirms: "Según el nivel: el paciente con su sí o el equipo en Aprobaciones.",
    learnsFrom: "Las correcciones del equipo, como lecciones que alguien aprueba.",
  },
  asistente_clinico: {
    id: "asistente_clinico",
    name: "Asistente clínico",
    audience: "Para el odontólogo, dentro de la atención",
    role: "Convierte lo que el odontólogo dicta en el borrador de la atención, para que revise y firme sin escribir.",
    available: true,
    switchable: true,
    // Solo lo que ya está construido. El odontograma por voz y las recetas llegan después:
    // mientras no existan, no figuran como funciones.
    functions: [
      { id: "nota", label: "Consulta y evolución", description: "Motivo, enfermedad actual, evolución, indicaciones y siguiente paso.", fixed: true, tools: [] },
      { id: "diagnostico", label: "Diagnóstico", description: "Registra el código CIE-10 que nombró el odontólogo, con su pieza.", fixed: true, tools: [] },
      { id: "plan", label: "Plan de tratamiento", description: "Busca cada prestación dictada en los servicios de la clínica; si no hay una sola, la elige el odontólogo.", fixed: true, tools: [] },
      { id: "controles", label: "Controles", description: "Deja sugerido el próximo control.", fixed: true, tools: [] },
    ],
    always: [],
    // Lo que de verdad recibe: el texto dictado y los nombres de los servicios; el código CIE-10 se
    // comprueba contra el catálogo. Mientras se dicta recibe también las sugerencias de ese mismo
    // dictado que siguen sin decidir (sin tarifas). No lee la atención, el odontograma ni el plan.
    sees: "Lo que el odontólogo dicta en esa atención. Las sugerencias de ese dictado que aún no decide, para entender una corrección dicha en voz alta. Los servicios de la clínica y el catálogo CIE-10, para reconocer lo dictado.",
    notSees: "El resto de la historia clínica, el odontograma ni el plan del paciente. Conversaciones ni caja.",
    never:
      "Guardar sin que el odontólogo confirme. Firmar o cerrar la atención. Diagnosticar por su cuenta. Escuchar sin que el odontólogo pulse «Dictar». Tocar atenciones de otros profesionales.",
    confirms: "El odontólogo que lleva la atención: confirma cada sugerencia y firma.",
    learnsFrom: "Hoy no aprende: cada dictado se ordena desde cero, con los servicios que la clínica tenga en ese momento.",
    behaves:
      "Registra solo lo que el odontólogo dijo, sin completar lo que falta. Si se corrige al dictar, vale lo último. Una prestación que no encuentra, o que coincide con varias, queda «Por revisar» para que el odontólogo elija.",
    testedWith: "Con un dictado de práctica: sin paciente ni atención, nada llega a una historia.",
    learningOwner: "No guarda nada de un odontólogo ni de la clínica.",
    later: "Odontograma por voz y recetas. Elegir el estilo de la nota, breve o detallada.",
    learnsLater: "Recordar los términos de cada odontólogo, como algo suyo.",
  },
  asesor: {
    id: "asesor",
    name: "Asesor",
    audience: "Para quien administra, en Inicio",
    role: "Revisa lo que pasa en la clínica y dice qué conviene atender primero, con la acción lista para aprobar.",
    available: true,
    switchable: true,
    functions: [
      { id: "controles_vencidos", label: "Controles vencidos", description: "Pacientes con un control pendiente que ya pasó.", fixed: false, tools: [] },
      { id: "presupuestos_sin_cita", label: "Presupuestos sin cita", description: "Presupuestos aceptados que nadie agendó.", fixed: false, tools: [] },
      { id: "atenciones_sin_firmar", label: "Atenciones sin firmar", description: "Borradores que quedaron abiertos.", fixed: false, tools: [] },
      { id: "seguimientos_sin_responsable", label: "Seguimientos sin responsable", description: "Oportunidades que nadie lleva.", fixed: false, tools: [] },
      { id: "cobranza_vencida", label: "Cobranza vencida", description: "Saldos que pasaron su fecha.", fixed: false, tools: [] },
      { id: "inasistencias_sin_cita", label: "Inasistencias sin otra cita", description: "Personas que faltaron y nadie volvió a agendar.", fixed: false, tools: [] },
      { id: "presupuestos_sin_respuesta", label: "Presupuestos sin respuesta", description: "Presupuestos presentados que siguen esperando.", fixed: false, tools: [] },
      { id: "preparar", label: "Preparar la acción", description: "La lista de personas y las tareas listas para crear. Si hay una automatización que lo evita, como el recordatorio de control, ofrece encenderla.", fixed: true, tools: [] },
      { id: "explicar", label: "Mostrar cómo se calculó", description: "Cada cifra con la lista que la respalda.", fixed: true, tools: [] },
    ],
    always: [],
    sees: "Agenda, pendientes y reportes, según los permisos de quien lee. Los números salen de la base de datos, no del modelo.",
    notSees: "Conversaciones ni historia clínica.",
    never: "Ejecutar por su cuenta: no crea tareas, no envía mensajes ni enciende automatizaciones. Dar un número que no pueda mostrar. Más de tres recomendaciones a la vez.",
    confirms: "Una persona confirma cada acción: crear las tareas o encender una automatización, con el permiso de cada una.",
    // No hay aprendizaje automático: «No me interesa» pospone la detección y el umbral se cambia a mano.
    learnsFrom: "De lo que descartas: «No me interesa» oculta esa detección una semana. El umbral de días lo cambias tú.",
    behaves: "No redacta con un modelo: cada recomendación es una consulta a los datos de la clínica. Breve, con la cifra, la lista que la respalda y cómo se calculó.",
    testedWith: "Con una vista previa de lo que recomendaría hoy, antes de encenderlo.",
    learningOwner: "Es solo del asesor de esta clínica: no cambia a los otros agentes.",
    learnsLater: "Ajustar el umbral por su cuenta según lo que descartas.",
  },
  ayuda: {
    id: "ayuda",
    name: "Ayuda",
    audience: "Para todo el equipo, en todas las pantallas",
    role: "Ayuda a usar odentIA: dónde está cada cosa, qué se puede hacer y por qué algo no se puede.",
    available: true,
    switchable: false,
    functions: [
      { id: "donde", label: "Dónde está", description: "Dónde se configura o se ve algo, con «Llévame».", fixed: true, tools: [] },
      { id: "se_puede", label: "Se puede", description: "Sí y dónde; no; o tu rol no puede y quién sí.", fixed: true, tools: [] },
      { id: "por_que_no", label: "Por qué no puedo", description: "Qué falta en lo que tienes abierto.", fixed: true, tools: [] },
      { id: "que_significa", label: "Qué significa", description: "Los términos del sistema.", fixed: true, tools: [] },
      { id: "enviar", label: "Enviar a odentIA", description: "Lo que no supo responder, o un problema.", fixed: true, tools: [] },
    ],
    always: [],
    sees: "El mapa del sistema. La pantalla donde estás y su estado. Tu rol. Lo que tu clínica ya configuró.",
    notSees: "Conversaciones, historia clínica ni montos.",
    never: "Cambiar datos. Inventar una función que no existe.",
    confirms: "Nadie: no cambia nada.",
    learnsFrom: "odentIA. La clínica no le sube ni le enseña nada.",
  },
}

/** Funciones que la clínica puede apagar en un agente. */
export function switchableFunctions(role: AgentRoleId): string[] {
  return AGENT_ROLES[role].functions.filter((fn) => !fn.fixed).map((fn) => fn.id)
}

/**
 * Herramientas que el agente NO tiene con esas funciones apagadas: las de una
 * función apagada que ninguna función encendida (ni `always`) aporta también.
 */
export function toolsDisabledBy(role: AgentRoleId, disabledFunctions: readonly string[]): string[] {
  const ficha = AGENT_ROLES[role]
  const off = new Set(disabledFunctions)
  const kept = new Set<string>(ficha.always)
  for (const fn of ficha.functions) {
    if (fn.fixed || !off.has(fn.id)) for (const tool of fn.tools) kept.add(tool)
  }
  const removed = new Set<string>()
  for (const fn of ficha.functions) {
    if (fn.fixed || !off.has(fn.id)) continue
    for (const tool of fn.tools) if (!kept.has(tool)) removed.add(tool)
  }
  return [...removed]
}

/** Todas las herramientas que la ficha declara, para comprobar que no sobra ni falta ninguna. */
export function roleTools(role: AgentRoleId): string[] {
  const ficha = AGENT_ROLES[role]
  return [...new Set([...ficha.always, ...ficha.functions.flatMap((fn) => fn.tools)])]
}

/* ---------- Hasta dónde llega solo: niveles sobre la política de autonomía ---------- */

export const AGENT_LEVELS = ["supervisado", "equilibrado", "autonomo"] as const
export type AgentLevel = (typeof AGENT_LEVELS)[number]

const ALL_TEAM = Object.fromEntries(AUTONOMY_ACTIONS.map((action) => [action, "aprobar_equipo"])) as Record<
  AutonomyAction,
  AutonomyMode
>

/**
 * Cada nivel es una política completa. `equilibrado` es la política por
 * defecto del producto: una clínica que nunca tocó la autonomía ya está ahí.
 */
export const AGENT_LEVEL_POLICY: Record<AgentLevel, Record<AutonomyAction, AutonomyMode>> = {
  supervisado: ALL_TEAM,
  equilibrado: { ...DEFAULT_AUTONOMY_MODES },
  autonomo: {
    reservar_cita: "directo",
    reprogramar_cita: "directo",
    cancelar_cita: "confirmar_usuario",
    enviar_mensaje: "directo",
    mover_oportunidad: "directo",
    crear_oportunidad: "directo",
    actualizar_seguimiento: "directo",
    cerrar_oportunidad: "directo",
  },
}

export const AGENT_LEVEL_INFO: Record<AgentLevel, { label: string; summary: string }> = {
  supervisado: {
    label: "Supervisado",
    summary: "Escribe los borradores y tu equipo los envía. Nada sale ni cambia sin que alguien lo apruebe.",
  },
  equilibrado: {
    label: "Equilibrado",
    summary:
      "Responde solo. Para reservar o mover una cita pide el sí del paciente. Cancelar una cita, crear o cerrar una oportunidad y programar un seguimiento los aprueba tu equipo.",
  },
  autonomo: {
    label: "Autónomo",
    summary: "Responde, agenda y lleva el seguimiento solo. Solo para cancelar una cita pide el sí del paciente.",
  },
}

/** Nivel que corresponde a una política; `personalizado` si no coincide con ninguno. */
export function levelOfPolicy(policy: Record<AutonomyAction, AutonomyMode>): AgentLevel | "personalizado" {
  for (const level of AGENT_LEVELS) {
    const preset = AGENT_LEVEL_POLICY[level]
    if (AUTONOMY_ACTIONS.every((action) => preset[action] === policy[action])) return level
  }
  return "personalizado"
}
