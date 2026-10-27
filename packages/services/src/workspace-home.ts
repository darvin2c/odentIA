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
 * cargo, la siguiente tarea con el resto resumido, lo que hace falta y lo
 * vencido del inventario de cada sede (para quien pide las compras), los
 * consentimientos que una atención pidió y faltan publicar (para quien
 * configura), lo que recomienda el
 * administrador y, solo si él está apagado, los presupuestos que esperan
 * respuesta (encendido, esa lista es una de sus líneas y saldría dos veces).
 * Ninguna propuesta del agente espera al equipo (ADR 0023): lo que el agente no
 * resuelve llega como caso.
 */

/** Tope de filas por tipo: lo demás se resume en una fila «y N más». */
export const WAITING_LIMITS = { urgentCases: 5, overdueTasks: 3, otherCases: 3, unconfirmed: 3, unclosed: 3, unsentBudgets: 3 } as const

/**
 * Terminó de completar sus datos por su enlace hoy y tiene cita hoy, aún sin
 * llegar: recepción sabe que ya puede atenderla y marca «Llegó» cuando entra.
 * Se va al marcar la llegada.
 */
export interface WaitingRegistrationDone {
  /** Su cita de hoy. */
  appointmentId: string
  patientId: string
  patientName: string
  /** Cuándo envió sus datos. */
  sentAt: string
  startsAt: string
  professionalName: string | null
}

export interface WaitingCase {
  id: string
  /** `media` es «Hoy» y `baja` «Sin apuro»; «Ahora» lo dice `urgent`. */
  priority: string
  /** «Ahora»: alta, o ya pasaron dos horas de clínica abierta esperando (decisión 1 del pulido). */
  urgent: boolean
  /** De qué trata (R3): un pago le llega a caja, una duda clínica al odontólogo. */
  topicKind: string
  /**
   * Quien mira lo responde desde Inicio, sin entrar a la Bandeja: es suyo, o es
   * un pago sin tomar y quien mira es caja (decisión 3 del pulido).
   */
  canReply: boolean
  /** Lo que preguntó, para responderlo ahí mismo; solo si `canReply`. */
  quote: string | null
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
 * Un documento escrito desde fuera ya es de otra persona y recepción revisa
 * (nunca se unen solas):
 * - `enlace`: el que escribió en «Su enlace» es de otra ficha; no se guardó.
 * - `registro`: alguien se registró en línea con el documento de una persona
 *   que ya estaba; no se guardó nada en ella ni se completó el registro.
 * - `representante`: el registro de un menor nombró como representante a una
 *   persona que ya estaba; el vínculo espera su «Confirmar».
 */
export interface WaitingPossibleDuplicate {
  /** La tarea que lo recuerda. */
  id: string
  source: "enlace" | "registro" | "representante"
  /** La ficha que se revisa; en `registro`, la de quien tenía el documento si ya es paciente. */
  patientId: string | null
  /** `registro`: quien tenía el documento; `representante`: el representante nombrado. */
  personId: string | null
  /** El paciente (`enlace`, `representante`) o quien tenía el documento (`registro`). */
  patientName: string
  /** `representante`: su nombre. */
  personName: string | null
  /** Qué pasó y lo que escribió, en palabras. */
  detail: string
  createdAt: string
  /**
   * `registro`: guardó lo que escribió quien se registró por el código QR;
   * «Revisar» abre «¿Es la misma persona?» para decidir con ello.
   */
  held?: boolean
}

/**
 * Un pedido de la persona sobre sus datos que vence dentro de 3 días o ya
 * venció (ADR 0080): «Rosa Quispe pidió una copia de su historia · vence en 3
 * días». Lo ve quien atiende los pedidos.
 */
export interface WaitingDataRequest {
  id: string
  patientId: string
  patientName: string
  /** Qué pidió. */
  request: "copia" | "corregir" | "mensajes" | "borrar"
  dueOn: string
  /** Ya se comprobó que es ella o su representante. */
  verified: boolean
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

/**
 * Una cita que hay que confirmar llamando: sigue sin confirmar después del
 * primer recordatorio del agente (`sin_confirmar`), o es de mañana y quien
 * recibe sus mensajes no recibe recordatorios (`sin_recordatorios`, ADR 0040):
 * «Lucía no recibe recordatorios: llámala para confirmar su cita de mañana 10:00».
 */
export interface WaitingUnconfirmed {
  why: "sin_confirmar" | "sin_recordatorios"
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

/**
 * Una cita de un día que ya terminó y que nadie cerró: sigue «por confirmar» o
 * «confirmada», sin llegada ni atención. Ya no se puede confirmar; queda decir
 * si vino («Registrar la atención») o no («No vino»). No se marca sola: el
 * sistema no sabe si vino. Las de hoy ya salen en la Agenda («Ya pasaron · sin
 * cerrar»); aquí entran al terminar su día.
 */
export interface WaitingUnclosed {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  professionalName: string | null
  serviceName: string | null
  branchName: string
}

/** Quienes aceptaron un presupuesto y no tienen cita por venir: la lista se trabaja desde Inicio. */
export interface WaitingAcceptedUnbooked {
  patients: number
  cents: number
  currency: string
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

/**
 * Un aviso de servicio que WhatsApp pasó a promoción (ADR 0040): solo sale a
 * quien aceptó novedades. Para quien administra los mensajes, con «Cambiar el
 * texto». Sale del estado de la plantilla y se va sola cuando el texto nuevo se
 * aprueba como servicio.
 */
export interface WaitingPromotion {
  /** El mensaje (clave del catálogo o id del propio). */
  messageId: string
  title: string
}

/**
 * El inventario de una sede pide trabajo: «Inventario de Miraflores: 3
 * productos hacen falta y 1 lote venció», con nombres de ejemplo y «Pedir lo
 * que falta». Una fila por sede; sale del estado y se va sola cuando ya no
 * falta nada (`inventoryWaiting`, ADR 0067).
 */
export interface WaitingInventory {
  branchId: string
  branchName: string
  needed: number
  neededNames: string[]
  expiredLots: number
  expired: Array<{ productName: string; expiresAt: string }>
}

export type WaitingRow =
  | ({ kind: "case" } & WaitingCase)
  | ({ kind: "inventory" } & WaitingInventory)
  | ({ kind: "consentToPublish" } & WaitingConsentToPublish)
  | ({ kind: "promotion" } & WaitingPromotion)
  | ({ kind: "staleEncounter" } & WaitingStaleEncounter)
  | ({ kind: "registrationDone" } & WaitingRegistrationDone)
  | ({ kind: "unconfirmed" } & WaitingUnconfirmed)
  | ({ kind: "unclosed" } & WaitingUnclosed)
  | ({ kind: "acceptedUnbooked" } & WaitingAcceptedUnbooked)
  | ({ kind: "unsentBudget" } & WaitingUnsentBudget)
  | ({ kind: "possibleDuplicate" } & WaitingPossibleDuplicate)
  | ({ kind: "portalReentry" } & WaitingPortalReentry)
  | ({ kind: "dataRequest" } & WaitingDataRequest)
  | ({ kind: "unreached" } & WaitingUnreached)
  | { kind: "conversations"; waiting: number; oldestAt: string | null }
  | ({ kind: "stillOpen" } & WaitingStillOpen)
  /** `more`: tareas abiertas que no tienen fila propia; solo la lleva la última. */
  | ({ kind: "task"; more: number } & WaitingTask)
  | ({ kind: "advice" } & WaitingAdvice)
  | ({ kind: "budgets" } & WaitingBudgets)
  /** Lo que no cupo de un tipo, con su total. */
  | { kind: "more"; of: "cases" | "tasks" | "unconfirmed" | "unclosed" | "unsentBudgets"; count: number }

export interface WaitingParts {
  /** Casos que pasó el agente y siguen sin resolver, del que más lleva esperando al más reciente. */
  cases: WaitingCase[]
  /** Todos los casos abiertos, también los que no llegaron en `cases` (el «y N más» los cuenta). */
  casesTotal?: number
  /** Atenciones de días anteriores sin cerrar que lleva quien mira, de la más antigua a la más reciente. */
  staleEncounters?: WaitingStaleEncounter[]
  /** Quien terminó su registro hoy y tiene cita hoy sin llegar, del más reciente al más antiguo. */
  registrationsDone?: WaitingRegistrationDone[]
  /** Citas sin confirmar tras el recordatorio, de la más próxima a la más lejana, y cuántas son. */
  unconfirmed?: { items: WaitingUnconfirmed[]; total: number } | null
  /** Citas de días anteriores sin cerrar, de la más antigua a la más reciente, y cuántas son. */
  unclosed?: { items: WaitingUnclosed[]; total: number } | null
  /** Quienes aceptaron y no tienen cita, con lo que suma (null o 0: nadie). */
  acceptedUnbooked?: WaitingAcceptedUnbooked | null
  /** Presupuestos armados y sin enviar desde el día anterior, del más antiguo al más reciente. */
  unsentBudgets?: { items: WaitingUnsentBudget[]; total: number } | null
  /** Lo que «Su enlace» encontró repetido, del más antiguo al más reciente. */
  possibleDuplicates?: WaitingPossibleDuplicate[]
  /** Quien pidió volver a entrar al portal, del más antiguo al más reciente. */
  portalReentries?: WaitingPortalReentry[]
  /** Pedidos sobre sus datos que vencen pronto o ya vencieron, del plazo más cercano al más lejano. */
  dataRequests?: WaitingDataRequest[]
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
  /** Inventario de cada sede con algo que hace falta o vencido (solo para quien pide las compras). */
  inventory?: WaitingInventory[]
  /** Consentimientos pedidos por una atención y sin publicar (solo para quien configura). */
  consentsToPublish?: WaitingConsentToPublish[]
  /** Avisos que WhatsApp cuenta como promoción (solo para quien administra los mensajes). */
  promotions?: WaitingPromotion[]
}

export function composeWaiting(parts: WaitingParts): WaitingRow[] {
  const rows: WaitingRow[] = []
  const urgent = parts.cases.filter((item) => item.urgent)
  const urgentShown = urgent.slice(0, WAITING_LIMITS.urgentCases)
  for (const item of urgentShown) rows.push({ kind: "case", ...item })

  // Un pedido sobre sus datos tiene plazo legal: va justo después de lo urgente.
  for (const item of (parts.dataRequests ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "dataRequest", ...item })

  // La ficha de esa persona sigue trabada por un borrador de otro día: va antes que lo del día.
  for (const item of parts.staleEncounters ?? []) rows.push({ kind: "staleEncounter", ...item })

  // Terminó su registro y su cita es hoy: ya se le puede atender al llegar.
  for (const item of (parts.registrationsDone ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "registrationDone", ...item })

  // Lo que pasó y nadie cerró va antes que lo que viene: sin cerrar, sus cifras no cuentan.
  if (parts.unclosed && parts.unclosed.total > 0) {
    const shown = parts.unclosed.items.slice(0, WAITING_LIMITS.unclosed)
    for (const item of shown) rows.push({ kind: "unclosed", ...item })
    const left = parts.unclosed.total - shown.length
    if (left > 0) rows.push({ kind: "more", of: "unclosed", count: left })
  }

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

  // Trabajo ya vendido sin cita: una sola fila que abre la lista para agendarlos desde Inicio.
  if (parts.acceptedUnbooked && parts.acceptedUnbooked.patients > 0) rows.push({ kind: "acceptedUnbooked", ...parts.acceptedUnbooked })

  // Lo que dejaron «Su enlace» y el portal para recepción (ADR 0037).
  for (const item of (parts.portalReentries ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "portalReentry", ...item })
  for (const item of (parts.possibleDuplicates ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "possibleDuplicate", ...item })

  if (parts.unreached && parts.unreached.total > 0) rows.push({ kind: "unreached", ...parts.unreached })

  if (parts.conversations && parts.conversations.waiting > 0) rows.push({ kind: "conversations", ...parts.conversations })

  const overdue = parts.overdueTasks.slice(0, WAITING_LIMITS.overdueTasks)
  for (const item of overdue) rows.push({ kind: "task", ...item, more: 0 })

  // «Hoy» antes que «Sin apuro»; lo que no encaja en ninguna se trata como «Hoy».
  const rank = (priority: string) => (priority === "baja" ? 1 : 0)
  const others = parts.cases.filter((item) => !item.urgent).sort((a, b) => rank(a.priority) - rank(b.priority))
  const othersShown = others.slice(0, WAITING_LIMITS.otherCases)
  for (const item of othersShown) rows.push({ kind: "case", ...item })
  const casesLeft = Math.max(parts.casesTotal ?? parts.cases.length, parts.cases.length) - urgentShown.length - othersShown.length
  if (casesLeft > 0) rows.push({ kind: "more", of: "cases", count: casesLeft })

  if (parts.stillOpen && parts.stillOpen.total > 0) rows.push({ kind: "stillOpen", ...parts.stillOpen })

  const tasksLeft = Math.max(parts.openTasks - overdue.length - (parts.nextTask ? 1 : 0), 0)
  if (parts.nextTask) rows.push({ kind: "task", ...parts.nextTask, more: tasksLeft })
  else if (tasksLeft > 0) rows.push({ kind: "more", of: "tasks", count: tasksLeft })

  // El inventario de cada sede: lo que hace falta y lo vencido, para quien pide.
  for (const item of (parts.inventory ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "inventory", ...item })

  // Lo que una atención no pudo hacer porque falta publicar su consentimiento.
  for (const item of (parts.consentsToPublish ?? []).slice(0, WAITING_LIMITS.otherCases))
    rows.push({ kind: "consentToPublish", ...item })

  // Un aviso que WhatsApp pasó a promoción: hay que cambiarle el texto (ADR 0040).
  for (const item of (parts.promotions ?? []).slice(0, WAITING_LIMITS.otherCases)) rows.push({ kind: "promotion", ...item })

  for (const item of parts.advice) rows.push({ kind: "advice", ...item })
  if (parts.budgets && parts.budgets.total > 0) rows.push({ kind: "budgets", ...parts.budgets })
  return rows
}
