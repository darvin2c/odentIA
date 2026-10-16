import type { AutomationKind, ConsentPurpose } from "@odentia/db/schema/automation"
import type { TaskArea } from "@odentia/db/schema/crm"

/**
 * Las líneas del agente Administrador: lo que puede pasar en la clínica y qué
 * se hace cuando pasa. Ocho vienen armadas (`ADMIN_LINES`) y otras solo
 * existen en la clínica que las pide (`CUSTOM_LINES`). Es un catálogo fijo,
 * sin base de datos y sin modelo: de aquí salen los textos de su página, el flujo de cada línea, las
 * tareas que deja y a qué parte del equipo van. El estado de cada línea
 * (prendida, apagada y cuál de sus partes va) vive en `automation_rule`.
 *
 * Una línea tiene hasta dos partes, cada una con su interruptor: «el agente le
 * escribe» y «tarea para el equipo». En las líneas del agente, la tarea es el
 * respaldo cuando no pudo escribir; el aviso de por qué no pudo sale siempre.
 */

export type AdminLineKey = AutomationKind

/** Los tiempos que una clínica puede ajustar en una línea. */
export interface LineTiming {
  /** Cuántas horas antes se recuerda una cita. */
  hoursBefore?: number[]
  /** Horas de espera, en las líneas que esperan horas. */
  delayHours?: number
  /** Hora del día a la que sale (0–23), con la hora de la sede. */
  hour?: number
}

/** Un texto del catálogo: fijo, o dicho con los tiempos vigentes de la línea. */
export type Phrase = string | ((timing: LineTiming) => string)

export function say(phrase: Phrase, timing: LineTiming = {}): string {
  return typeof phrase === "function" ? phrase(timing) : phrase
}

/** A quién del equipo va una tarea sin responsable, con las palabras de la pantalla. */
export const TASK_AREA_LABELS: Record<TaskArea, { team: string; short: string }> = {
  recepcion: { team: "el equipo de recepción", short: "Equipo de recepción" },
  caja: { team: "el equipo de caja", short: "Caja" },
  clinico: { team: "el profesional que la lleva", short: "Profesional" },
  administracion: { team: "quien administra la clínica", short: "Administración" },
}

export interface AdminLine {
  key: AdminLineKey
  /** Nombre corto: «Recordar la cita». */
  name: string
  /** Rótulo del área de la clínica. */
  area: string
  /** Lo que pasa, con el plazo cuando la línea lo tiene. */
  trigger: (days: number | null) => string
  /** Paso de espera del flujo; null si actúa en el momento. */
  wait: (days: number | null, timing?: LineTiming) => string | null
  /** Quién lo hace con la línea entera: el agente o una persona del equipo. */
  actor: "agente" | "persona"
  /** Parte «el agente le escribe»; null en las líneas que solo dejan trabajo al equipo. */
  agent: null | {
    purpose: ConsentPurpose
    /** «le recuerda un día antes y 3 horas antes»: se antepone «El agente Recepción». */
    does: Phrase
    /** Lo mismo, apagada: «le recordaría un día antes y 3 horas antes». */
    would: Phrase
    /** Paso del flujo: «Le escribe». */
    step: string
    /** Nombre de la tarea de respaldo en el flujo: «Tarea de llamada». */
    fallback: string
  }
  /** Parte «tarea para el equipo». */
  team: {
    area: TaskArea
    /** Paso del flujo: «Tarea de llamada». */
    step: string
    /** Prendida: «Queda una tarea de llamada para el equipo de recepción». */
    does: string
    /** Apagada: «Quedaría una tarea de llamada para el equipo de recepción». */
    would: string
    taskTitle: (personName: string) => string
    /** La tarea va a la persona que lleva el caso (la atención), no a un área. */
    toOwner?: boolean
  }
  /** Permiso que necesita quien ve sus casos: no se enseña lo que el rol no ve. */
  permission: string
  /** Plazo por defecto en días, en las líneas que lo tienen. */
  defaultDays: number | null
  /** Cómo se llama ese plazo al ajustarlo. */
  daysLabel: string | null
  /** Horas que espera por defecto, en las líneas que esperan horas (se ajusta de 1 a 72). */
  delayHours?: number
  /** Se le puede fijar una hora del día para salir. */
  hourAdjustable?: boolean
  /**
   * No viene armada: existe en una clínica solo cuando ella la crea pidiéndosela
   * al Administrador, y es la única clase de línea que se puede eliminar.
   */
  custom?: boolean
}

const days = (n: number | null, fallback: number) => {
  const value = n ?? fallback
  return value === 1 ? "1 día" : `${value} días`
}

const hoursWord = (n: number) => (n === 1 ? "una hora" : `${n} horas`)

/** «un día antes y 3 horas antes», de lo más lejano a lo más cercano. */
export function beforePhrase(hours: readonly number[] = DEFAULT_HOURS_BEFORE): string {
  const parts = [...hours]
    .sort((a, b) => b - a)
    .map((h) => (h % 24 === 0 ? (h === 24 ? "un día antes" : `${h / 24} días antes`) : `${hoursWord(h)} antes`))
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}` : (parts[0] ?? "")
}

/** «10:00»: la hora del día a la que sale, con la hora de la sede. */
export function hourPhrase(hour: number): string {
  return `${hour}:00`
}

export const DEFAULT_HOURS_BEFORE: readonly number[] = [24, 3]
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const ADMIN_LINES: readonly AdminLine[] = [
  {
    key: "recordatorio_cita",
    name: "Recordar la cita",
    area: "Agenda",
    trigger: () => "Una persona tiene una cita",
    wait: (_, timing) => capital(beforePhrase(timing?.hoursBefore)),
    actor: "agente",
    agent: {
      purpose: "recordatorio",
      does: (timing) => `le recuerda ${beforePhrase(timing.hoursBefore)}`,
      would: (timing) => `le recordaría ${beforePhrase(timing.hoursBefore)}`,
      step: "Le recuerda",
      fallback: "Tarea de llamada",
    },
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} para recordarle su cita`,
    },
    permission: "appointments.read",
    defaultDays: null,
    daysLabel: null,
  },
  {
    key: "recordatorio_control",
    name: "Avisar un control",
    area: "Controles",
    trigger: () => "Un control se acerca",
    wait: () => "Dos días antes",
    actor: "agente",
    agent: {
      purpose: "recordatorio",
      does: "le avisa para agendarlo",
      would: "le avisaría para agendarlo",
      step: "Le avisa",
      fallback: "Tarea de llamada",
    },
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} para agendar su control`,
    },
    permission: "appointments.read",
    defaultDays: null,
    daysLabel: null,
  },
  {
    key: "seguimiento_presupuesto",
    name: "Retomar un presupuesto",
    area: "Presupuestos",
    trigger: (n) => `Un presupuesto lleva ${days(n, 2)} sin respuesta`,
    wait: (n) => `Espera ${days(n, 2)}`,
    actor: "agente",
    agent: {
      purpose: "seguimiento",
      does: "le escribe para retomarlo",
      would: "le escribiría para retomarlo",
      step: "Le escribe",
      fallback: "Tarea de llamada",
    },
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} por su presupuesto`,
    },
    permission: "budgets.read",
    defaultDays: 2,
    daysLabel: "Días sin respuesta",
  },
  {
    key: "seguimiento_comercial",
    name: "Retomar una oportunidad",
    area: "Ventas",
    trigger: () => "La tarea de una oportunidad vence",
    wait: () => null,
    actor: "agente",
    agent: {
      purpose: "seguimiento",
      does: "le escribe para retomar la conversación y da la tarea por hecha",
      would: "le escribiría para retomar la conversación y daría la tarea por hecha",
      step: "Le escribe",
      fallback: "Su tarea sigue",
    },
    // No deja otra tarea: la misma tarea de la oportunidad queda para quien la
    // lleva (sin responsable, Recepción) con el motivo de por qué no pudo.
    team: {
      area: "recepcion",
      step: "Su tarea sigue",
      does: "La misma tarea queda para quien lleva la oportunidad",
      would: "La misma tarea quedaría para quien lleva la oportunidad",
      taskTitle: (name) => `Llamar a ${name} para retomar su consulta`,
      toOwner: true,
    },
    permission: "crm.read",
    defaultDays: null,
    daysLabel: null,
  },
  {
    key: "seguimiento_no_asistencia",
    name: "Reprogramar tras una inasistencia",
    area: "Agenda",
    trigger: () => "Una persona falta a su cita",
    wait: (_, timing) => `Espera al día siguiente${timing?.hour === undefined ? "" : `, ${hourPhrase(timing.hour)}`}`,
    actor: "agente",
    agent: {
      purpose: "seguimiento",
      does: (timing) => `le escribe al día siguiente${timing.hour === undefined ? "" : `, a las ${hourPhrase(timing.hour)},`} para reprogramar`,
      would: (timing) => `le escribiría al día siguiente${timing.hour === undefined ? "" : `, a las ${hourPhrase(timing.hour)},`} para reprogramar`,
      step: "Le escribe",
      fallback: "Tarea de llamada",
    },
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} para reagendar su cita`,
    },
    permission: "appointments.read",
    defaultDays: null,
    daysLabel: null,
    hourAdjustable: true,
  },
  {
    key: "presupuestos_sin_cita",
    name: "Presupuesto aceptado sin cita",
    area: "Presupuestos",
    trigger: (n) => `Un presupuesto aceptado pasa ${days(n, 7)} sin cita`,
    wait: (n) => `Espera ${days(n, 7)}`,
    actor: "persona",
    agent: null,
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} para agendar su tratamiento`,
    },
    permission: "appointments.read",
    defaultDays: 7,
    daysLabel: "Días desde que se aceptó",
  },
  {
    key: "atenciones_sin_firmar",
    name: "Atención sin firmar",
    area: "Atenciones",
    trigger: (n) => `Una atención lleva ${days(n, 2)} sin firmar`,
    wait: (n) => `Espera ${days(n, 2)}`,
    actor: "persona",
    agent: null,
    team: {
      area: "clinico",
      step: "Tarea para firmar",
      does: "Le queda una tarea al profesional que la lleva",
      would: "Le quedaría una tarea al profesional que la lleva",
      taskTitle: (name) => `Revisar y firmar la atención de ${name}`,
      toOwner: true,
    },
    permission: "clinical.read",
    defaultDays: 2,
    daysLabel: "Días sin firmar",
  },
  {
    key: "cobranza_vencida",
    name: "Saldo vencido",
    area: "Cobranza",
    trigger: (n) => `Un saldo pasa ${days(n, 30)} vencido`,
    wait: (n) => `Espera ${days(n, 30)}`,
    actor: "persona",
    agent: null,
    team: {
      area: "caja",
      step: "Tarea de cobro",
      does: "Queda una tarea para el equipo de caja",
      would: "Quedaría una tarea para el equipo de caja",
      taskTitle: (name) => `Llamar a ${name} por lo que debe`,
    },
    permission: "finance.read",
    defaultDays: 30,
    daysLabel: "Días de deuda",
  },
] as const

/**
 * Piezas que el sistema también sabe hacer y que no vienen armadas: una clínica
 * las tiene solo si las creó pidiéndoselas al Administrador con palabras. Una
 * pieza nueva se añade aquí con su mensaje declarado, su consulta de casos y su
 * prueba; el modelo nunca arma una que no esté en esta lista.
 */
export const CUSTOM_LINES: readonly AdminLine[] = [
  {
    key: "cita_cancelada",
    name: "Ofrecer otra fecha tras una cancelación",
    area: "Agenda",
    trigger: () => "Una persona cancela su cita",
    wait: (_, timing) => `Espera ${hoursWord(timing?.delayHours ?? 1)}`,
    actor: "agente",
    agent: {
      purpose: "seguimiento",
      does: (timing) => `le escribe ${hoursWord(timing.delayHours ?? 1)} después para ofrecerle otra fecha`,
      would: (timing) => `le escribiría ${hoursWord(timing.delayHours ?? 1)} después para ofrecerle otra fecha`,
      step: "Le escribe",
      fallback: "Tarea de llamada",
    },
    team: {
      area: "recepcion",
      step: "Tarea de llamada",
      does: "Queda una tarea de llamada para el equipo de recepción",
      would: "Quedaría una tarea de llamada para el equipo de recepción",
      taskTitle: (name) => `Llamar a ${name} para ofrecerle otra fecha`,
    },
    permission: "appointments.read",
    defaultDays: null,
    daysLabel: null,
    delayHours: 1,
    custom: true,
  },
]

/** Una línea por su clave: las que vienen armadas y las que una clínica puede crear. */
export function adminLineOf(key: string): AdminLine | null {
  return ADMIN_LINES.find((line) => line.key === key) ?? CUSTOM_LINES.find((line) => line.key === key) ?? null
}

/**
 * Tipos de trabajo que pertenecen a una línea sin ser su clave: los avisos de
 * cita (reservada, movida, cancelada) son de «Recordar la cita».
 */
const JOB_KIND_LINE: Record<string, AdminLineKey> = {
  aviso_cita_reservada: "recordatorio_cita",
  aviso_cita_movida: "recordatorio_cita",
  aviso_cita_cancelada: "recordatorio_cita",
}

/** La línea de un trabajo (o de un mensaje del catálogo) por su tipo. */
export function lineOfJobKind(kind: string): AdminLine | null {
  return adminLineOf(JOB_KIND_LINE[kind] ?? kind)
}

/** Los tipos de trabajo de una línea: su clave y los que le pertenecen. */
export function jobKindsOfLine(key: string): string[] {
  return [key, ...Object.entries(JOB_KIND_LINE).filter(([, line]) => line === key).map(([kind]) => kind)]
}

/** Lo que dice la línea en la lista, según esté prendida o apagada y qué partes van. */
export function describeLine(
  line: AdminLine,
  state: { enabled: boolean; agentPart: boolean; teamPart: boolean },
  timing: LineTiming = {},
): string {
  const { agent, team } = line
  if (!agent || !state.agentPart) return `${state.enabled ? team.does : team.would}.`
  const writes = `El agente Recepción ${say(state.enabled ? agent.does : agent.would, timing)}.`
  const notice = "Si no puede, avisa por qué y cómo habilitarlo"
  if (!state.teamPart) return `${writes} ${notice}.`
  const whom = team.toOwner ? "quien lo lleva" : TASK_AREA_LABELS[team.area].team
  // «Retomar una oportunidad» no deja otra tarea: la suya sigue para quien la lleva.
  const own = state.enabled ? team.does : team.would
  const fallback = team.toOwner
    ? own.charAt(0).toLowerCase() + own.slice(1)
    : `${state.enabled ? "queda" : "quedaría"} una tarea para ${whom}`
  return `${writes} ${notice}, y ${fallback}.`
}

/** Quién lo hace, tal como queda con las partes que van. */
export function actorOf(line: AdminLine, state: { agentPart: boolean }): "agente" | "persona" {
  return line.agent && state.agentPart ? "agente" : "persona"
}

// ------------------------------------------------------------- el flujo ---

export type FlowActor = "administrador" | "recepcion" | "equipo"

export interface FlowStep {
  id: string
  kind: "inicio" | "paso" | "decision" | "fin"
  label: string
  /** Quién hace el paso; null en el inicio, la decisión y el fin. */
  actor: FlowActor | null
  /** «Administrador · agente», «Equipo de recepción · persona»… */
  actorLabel: string | null
  /** Parte de la línea a la que pertenece: su interruptor lo prende o lo apaga. */
  part: "agent" | "team" | null
  /** El aviso de «no pude» no tiene interruptor: el flujo nunca termina en blanco. */
  always: boolean
}

export interface LineFlow {
  /** Camino principal, de izquierda a derecha. */
  main: FlowStep[]
  /**
   * Lo que pasa cuando el agente no puede escribir. Sale de la decisión del
   * camino principal. Null si la línea no tiene esa decisión.
   */
  otherwise: FlowStep[] | null
}

/**
 * El flujo de una línea, con solo lo que de verdad se ejecuta según las
 * partes que van. `all` lo devuelve entero (para verlo con la línea apagada).
 */
export function flowOf(
  line: AdminLine,
  state: { agentPart: boolean; teamPart: boolean },
  options: { days: number | null; all?: boolean; timing?: LineTiming },
): LineFlow {
  const agentOn = !!line.agent && (options.all || state.agentPart)
  const teamOn = options.all || state.teamPart
  const team = TASK_AREA_LABELS[line.team.area]
  const start: FlowStep = { id: "inicio", kind: "inicio", label: line.trigger(options.days), actor: null, actorLabel: null, part: null, always: false }
  const wait = line.wait(options.days, options.timing)
  const waitStep: FlowStep[] = wait
    ? [{ id: "espera", kind: "paso", label: wait, actor: "administrador", actorLabel: "Administrador · agente", part: null, always: false }]
    : []
  const teamStep = (label: string): FlowStep => ({
    id: "tarea",
    kind: "paso",
    label,
    actor: "equipo",
    actorLabel: `${line.team.toOwner ? "Quien lo lleva" : team.short} · persona`,
    part: "team",
    always: false,
  })
  const end = (id: string, label: string): FlowStep => ({ id, kind: "fin", label, actor: null, actorLabel: null, part: null, always: false })
  if (!agentOn || !line.agent) {
    return { main: [start, ...waitStep, teamStep(line.team.step), end("fin", "Le toca a una persona")], otherwise: null }
  }
  const main: FlowStep[] = [
    start,
    ...waitStep,
    { id: "puede", kind: "decision", label: "¿Puede escribirle el agente?", actor: null, actorLabel: null, part: null, always: false },
    { id: "escribe", kind: "paso", label: line.agent.step, actor: "recepcion", actorLabel: "Recepción · agente", part: "agent", always: false },
    end("fin", "Lo resuelve el agente"),
  ]
  const otherwise: FlowStep[] = [
    { id: "aviso", kind: "paso", label: "Avisa por qué y cómo habilitarlo", actor: "administrador", actorLabel: "Administrador · siempre", part: null, always: true },
    ...(teamOn ? [teamStep(line.agent.fallback), end("fin-persona", "Le toca a una persona")] : [end("fin-aviso", "Queda avisado")]),
  ]
  return { main, otherwise }
}
