/**
 * «Te espera»: la única lista de pendientes de Inicio. Aquí vive solo el orden,
 * como función pura: cada parte llega ya filtrada por lo que el rol puede ver
 * (lo decide `getWorkspaceHome`), y esta función no consulta nada.
 *
 * El orden es fijo y sin puntajes: casos «Ahora», las propuestas del agente
 * que esperan la aprobación del equipo, las personas a las que el agente no
 * pudo escribir, conversaciones sin responder, tareas vencidas, casos «Hoy» y «Sin apuro», la siguiente tarea con el resto
 * resumido, lo que recomienda el administrador y, solo si él está apagado, los
 * presupuestos que esperan respuesta (encendido, esa lista es una de sus
 * líneas y saldría dos veces).
 */

/** Tope de filas por tipo: lo demás se resume en una fila «y N más». */
export const WAITING_LIMITS = { urgentCases: 5, proposals: 3, overdueTasks: 3, otherCases: 3 } as const

export interface WaitingCase {
  id: string
  /** `alta` es «Ahora», `media` «Hoy» y `baja` «Sin apuro». */
  priority: string
  reason: string
  contactName: string | null
  channel: string | null
  createdAt: string
  conversationId: string | null
}

export interface WaitingProposal {
  id: string
  action: string
  /** Lo que quedaría al aprobar, en una frase. */
  summary: string
  createdAt: string
  conversationId: string | null
  contactName: string | null
  patientName: string | null
}

export interface WaitingTask {
  id: string
  title: string
  dueAt: string | null
  /** Respecto al día de la clínica: vencida, para hoy, más adelante o sin fecha. */
  due: "overdue" | "today" | "later" | "none"
  /** Dónde se resuelve, según lo que el rol puede abrir. */
  href: string
  mine: boolean
  assigneeName: string | null
}

export interface WaitingAdvice {
  key: string
  title: string
  detail: string
  /** Quién lo haría si se prende la línea: el agente o una persona del equipo. */
  actor: "agente" | "persona"
}

/** Personas a las que el agente no pudo escribir hoy, por motivo. */
export interface WaitingUnreached {
  total: number
  byCause: Array<{ total: number; reason: string }>
}

export interface WaitingBudgets {
  total: number
  oldestPresentedAt: string | null
  items: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
}

export type WaitingRow =
  | ({ kind: "case" } & WaitingCase)
  | ({ kind: "proposal" } & WaitingProposal)
  | ({ kind: "unreached" } & WaitingUnreached)
  | { kind: "conversations"; waiting: number; oldestAt: string | null }
  /** `more`: tareas abiertas que no tienen fila propia; solo la lleva la última. */
  | ({ kind: "task"; more: number } & WaitingTask)
  | ({ kind: "advice" } & WaitingAdvice)
  | ({ kind: "budgets" } & WaitingBudgets)
  /** Lo que no cupo de un tipo, con su total. */
  | { kind: "more"; of: "cases" | "proposals" | "tasks"; count: number }

export interface WaitingParts {
  /** Casos derivados sin resolver, del que más lleva esperando al más reciente. */
  cases: WaitingCase[]
  /** Propuestas que decide el equipo, de la más reciente a la más antigua. */
  proposals: WaitingProposal[]
  /** Total de propuestas que decide el equipo, viajen o no. */
  proposalsTotal: number
  conversations: { waiting: number; oldestAt: string | null } | null
  /** Tareas vencidas, de la que venció antes a la más reciente. */
  overdueTasks: WaitingTask[]
  /** La siguiente tarea abierta que no está vencida. */
  nextTask: WaitingTask | null
  /** Total de tareas abiertas de quien mira (o del equipo, para quien dirige). */
  openTasks: number
  advice: WaitingAdvice[]
  budgets: WaitingBudgets | null
  unreached?: WaitingUnreached | null
}

export function composeWaiting(parts: WaitingParts): WaitingRow[] {
  const rows: WaitingRow[] = []
  const urgent = parts.cases.filter((item) => item.priority === "alta")
  const urgentShown = urgent.slice(0, WAITING_LIMITS.urgentCases)
  for (const item of urgentShown) rows.push({ kind: "case", ...item })

  const proposals = parts.proposals.slice(0, WAITING_LIMITS.proposals)
  for (const item of proposals) rows.push({ kind: "proposal", ...item })
  const proposalsLeft = Math.max(parts.proposalsTotal, parts.proposals.length) - proposals.length
  if (proposalsLeft > 0) rows.push({ kind: "more", of: "proposals", count: proposalsLeft })

  if (parts.unreached && parts.unreached.total > 0) rows.push({ kind: "unreached", ...parts.unreached })

  if (parts.conversations && parts.conversations.waiting > 0) rows.push({ kind: "conversations", ...parts.conversations })

  const overdue = parts.overdueTasks.slice(0, WAITING_LIMITS.overdueTasks)
  for (const item of overdue) rows.push({ kind: "task", ...item, more: 0 })

  // «Hoy» antes que «Sin apuro»; lo que no encaja en ninguna se trata como «Hoy».
  const rank = (priority: string) => (priority === "baja" ? 1 : 0)
  const others = parts.cases.filter((item) => item.priority !== "alta").sort((a, b) => rank(a.priority) - rank(b.priority))
  const othersShown = others.slice(0, WAITING_LIMITS.otherCases)
  for (const item of othersShown) rows.push({ kind: "case", ...item })
  const casesLeft = urgent.length - urgentShown.length + others.length - othersShown.length
  if (casesLeft > 0) rows.push({ kind: "more", of: "cases", count: casesLeft })

  const tasksLeft = Math.max(parts.openTasks - overdue.length - (parts.nextTask ? 1 : 0), 0)
  if (parts.nextTask) rows.push({ kind: "task", ...parts.nextTask, more: tasksLeft })
  else if (tasksLeft > 0) rows.push({ kind: "more", of: "tasks", count: tasksLeft })

  for (const item of parts.advice) rows.push({ kind: "advice", ...item })
  if (parts.budgets && parts.budgets.total > 0) rows.push({ kind: "budgets", ...parts.budgets })
  return rows
}
