import { describe, expect, it } from "vitest"
import { agendaSummary, attendedPercent, daysAgo, duplicateActions, longDay, patientsSummary, waitingKey, waitingOpenText, waitingText, type HomeTextContext } from "./home"
import type { WaitingRow } from "./workspace"

const context: HomeTextContext = { today: "2026-10-12", timezone: "America/Lima", locale: "es-PE", allTasks: false, receptionName: "Sofi" }
const task = (patch: Partial<Extract<WaitingRow, { kind: "task" }>>): WaitingRow => ({
  kind: "task", id: "t1", title: "Llamar a Mateo Huamán por su presupuesto", dueAt: null, due: "none",
  href: "/tasks?task=t1", mine: true, assigneeName: "Rosa", opportunityTitle: null, more: 0, ...patch,
})

describe("textos de «Te espera»", () => {
  it("una tarea dice cuándo vence, de qué oportunidad sale, de quién es y cuántas quedan", () => {
    expect(waitingText(task({ due: "overdue", dueAt: "2026-10-11T15:00:00.000Z", title: "Llamar a Jorge Ramos para retomar su consulta", opportunityTitle: "Ortodoncia" }), context)).toEqual({
      title: "Llamar a Jorge Ramos para retomar su consulta", detail: "Venció ayer · Oportunidad «Ortodoncia»", action: "Abrir",
    })
    // Quien dirige ve de quién es y que el resto es del equipo; con resto, la fila lleva a Tareas.
    expect(waitingText(task({ due: "today", dueAt: "2026-10-12T22:00:00.000Z", mine: false, assigneeName: "Dra. Ana Torres", more: 7 }), { ...context, allTasks: true })).toEqual({
      title: "Llamar a Mateo Huamán por su presupuesto", detail: "Para hoy · Dra. Ana Torres · y 7 tareas más del equipo", action: "Ver tareas",
    })
    expect(waitingText(task({ mine: false, assigneeName: null }), context).detail).toBe("Sin fecha · Sin responsable")
  })

  it("un caso del agente se llama siempre igual y dice su urgencia con palabras", () => {
    const row: WaitingRow = {
      kind: "case", id: "h1", priority: "alta", reason: "pregunta por un reembolso", contactName: "Lucía Paredes", channel: null,
      createdAt: new Date(Date.now() - 25 * 60_000).toISOString(), conversationId: "c1", unclaimed: true,
    }
    expect(waitingText(row, context)).toEqual({
      title: "Lucía Paredes · pregunta por un reembolso", detail: "Te lo pasó Sofi hace 25 min · Ahora", action: "Tomar este tema",
    })
    expect(waitingText({ ...row, priority: "baja", unclaimed: false }, context)).toMatchObject({ action: "Ver el caso" })
    expect(waitingText({ ...row, priority: "baja" }, context).detail).toContain("Sin apuro")
    // «Ahora» lo dice el servidor: dos horas de clínica abierta esperando, aunque sea «Hoy» (decisión 1 del pulido).
    expect(waitingText({ ...row, priority: "media", urgent: true }, context).detail).toContain("Ahora")
    // Lo que se responde aquí mismo (una duda clínica, un pago de caja) dice «Responder».
    expect(waitingText({ ...row, canReply: true }, context)).toMatchObject({ action: "Responder" })
  })

  it("con «Tomar» o «Hecha» en su propio botón, la fila sigue diciendo a dónde lleva", () => {
    const row: WaitingRow = {
      kind: "case", id: "h1", priority: "alta", reason: "pregunta por un reembolso", contactName: "Lucía Paredes", channel: null,
      createdAt: new Date().toISOString(), conversationId: "c1", unclaimed: true,
    }
    // Sin tomar, «Tomar» es el botón de al lado: pulsar la fila abre el caso.
    expect(waitingOpenText(row, context)).toBe("Ver el caso")
    expect(waitingOpenText({ ...row, unclaimed: false }, context)).toBe("Ver el caso")
    // Sin conversación la fila lleva a los casos del agente.
    expect(waitingOpenText({ ...row, conversationId: null }, context)).toBe("Revisar")
    expect(waitingOpenText(task({}), context)).toBe("Abrir")
  })

  it("una cita que no confirmó tras el recordatorio pide llamar, con el teléfono a la vista", () => {
    expect(waitingText({
      kind: "unconfirmed", why: "sin_confirmar", id: "a1", patientId: "p1", patientName: "Rosa Quispe", phone: "+51 987 654 100",
      startsAt: "2026-10-13T15:30:00.000Z", branchName: "Centro", serviceName: "Evaluación",
    }, context)).toMatchObject({ title: "Rosa Quispe no confirmó · llamar", action: "Ver la cita" })
    // La hora sale con el formato de la clínica; el día, en su zona.
    expect(waitingText({
      kind: "unconfirmed", why: "sin_confirmar", id: "a1", patientId: "p1", patientName: "Rosa Quispe", phone: "+51 987 654 100",
      startsAt: "2026-10-13T15:30:00.000Z", branchName: "Centro", serviceName: "Evaluación",
    }, context).detail).toMatch(/^\+51 987 654 100 · Cita mañana 10:30.* · Evaluación · Centro$/)
  })

  it("quien no recibe recordatorios sale el día antes para llamarla (ADR 0040)", () => {
    const row = waitingText({
      kind: "unconfirmed", why: "sin_recordatorios", id: "a1", patientId: "p1", patientName: "Lucía", phone: "+51 987 654 100",
      startsAt: "2026-10-13T15:00:00.000Z", branchName: "Centro", serviceName: null,
    }, context)
    expect(row.title).toMatch(/^Lucía no recibe recordatorios: llámala para confirmar su cita de mañana 10:00/)
    expect(row.action).toBe("Ver la cita")
  })

  it("una atención de otro día sin cerrar dice de quién es, cuándo empezó y qué le falta", () => {
    const stale: WaitingRow = {
      kind: "staleEncounter", id: "e1", patientId: "p1", patientName: "Lucía Fernández",
      startedAt: "2026-10-11T15:04:00.000Z", missing: ["diagnosis", "evolution"],
    }
    const text = waitingText(stale, context)
    expect(text).toMatchObject({ title: "La atención de Lucía Fernández quedó sin cerrar", action: "Continuar" })
    // La hora va en el formato de la clínica; el día, contado en su zona.
    expect(text.detail).toMatch(/^ayer 10:04.* · le falta el diagnóstico y la evolución$/)
    expect(waitingText({ ...stale, missing: [] }, context).detail).toMatch(/ · lista para firmar$/)
  })

  it("un presupuesto armado que nadie envió dice de quién es, desde cuándo y cuánto: «Enviar»", () => {
    const unsent: WaitingRow = {
      kind: "unsentBudget", id: "b1", patientId: "p1", patientName: "Lucía Fernández",
      since: "2026-10-11T20:00:00.000Z", itemCount: 3, totalCents: 54000, currency: "PEN", options: 1,
    }
    const text = waitingText(unsent, context)
    expect(text).toMatchObject({ title: "Presupuesto de Lucía Fernández sin enviar", action: "Enviar" })
    expect(text.detail).toMatch(/^Armado ayer · 3 tratamientos · S\/\s?540\.00$/)
    expect(waitingText({ ...unsent, options: 2 }, context).detail).toMatch(/ · 2 opciones$/)
    expect(waitingText({ kind: "more", of: "unsentBudgets", count: 2 }, context).title).toBe("2 presupuestos más sin enviar")
  })

  it("lo que dejaron «Su enlace» y el portal dice qué hacer, sin datos de la otra ficha", () => {
    const createdAt = new Date(Date.now() - 20 * 60_000).toISOString()
    const duplicate: WaitingRow = {
      kind: "possibleDuplicate", id: "t1", source: "enlace", patientId: "p1", personId: null, patientName: "Pedro Ríos", personName: null,
      detail: "El documento ya está en otra ficha", createdAt,
    }
    expect(waitingText(duplicate, context)).toEqual({
      title: "Posible ficha repetida: Pedro Ríos", detail: "Desde su enlace hace 20 min · El documento ya está en otra ficha", action: "Revisar",
    })
    // Alguien se registró en línea con el documento de una persona que ya estaba.
    const held: WaitingRow = { ...duplicate, id: "t3", source: "registro", patientId: null, personId: "c1", patientName: "Rosa Ochoa", detail: "Escribió: Juan, +51999" }
    expect(waitingText(held, context)).toEqual({
      title: "Alguien se registró con el documento de Rosa Ochoa: revisa si es ella",
      detail: "Desde el registro en línea hace 20 min · Escribió: Juan, +51999",
      action: "Ver a Rosa Ochoa",
    })
    // La fila lleva a la persona; el botón la descarta.
    expect(duplicateActions(held as Extract<WaitingRow, { kind: "possibleDuplicate" }>).map((action) => action.label)).toEqual(["Descartar"])
    // El registro de un menor nombró como representante a alguien que ya estaba.
    const representative: WaitingRow = { ...duplicate, id: "t4", source: "representante", personId: "c2", personName: "Rosa Ochoa", patientName: "Sofía Ochoa", detail: "" }
    expect(waitingText(representative, context).title).toBe("¿Rosa Ochoa es representante de Sofía Ochoa?")
    // Confirmar la vincula; «No es ella» la descarta sin vincular.
    expect(duplicateActions(representative as Extract<WaitingRow, { kind: "possibleDuplicate" }>)).toEqual([
      { id: "confirmar", label: "Confirmar", primary: true },
      { id: "descartar", label: "No es ella", primary: false },
    ])
    expect(duplicateActions(duplicate as Extract<WaitingRow, { kind: "possibleDuplicate" }>).map((action) => action.id)).toEqual(["revisada"])
    const reentry: WaitingRow = { kind: "portalReentry", id: "t2", patientId: "p2", contactName: "Lucía Fernández", grantId: "g1", createdAt }
    expect(waitingText(reentry, context)).toEqual({
      title: "Lucía Fernández quiere volver a entrar al portal", detail: "Lo pidió hace 20 min · su acceso sigue vigente", action: "Enviar nuevo enlace",
    })
    expect(waitingKey(reentry)).toBe("portalReentry:t2")
  })

  it("el inventario de una sede dice qué hace falta y qué venció, con un solo nombre por sede", () => {
    const row: WaitingRow = {
      kind: "inventory", branchId: "b1", branchName: "Sede Miraflores", needed: 4,
      neededNames: ["Guantes de nitrilo", "Resina A2", "Rollos de algodón"],
      expiredLots: 1, expired: [{ productName: "Lidocaína 2%", expiresAt: "2026-10-09" }],
    }
    expect(waitingText(row, context)).toEqual({
      title: "Inventario de Sede Miraflores: 4 productos hacen falta y 1 lote venció",
      detail: "Guantes de nitrilo, Resina A2 y Rollos de algodón y 1 más · Lidocaína 2% venció el 9 oct",
      action: "Ver qué hace falta",
    })
    // Solo lo vencido: la fila lleva a lo que vence.
    expect(waitingText({ ...row, needed: 0, neededNames: [] }, context)).toMatchObject({
      title: "Inventario de Sede Miraflores: 1 lote venció", action: "Ver lo vencido",
    })
    expect(waitingKey(row)).toBe("inventory:b1")
  })

  it("el día se cuenta en la zona de la clínica, no en la del navegador", () => {
    // 03:00 UTC del 12 es todavía el 11 en Lima.
    expect(daysAgo("2026-10-12T03:00:00.000Z", context)).toBe("ayer")
    expect(daysAgo("2026-10-12T15:00:00.000Z", context)).toBe("hoy")
    expect(daysAgo("2026-10-03T15:00:00.000Z", context)).toBe("hace 9 días")
  })

  it("los resúmenes concuerdan en número", () => {
    expect(waitingText({ kind: "conversations", waiting: 1, oldestAt: null }, context).title).toBe("1 persona espera respuesta")
    expect(waitingText({ kind: "conversations", waiting: 5, oldestAt: null }, context).title).toBe("5 personas esperan respuesta")
    expect(waitingText({ kind: "budgets", total: 4, oldestPresentedAt: "2026-10-03T15:00:00.000Z", items: [] }, context)).toEqual({
      title: "4 presupuestos esperan respuesta", detail: "El más antiguo se presentó hace 9 días", action: "Ver cuáles",
    })
    expect(waitingText({ kind: "more", of: "cases", count: 1 }, context).title).toBe("1 caso más de Sofi")
    expect(waitingText({ kind: "conversations", waiting: 3, oldestAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }, context)).toMatchObject({
      detail: "La más antigua, hace 2 h", action: "Abrir Bandeja",
    })
    expect(waitingText({ kind: "more", of: "tasks", count: 4 }, context).detail).toBe("Tuyas y de tu área")
  })
})

describe("resumen de hoy", () => {
  it("escribe el resumen de la agenda y calla lo que está en cero", () => {
    // La sala va siempre; «en atención», solo si hay alguien (tablero 7).
    expect(agendaSummary({ total: 12, waiting: 2, attending: 0, attended: 4, upcoming: 6, unconfirmed: 2 })).toBe("12 citas · 2 en sala · 4 atendidas · 6 por venir")
    expect(agendaSummary({ total: 3, waiting: 0, attending: 1, attended: 1, upcoming: 1, unconfirmed: 0 })).toBe("3 citas · 0 en sala · 1 en atención · 1 atendida · 1 por venir")
    expect(patientsSummary({ total: 8, waiting: 1, attending: 0, attended: 2, upcoming: 5, unconfirmed: 1 })).toBe("8 pacientes · 1 en sala · 2 atendidos · 5 por venir")
    expect(attendedPercent({ total: 24, attended: 6 })).toBe(25)
    expect(attendedPercent({ total: 0, attended: 0 })).toBe(0)
  })

  it("escribe el día con mayúscula inicial y sin coma", () => {
    expect(longDay("2026-10-12", "es-PE")).toBe("Lunes 12 de octubre")
  })
})
