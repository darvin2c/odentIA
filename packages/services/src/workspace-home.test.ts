import { expect, it } from "vitest"
import { composeWaiting, WAITING_LIMITS, type WaitingCase, type WaitingParts, type WaitingTask, type WaitingUnconfirmed } from "./workspace-home.js"

const caseOf = (id: string, priority: string): WaitingCase => ({
  id, priority, reason: `Caso ${id}`, contactName: "Elena Castro", channel: "whatsapp",
  createdAt: "2026-10-12T15:00:00.000Z", conversationId: null, unclaimed: true,
})
const taskOf = (id: string, due: WaitingTask["due"]): WaitingTask => ({
  id, title: `Tarea ${id}`, dueAt: null, due, href: `/tasks?task=${id}`, mine: true, assigneeName: null, opportunityTitle: null,
})
const unconfirmedOf = (id: string): WaitingUnconfirmed => ({
  id, patientId: `p-${id}`, patientName: "Rosa Quispe", phone: "+51987654100", startsAt: "2026-10-17T15:30:00.000Z",
  branchName: "Centro", serviceName: "Evaluación",
})
const nothing: WaitingParts = {
  cases: [], conversations: null, overdueTasks: [], nextTask: null, openTasks: 0, advice: [], budgets: null,
}
/** Cada fila como «tipo:identidad», para leer el orden de un vistazo. */
const shape = (parts: Partial<WaitingParts>) =>
  composeWaiting({ ...nothing, ...parts }).map((row) => {
    if (row.kind === "case" || row.kind === "task" || row.kind === "unconfirmed") return `${row.kind}:${row.id}`
    if (row.kind === "advice") return `advice:${row.key}`
    if (row.kind === "more") return `more:${row.of}:${row.count}`
    return row.kind
  })

it("sin nada pendiente no hay filas", () => {
  expect(composeWaiting(nothing)).toEqual([])
  // Cero conversaciones, cero presupuestos y cero tareas tampoco dejan una fila vacía.
  expect(composeWaiting({ ...nothing, conversations: { waiting: 0, oldestAt: null }, budgets: { total: 0, oldestPresentedAt: null, items: [] } })).toEqual([])
})

it("el orden es fijo: ahora, sin confirmar, no pudo escribir, conversaciones, vencidas, hoy, siguen abiertas, siguiente tarea, asesor y presupuestos", () => {
  expect(shape({
    cases: [caseOf("sin-apuro", "baja"), caseOf("hoy", "media"), caseOf("ahora", "alta")],
    unconfirmed: { items: [unconfirmedOf("rosa")], total: 1 },
    stillOpen: { total: 2, conversationId: null, contactName: null, quietSince: "2026-10-12T05:00:00.000Z" },
    conversations: { waiting: 5, oldestAt: "2026-10-12T13:00:00.000Z" },
    overdueTasks: [taskOf("vencida", "overdue")],
    nextTask: taskOf("de-hoy", "today"),
    openTasks: 9,
    advice: [{ key: "recordatorio_control", title: "12 controles vencidos", detail: "", actor: "agente" }],
    unreached: { total: 6, byCause: [{ total: 6, reason: "no aceptó mensajes de la clínica" }] },
    budgets: { total: 4, oldestPresentedAt: "2026-10-03T15:00:00.000Z", items: [] },
  })).toEqual([
    "case:ahora", "unconfirmed:rosa", "unreached", "conversations", "task:vencida", "case:hoy", "case:sin-apuro", "stillOpen", "task:de-hoy",
    "advice:recordatorio_control", "budgets",
  ])
})

it("la última tarea resume las que no tienen fila", () => {
  const rows = composeWaiting({ ...nothing, overdueTasks: [taskOf("a", "overdue")], nextTask: taskOf("b", "today"), openTasks: 9 })
  expect(rows.map((row) => (row.kind === "task" ? row.more : null))).toEqual([0, 7])
  // Con una sola tarea no hay resto que anunciar.
  expect(composeWaiting({ ...nothing, nextTask: taskOf("b", "later"), openTasks: 1 })).toMatchObject([{ kind: "task", more: 0 }])
})

it("lo que no cabe de un tipo se resume en su sitio, sin perder la cuenta", () => {
  const overdue = Array.from({ length: WAITING_LIMITS.overdueTasks + 2 }, (_, index) => taskOf(`v${index}`, "overdue"))
  // Todas vencidas y más de las que caben: una fila dice cuántas tareas quedan.
  expect(shape({ overdueTasks: overdue, openTasks: 12 })).toEqual(["task:v0", "task:v1", "task:v2", "more:tasks:9"])
  // Casos: los «Ahora» que no caben se suman a los demás en una sola fila, después de los de hoy.
  const urgent = Array.from({ length: WAITING_LIMITS.urgentCases + 1 }, (_, index) => caseOf(`u${index}`, "alta"))
  const calm = Array.from({ length: WAITING_LIMITS.otherCases + 2 }, (_, index) => caseOf(`c${index}`, "media"))
  expect(shape({ cases: [...calm, ...urgent] }).slice(-2)).toEqual(["case:c2", "more:cases:3"])
})

it("una prioridad desconocida se trata como «Hoy», nunca como «Ahora»", () => {
  expect(shape({ cases: [caseOf("rara", "otra"), caseOf("baja", "baja")], conversations: { waiting: 1, oldestAt: null } })).toEqual([
    "conversations", "case:rara", "case:baja",
  ])
})

it("ninguna propuesta del agente espera al equipo: «Te espera» no tiene filas de aprobar", () => {
  const kinds = composeWaiting({ ...nothing, cases: [caseOf("ahora", "alta")], conversations: { waiting: 1, oldestAt: null } }).map((row) => row.kind)
  expect(kinds).toEqual(["case", "conversations"])
  expect(Object.keys(WAITING_LIMITS)).not.toContain("proposals")
})

it("las citas sin confirmar que no caben se resumen en una fila con su cuenta", () => {
  const items = Array.from({ length: WAITING_LIMITS.unconfirmed }, (_, index) => unconfirmedOf(`c${index}`))
  expect(shape({ unconfirmed: { items, total: WAITING_LIMITS.unconfirmed + 4 } })).toEqual([
    ...items.map((item) => `unconfirmed:${item.id}`), "more:unconfirmed:4",
  ])
  expect(shape({ unconfirmed: { items: [], total: 0 } })).toEqual([])
})
