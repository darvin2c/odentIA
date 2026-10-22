// Solo el tipo, sin importaciones: lo comparten Finanzas e Inicio, y las pruebas e2e
// lo leen sin arrastrar el cliente de la API.

export interface DebtRow {
  patientId: string
  displayName: string
  branchId: string | null
  currency: string
  totalCents: number
  /** Saldo a favor: al cobrar se descuenta solo. */
  creditCents: number
  oldestSince: string | null
  latestSince: string | null
  chargesCount: number
  /** Hasta tres conceptos, del más antiguo al más nuevo. */
  concepts: string[]
  lastAttended: { at: string; professionalName: string | null } | null
  /** Cuándo salió hoy de su atención (o se le anotó algo hoy); lo decide el servidor con el día de la sede. */
  attendedTodayAt: string | null
  /** La persona a quien se le escribe; null si la ficha aún no tiene la suya. */
  contactId: string | null
  /** Su conversación abierta más reciente, si tiene alguna. */
  conversationId: string | null
}
