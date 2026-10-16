/**
 * «Te espera»: la única lista de lo que hay que hacer. Aquí vive solo el orden,
 * como función pura: cada parte llega ya filtrada por lo que el rol puede ver
 * (lo decide `getWorkspaceHome`), y esta función no consulta nada.
 *
 * Cada asunto ocupa una sola fila: el caso que pasó el agente no se repite como
 * tarea ni dentro de «N personas esperan respuesta» (eso lo quita la consulta).
 * Lo que aparece aquí no llega a la campana, que es solo para enterarse.
 *
 * El orden es fijo y sin puntajes: casos «Ahora», atenciones de días
 * anteriores sin cerrar de quien mira, citas que siguen sin confirmar tras el
 * primer recordatorio del agente, los presupuestos armados que nadie envió
 * desde el día anterior (para quien habla con la persona, decisión 12), lo
 * que dejó «Su enlace» y el portal para recepción (una posible ficha repetida,
 * quien pide volver a entrar al portal), las personas a las que el agente no
 * pudo escribir, conversaciones sin responder, tareas vencidas, casos
 * «Hoy» y «Sin apuro», conversaciones que siguen abiertas con una persona a
 * cargo, la siguiente tarea con el resto resumido, los consentimientos que
 * una atención pidió y faltan publicar (para quien configura), lo que recomienda el
 * administrador y, solo si él está apagado, los presupuestos que esperan
 * respuesta (encendido, esa lista es una de sus líneas y saldría dos veces).
 * Ninguna propuesta del agente espera al equipo (ADR 0023): lo que el agente no
 * resuelve llega como caso.
 */

/** Tope de filas por tipo: lo demás se resume en una fila «y N más». */
export const WAITING_LIMITS = { urgentCases: 5, overdueTasks: 3, otherCases: 3, unconfirmed: 3, unsentBudgets: 3 } as const

export interface WaitingCase {
  id: string
  /** `alta` es «Ahora», `media` «Hoy» y `baja` «Sin apuro». */
  priority: string
  reason: string
  contactName: string | null
  channel: string | null
  createdAt: string
  conversationId: string | null
  /** Nadie lo tomó todavía: la fila ofrece «Tomar». */
  unclaimed: boolean
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
  /** La oportunidad de la que sale, si el rol puede verla. */
  opportunityTitle: string | null
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

/**
 * Un presupuesto que quedó armado al firmar la atención y nadie envió desde el
 * día anterior: «Presupuesto de Lucía Fernández sin enviar · Enviar». Es la
 * misma regla que «Qué sigue» del Plan (`unsentBudgetOf`); se va sola al
 * enviarlo. Le sale a quien habla con la persona (decisión 4).
 */
export interface WaitingUnsentBudget {
  /** El presupuesto. */
  id: string
  patientId: string
  patientName: string
  /** Desde cuándo está armado. */
  since: string
  /** Tratamientos de la opción que vale y su total (null si falta algún precio). */
  itemCount: number
  totalCents: number | null
  currency: string
  options: number
}

/**
 * El documento que la persona escribió en «Su enlace» ya es de otra ficha: no
 * se guardó y recepción revisa si son la misma persona (nunca se unen solas).
 */
export interface WaitingPossibleDuplicate {
  /** La tarea que lo recuerda. */
  id: string
  patientId: string
  patientName: string
  /** De quién es el documento, en palabras. */
  detail: string
  createdAt: string
}

/**
 * Pidió volver a entrar al portal (cambió de teléfono, perdió el enlace): el
 * agente lo dejó aquí y recepción le envía un enlace nuevo, sin volver a
 * comprobar su identidad. El código se le dice aparte.
 */
export interface WaitingPortalReentry {
  /** La tarea que lo recuerda. */
  id: string
  patientId: string
  contactName: string
  /** Su acceso vigente: «Enviar nuevo enlace» es de él. */
  grantId: string | null
  createdAt: string
}

/** Una cita que sigue sin confirmar después del primer recordatorio del agente: hay que llamar. */
export interface WaitingUnconfirmed {
  id: string
  patientId: string
  patientName: string
  phone: string | null
  startsAt: string
  branchName: string
  serviceName: string | null
}

/**
 * Una atención en borrador de un día anterior que lleva quien mira: ningún
 * borrador queda abandonado (decisión 12 de la fase 3). Se continúa o se anula
 * con motivo; es la misma regla que «Ya pasaron · sin cerrar» de la Agenda.
 */
export interface WaitingStaleEncounter {
  /** La atención. */
  id: string
  patientId: string
  patientName: string
  startedAt: string
  /** Lo que falta para cerrarla, como claves (`ClosingRequirement`); los nombres los pone la interfaz. */
  missing: string[]
}

/** Conversaciones que siguen abiertas con una persona a cargo y sin mensajes desde hace horas. */
export interface WaitingStillOpen {
  total: number
  /** La única, cuando es una: la fila la abre directamente. */
  conversationId: string | null
  contactName: string | null
  /** El último mensaje de la que más lleva quieta. */
  quietSince: string | null
}

/**
 * Un consentimiento que una atención pidió y la clínica aún no publicó, para
 * quien configura: «Publicar el consentimiento de … · lo pidió la Dra. Ana».
 * Sale del estado (`listConsentsToPublish`) y se va sola al publicarlo.
 */
export interface WaitingConsentToPublish {
  templateKey: string
  title: string
  requestedByName: string | null
  requestedAt: string
}

export type WaitingRow =
  | ({ kind: "case" } & WaitingCase)
  | ({ kind: "consentToPublish" } & WaitingConsentToPublish)
  | ({ kind: "staleEncounter" } & WaitingStaleEncounter)
  | ({ kind: "unconfirmed" } & WaitingUnconfirmed)
  | ({ kind: "unsentBudget" } & WaitingUnsentBudget)
  | ({ kind: "possibleDuplicate" } & WaitingPossibleDuplicate)
  | ({ kind: "portalReentry" } & WaitingPortalReentry)
  | ({ kind: "unreached" } & WaitingUnreached)
  | { kind: "conversations"; waiting: number; oldestAt: string | null }
  | ({ kind: "stillOpen" } & WaitingStillOpen)
  /** `more`: tareas abiertas que no tienen fila propia; solo la lleva la última. */
  | ({ kind: "task"; more: number } & WaitingTask)
  | ({ kind: "advice" } & WaitingAdvice)
  | ({ kind: "budgets" } & WaitingBudgets)
  /** Lo que no cupo de un tipo, con su total. */
  | { kind: "more"; of: "cases" | "tasks" | "unconfirmed" | "unsentBudgets"; count: number }

export interface WaitingParts {
  /** Casos que pasó el agente y siguen sin resolver, del que más lleva esperando al más reciente. */
  cases: WaitingCase[]
  /** Atenciones de días anteriores sin cerrar que lleva quien mira, de la más antigua a la más reciente. */
  staleEncounters?: WaitingStaleEncounter[]
  /** Citas sin confirmar tras el recordatorio, de la más próxima a la más lejana, y cuántas son. */
  unconfirmed?: { items: WaitingUnconfirmed[]; total: number } | null
  /** Presupuestos armados y sin enviar desde el día anterior, del más antiguo al más reciente. */
  unsentBudgets?: { items: WaitingUnsentBudget[]; total: number } | null
  /** Lo que «Su enlace» encontró repetido, del más antiguo al más reciente. */
  possibleDuplicates?: WaitingPossibleDuplicate[]
  /** Quien pidió volver a entrar al portal, del más antiguo al más reciente. */
  portalReentries?: WaitingPortalReentry[]
  conversations: { waiting: number; oldestAt: string | null } | null
  stillOpen?: WaitingStillOpen | null
  /** Tareas vencidas, de la que venció antes a la más reciente. */
  overdueTasks: WaitingTask[]
  /** La siguiente tarea abierta que no está vencida. */
  nextTask: WaitingTask | null
  /** Total de tareas abiertas de quien mira (o del equipo, para quien dirige). */
  openTasks: number
  advice: WaitingAdvice[]
  budgets: WaitingBudgets | null
  unreached?: WaitingUnreached | null
  /** Consentimientos pedidos por una atención y sin publicar (solo para quien configura). */
  consentsToPublish?: WaitingConsentToPublish[]
}

export function composeWaiting(parts: WaitingParts): WaitingRow[] {
  const rows: WaitingRow[] = []
  const urgent = parts.cases.filter((item) => item.priority === "alta")
  const urgentShown = urgent.slice(0, WAITING_LIMITS.urgentCases)
  for (const item of urgentShown) rows.push({ kind: "case", ...item })

  // La ficha de esa persona sigue trabada por un borrador de otro día: va antes que lo del día.
  for (const item of parts.staleEncounters ?? []) rows.push({ kind: "staleEncounter", ...item })

  if (parts.unconfirmed && parts.unconfirmed.total > 0) {
    const shown = parts.unconfirmed.items.slice(0, WAITING_LIMITS.unconfirmed)
    for (const item of shown) rows.push({ kind: "unconfirmed", ...item })
    const left = parts.unconfirmed.total - shown.length
    if (left > 0) rows.push({ kind: "more", of: "unconfirmed", count: left })
  }

  // Ningún borrador queda abandonado: el presupuesto que nadie envió le sale a quien habla con la persona.
  if (parts.unsentBudgets && parts.unsentBudgets.total > 0) {
    const shown = parts.unsentBudgets.items.slice(0, WAITING_LIMITS.unsentBudgets)
    for (const item of shown) rows.push({ kind: "unsentBudget", ...item })
    const left = parts.unsentBudgets.total - shown.length
    if (left > 0) rows.push({ kind: "more", of: "unsentBudgets", count: left })
  }

  // Lo que dejaron «Su enlace» y el portal para recepción (ADR 0037).
  for (const item of (parts.portalReentries ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "portalReentry", ...item })
  for (const item of (parts.possibleDuplicates ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "possibleDuplicate", ...item })

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

  if (parts.stillOpen && parts.stillOpen.total > 0) rows.push({ kind: "stillOpen", ...parts.stillOpen })

  const tasksLeft = Math.max(parts.openTasks - overdue.length - (parts.nextTask ? 1 : 0), 0)
  if (parts.nextTask) rows.push({ kind: "task", ...parts.nextTask, more: tasksLeft })
  else if (tasksLeft > 0) rows.push({ kind: "more", of: "tasks", count: tasksLeft })

  // Lo que una atención no pudo hacer porque falta publicar su consentimiento.
  for (const item of (parts.consentsToPublish ?? []).slice(0, WAITING_LIMITS.otherCases))
    rows.push({ kind: "consentToPublish", ...item })

  for (const item of parts.advice) rows.push({ kind: "advice", ...item })
  if (parts.budgets && parts.budgets.total > 0) rows.push({ kind: "budgets", ...parts.budgets })
  return rows
}
