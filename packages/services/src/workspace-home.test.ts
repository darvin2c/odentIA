import { expect, it } from "vitest"
import { composeWaiting, WAITING_LIMITS, type WaitingCase, type WaitingParts, type WaitingPerson, type WaitingPossibleDuplicate, type WaitingTask, type WaitingUnclosed, type WaitingUnconfirmed } from "./workspace-home.js"

// «Ahora» lo dice `urgent` (decisión 1 del pulido): aquí, la prioridad alta.
const caseOf = (id: string, priority: string): WaitingCase => ({
  id, priority, urgent: priority === "alta", topicKind: "otro", reason: `Caso ${id}`, contactName: "Elena Castro", channel: "whatsapp",
  createdAt: "2026-10-12T15:00:00.000Z", conversationId: null, taskId: null, unclaimed: true, canReply: false, quote: null,
})
const taskOf = (id: string, due: WaitingTask["due"]): WaitingTask => ({
  id, title: `Tarea ${id}`, dueAt: null, due, href: `/tasks?task=${id}`, mine: true, assigneeName: null, opportunityTitle: null,
})
const unconfirmedOf = (id: string): WaitingUnconfirmed => ({
  why: "sin_confirmar", id, patientId: `p-${id}`, patientName: "Rosa Quispe", phone: "+51987654100", startsAt: "2026-10-17T15:30:00.000Z",
  branchName: "Centro", serviceName: "Evaluación",
})
const personOf = (id: string): WaitingPerson => ({
  conversationId: id, contactId: `contacto-${id}`, contactName: id, channel: "whatsapp", quote: "¿Atienden hoy?", since: "2026-10-12T13:00:00.000Z", urgent: false, windowClosed: false,
})
const duplicateOf = (id: string): WaitingPossibleDuplicate => ({
  id, source: "enlace", patientId: `p-${id}`, personId: `persona-${id}`, patientName: id, personName: null, detail: "", createdAt: "2026-10-12T13:00:00.000Z",
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
    if (row.kind === "person") return `person:${row.conversationId}`
    return row.kind
  })

it("sin nada pendiente no hay filas", () => {
  expect(composeWaiting(nothing)).toEqual([])
  // Cero conversaciones, cero presupuestos y cero tareas tampoco dejan una fila vacía.
  expect(composeWaiting({ ...nothing, conversations: { waiting: 0, items: [] }, budgets: { total: 0, oldestPresentedAt: null, items: [] } })).toEqual([])
})

it("se agrupa en Ahora, Hoy y Sin apuro, y dentro de cada grupo el orden es fijo", () => {
  expect(shape({
    cases: [caseOf("sin-apuro", "baja"), caseOf("hoy", "media"), caseOf("ahora", "alta")],
    unconfirmed: { items: [unconfirmedOf("rosa")], total: 1 },
    stillOpen: { total: 2, conversationId: null, contactName: null, quietSince: "2026-10-12T05:00:00.000Z" },
    conversations: { waiting: 1, items: [personOf("jorge")] },
    overdueTasks: [taskOf("vencida", "overdue")],
    nextTask: taskOf("de-hoy", "today"),
    openTasks: 9,
    advice: [{ key: "recordatorio_control", title: "12 controles vencidos", detail: "", actor: "agente" }],
    unreached: { total: 6, byCause: [{ total: 6, reason: "no aceptó mensajes de la clínica" }] },
    budgets: { total: 4, oldestPresentedAt: "2026-10-03T15:00:00.000Z", items: [] },
  })).toEqual([
    "case:ahora",
    "unconfirmed:rosa", "person:jorge", "task:vencida", "case:hoy", "task:de-hoy",
    "unreached", "case:sin-apuro", "stillOpen",
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
  expect(shape({ cases: [caseOf("rara", "otra"), caseOf("baja", "baja")], conversations: { waiting: 1, items: [personOf("jorge")] } })).toEqual([
    "person:jorge", "case:rara", "case:baja",
  ])
})

it("ninguna propuesta del agente espera al equipo: «Te espera» no tiene filas de aprobar", () => {
  const kinds = composeWaiting({ ...nothing, cases: [caseOf("ahora", "alta")], conversations: { waiting: 1, items: [personOf("jorge")] } }).map((row) => row.kind)
  expect(kinds).toEqual(["case", "person"])
  expect(Object.keys(WAITING_LIMITS)).not.toContain("proposals")
})

it("las citas sin confirmar que no caben se resumen en una fila con su cuenta", () => {
  const items = Array.from({ length: WAITING_LIMITS.unconfirmed }, (_, index) => unconfirmedOf(`c${index}`))
  expect(shape({ unconfirmed: { items, total: WAITING_LIMITS.unconfirmed + 4 } })).toEqual([
    ...items.map((item) => `unconfirmed:${item.id}`), "more:unconfirmed:4",
  ])
  expect(shape({ unconfirmed: { items: [], total: 0 } })).toEqual([])
})

it("los casos que no llegaron en la lista también se cuentan en «y N más»", () => {
  // Llegaron los dos más urgentes de 130: la fila dice cuántos quedan, no los que llegaron.
  expect(shape({ cases: [caseOf("u1", "alta"), caseOf("h1", "media")], casesTotal: 130 })).toEqual(["case:u1", "case:h1", "more:cases:128"])
})

it("las citas sin cerrar van antes que las por confirmar y las que no caben se resumen", () => {
  const unclosedOf = (id: string): WaitingUnclosed => ({
    id, patientId: `p-${id}`, patientName: id, startsAt: "2026-10-25T15:00:00.000Z", professionalUserId: "u1", professionalName: null, serviceName: null, branchName: "Miraflores",
  })
  const items = Array.from({ length: WAITING_LIMITS.unclosed }, (_, index) => unclosedOf(`u${index}`))
  const rows = composeWaiting({ ...nothing, unclosed: { items, total: WAITING_LIMITS.unclosed + 2 }, unconfirmed: { items: [unconfirmedOf("rosa")], total: 1 } })
  expect(rows.map((row) => (row.kind === "more" ? `more:${row.of}:${row.count}` : "id" in row ? `${row.kind}:${row.id}` : row.kind))).toEqual([
    ...items.map((item) => `unclosed:${item.id}`), "unconfirmed:rosa", "more:unclosed:2",
  ])
})

it("quienes aceptaron y no tienen cita son una sola fila, y sin nadie no hay fila", () => {
  expect(shape({ acceptedUnbooked: { patients: 76, cents: 2_412_100, currency: "PEN" } })).toEqual(["acceptedUnbooked"])
  expect(shape({ acceptedUnbooked: { patients: 0, cents: 0, currency: "PEN" } })).toEqual([])
  expect(shape({ acceptedUnbooked: null })).toEqual([])
})

it("cada persona que espera es una fila, y las que no caben se ven en la Bandeja", () => {
  const items = Array.from({ length: WAITING_LIMITS.conversations }, (_, index) => personOf(`p${index}`))
  const rows = shape({ conversations: { waiting: WAITING_LIMITS.conversations + 3, items } })
  expect(rows.slice(0, 2)).toEqual(["person:p0", "person:p1"])
  expect(rows.at(-1)).toBe("more:conversations:3")
})

it("una conversación pasa a «Ahora» con la misma regla de los temas", () => {
  const rows = composeWaiting({ ...nothing, conversations: { waiting: 2, items: [personOf("hoy"), { ...personOf("ahora"), urgent: true }] } })
  expect(rows.map((row) => [row.kind === "person" ? row.conversationId : null, row.band])).toEqual([["ahora", "ahora"], ["hoy", "hoy"]])
})

it("una persona es una sola fila: lo más urgente y, si empatan, lo que escribió; lo demás va como «También»", () => {
  const unclosed: WaitingUnclosed = { id: "cita", patientId: "p", personId: "carlos", patientName: "Carlos", startsAt: "2026-10-25T15:00:00.000Z", professionalUserId: "u", professionalName: null, serviceName: null, branchName: "Centro" }
  const [first, ...rest] = composeWaiting({
    ...nothing,
    cases: [{ ...caseOf("ahora", "media"), contactId: "carlos" }],
    unclosed: { items: [unclosed], total: 1 },
    nextTask: { ...taskOf("llamar", "later"), personId: "carlos" },
    openTasks: 1,
  })
  expect(rest).toEqual([])
  expect(first).toMatchObject({ kind: "case", id: "ahora", band: "hoy" })
  expect(first?.also?.map((row) => row.kind)).toEqual(["unclosed", "task"])
})

it("un pedido sobre sus datos no se pliega y, vencido, va en «Ahora»: tiene plazo", () => {
  const request = { id: "pedido", patientId: "p", personId: "carlos", patientName: "Carlos", request: "copia" as const, dueOn: "2026-10-10", verified: false }
  const rows = composeWaiting({ ...nothing, today: "2026-10-12", dataRequests: [request], cases: [{ ...caseOf("caso", "media"), contactId: "carlos" }] })
  expect(rows.map((row) => [row.kind, row.band])).toEqual([["dataRequest", "ahora"], ["case", "hoy"]])
  expect(rows.flatMap((row) => row.also ?? [])).toEqual([])
})

it("lo que puede esperar va en «Sin apuro», salvo las citas de mañana sin recordatorio", () => {
  const rows = composeWaiting({
    ...nothing,
    advice: [
      { key: "recordatorio_cita", title: "2 citas sin confirmar", detail: "", actor: "agente" },
      { key: "recordatorio_control", title: "12 controles", detail: "", actor: "agente" },
    ],
    promotions: [{ messageId: "a", title: "Presupuesto listo" }, { messageId: "b", title: "Recordar la cita" }],
  })
  expect(rows.map((row) => [row.kind, row.band])).toEqual([["advice", "hoy"], ["promotions", "sin_apuro"], ["advice", "sin_apuro"]])
  // Los avisos de WhatsApp van juntos en una fila.
  expect(rows[1]).toMatchObject({ kind: "promotions", items: [{ messageId: "a" }, { messageId: "b" }] })
})

it("la tarea que cuenta las demás no se pliega, aunque esa persona tenga otra fila", () => {
  const task = { ...taskOf("t", "later"), personId: "contacto-a" }
  const rows = composeWaiting({ ...nothing, nextTask: task, openTasks: 12, conversations: { waiting: 1, items: [personOf("a")] } })
  expect(rows.find((row) => row.kind === "task")).toMatchObject({ id: "t", more: 11 })
  expect(rows.find((row) => row.kind === "person")?.also).toBeUndefined()
})

it("lo que dejó el sistema va entero: no está en ninguna otra lista", () => {
  const items = ["a", "b", "c", "d", "e"].map(duplicateOf)
  expect(composeWaiting({ ...nothing, possibleDuplicates: items }).map((row) => ("id" in row ? row.id : null))).toEqual(["a", "b", "c", "d", "e"])
})
