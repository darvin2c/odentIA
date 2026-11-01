import { describe, expect, it } from "vitest"
import { agendaSummary, attendedPercent, caseAdds, daysAgo, longDay, patientsSummary, repliable, waitingKey, waitingText, type HomeTextContext } from "./home"
import type { WaitingRow } from "./workspace"

const context: HomeTextContext = { today: "2026-10-12", timezone: "America/Lima", locale: "es-PE", allTasks: false, receptionName: "Sofi" }
const task = (patch: Partial<Extract<WaitingRow, { kind: "task" }>>): WaitingRow => ({
  kind: "task", id: "t1", title: "Llamar a Mateo Huamán por su presupuesto", dueAt: null, due: "none",
  href: "/tasks?task=t1", mine: true, assigneeName: "Rosa", opportunityTitle: null, more: 0, ...patch,
})

describe("lo que el panel dice del caso", () => {
  const person = (text: string) => ({ from: "person", text })
  it("dice la pregunta si es anterior a los mensajes a la vista", () => {
    expect(caseAdds({ reason: "No pudo sustentar un dato", quote: "¿Atienden los sábados?" }, [person("Sí"), { from: "agent", text: "¿Atienden los sábados?" }])).toEqual({ quoteHidden: true, reasonAdds: true })
  })
  it("no repite lo que ya se ve, aunque cambien los espacios", () => {
    expect(caseAdds({ reason: "¿Atienden  los\nsábados?", quote: "¿Atienden los sábados?" }, [person("¿Atienden   los sábados?\n")])).toEqual({ quoteHidden: false, reasonAdds: false })
  })
  it("distingue textos que solo difieren en una letra «s»", () => {
    expect(caseAdds({ reason: "Pide precios", quote: "¿Y los precios?" }, [person("¿Y lo precio?")])).toEqual({ quoteHidden: true, reasonAdds: true })
  })
  it("sin mensajes a la vista, la pregunta ya la muestra el panel", () => {
    expect(caseAdds({ reason: "Pregunta por su pago", quote: "¿Llegó?" }, [])).toEqual({ quoteHidden: false, reasonAdds: true })
  })
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

  it("una cita sin cerrar le dice a quien no registra atenciones quién lo hace si vino", () => {
    const row: WaitingRow = {
      kind: "unclosed", id: "a1", patientId: "p1", patientName: "Elena Huamán", startsAt: "2026-10-11T15:00:00.000Z",
      professionalUserId: "u1", professionalName: "Dra. Ana Torres", serviceName: "Control", branchName: "Miraflores",
    }
    expect(waitingText(row, { ...context, canAttend: true }).detail).toBe("Dra. Ana Torres · Control")
    expect(waitingText(row, { ...context, canAttend: false }).detail).toBe("Si vino, la registra Dra. Ana Torres · Control")
  })

  it("un pedido sobre sus datos dice qué pidió, hasta cuándo y si falta comprobar que es ella (ADR 0080)", () => {
    const row: WaitingRow = {
      kind: "dataRequest", id: "r1", patientId: "p1", patientName: "Rosa Quispe", request: "copia", dueOn: "2026-10-15", verified: false,
    }
    expect(waitingText(row, context)).toEqual({
      title: "Rosa Quispe",
      ask: "Pidió una copia de su historia",
      detail: "Responder hasta el jueves 15 oct · falta comprobar que es ella",
      action: "Atender el pedido",
    })
    expect(waitingText({ ...row, verified: true }, context).detail).toBe("Responder hasta el jueves 15 oct")
    expect(waitingKey(row)).toBe("dataRequest:r1")
  })

  it("un caso del agente dice quién, qué preguntó y quién se lo pasó; la urgencia la dice su grupo", () => {
    const row: WaitingRow = {
      kind: "case", id: "h1", priority: "alta", reason: "pregunta por un reembolso", contactName: "Lucía Paredes", channel: null,
      createdAt: new Date(Date.now() - 25 * 60_000).toISOString(), conversationId: "c1", taskId: "t1", unclaimed: true, canReply: true,
    }
    expect(waitingText(row, context)).toEqual({
      title: "Lucía Paredes", ask: "pregunta por un reembolso", detail: "Te lo pasó Sofi hace 25 min", action: "Responder",
    })
    // Lo que preguntó dice más que el motivo.
    expect(waitingText({ ...row, quote: "¿Me devuelven lo que pagué?" }, context).ask).toBe("¿Me devuelven lo que pagué?")
    expect(repliable(row)).toBe(true)
    expect(repliable({ ...row, canReply: false })).toBe(false)
  })

  it("un caso dice «Responder» si se puede; si lo tiene otra persona, con quién está y ningún botón", () => {
    const row: WaitingRow = {
      kind: "case", id: "h1", priority: "alta", reason: "pregunta por un reembolso", contactName: "Lucía Paredes", channel: null,
      createdAt: new Date().toISOString(), conversationId: "c1", taskId: "t1", unclaimed: true,
    }
    expect(waitingText({ ...row, canReply: true }, context).action).toBe("Responder")
    expect(waitingText({ ...row, canReply: false, windowClosed: true }, context).action).toBe("Escribirle")
    const other = waitingText({ ...row, unclaimed: false, assigneeName: "Dr. Luis Prado" }, context)
    expect(other.action).toBe("")
    expect(other.detail).toContain("Con Dr. Luis Prado")
    // Sin conversación, lo que se abre es su tarea.
    expect(waitingText({ ...row, conversationId: null }, context).action).toBe("Ver la tarea")
    expect(waitingText(task({}), context).action).toBe("Abrir")
  })

  it("una cita que no confirmó tras el recordatorio pide llamar, con el teléfono a la vista", () => {
    const text = waitingText({
      kind: "unconfirmed", why: "sin_confirmar", id: "a1", patientId: "p1", patientName: "Rosa Quispe", phone: "+51 987 654 100",
      startsAt: "2026-10-13T15:30:00.000Z", branchName: "Centro", serviceName: "Evaluación",
    }, context)
    expect(text).toMatchObject({ title: "Rosa Quispe", action: "Llamar" })
    // La hora sale con el formato de la clínica; el día, en su zona.
    expect(text.ask).toMatch(/^No confirmó su cita de mañana 10:30/)
    expect(text.detail).toBe("+51 987 654 100 · Evaluación · Centro")
  })

  it("quien no recibe recordatorios sale el día antes para llamarla (ADR 0040)", () => {
    const row = waitingText({
      kind: "unconfirmed", why: "sin_recordatorios", id: "a1", patientId: "p1", patientName: "Lucía", phone: "+51 987 654 100",
      startsAt: "2026-10-13T15:00:00.000Z", branchName: "Centro", serviceName: null,
    }, context)
    expect(row.ask).toMatch(/^No recibe recordatorios: confirma su cita de mañana 10:00/)
    expect(row.action).toBe("Llamar")
  })

  it("una atención de otro día sin cerrar dice de quién es, cuándo empezó y qué le falta", () => {
    const stale: WaitingRow = {
      kind: "staleEncounter", id: "e1", patientId: "p1", patientName: "Lucía Fernández",
      startedAt: "2026-10-11T15:04:00.000Z", missing: ["diagnosis", "evolution"],
    }
    const text = waitingText(stale, context)
    expect(text).toMatchObject({ title: "Lucía Fernández", action: "Revisar", detail: "Falta el diagnóstico y la evolución" })
    // La hora va en el formato de la clínica; el día, contado en su zona.
    expect(text.ask).toMatch(/^Su atención de ayer a las 10:04.* quedó sin firmar$/)
    expect(waitingText({ ...stale, missing: [] }, context).detail).toBe("Lista para firmar")
  })

  it("un presupuesto armado que nadie envió dice de quién es, desde cuándo y cuánto: «Enviar»", () => {
    const unsent: WaitingRow = {
      kind: "unsentBudget", id: "b1", patientId: "p1", patientName: "Lucía Fernández",
      since: "2026-10-11T20:00:00.000Z", itemCount: 3, totalCents: 54000, currency: "PEN", options: 1,
    }
    const text = waitingText(unsent, context)
    expect(text).toMatchObject({ title: "Lucía Fernández", ask: "Su presupuesto sigue sin enviar", action: "Enviar" })
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
      title: "Pedro Ríos", ask: "Posible ficha repetida", detail: "Desde su enlace hace 20 min", action: "Revisar",
    })
    // Alguien se registró en línea con el documento de una persona que ya estaba.
    const held: WaitingRow = { ...duplicate, id: "t3", source: "registro", patientId: null, personId: "c1", patientName: "Rosa Ochoa", detail: "Escribió: Juan, +51999" }
    expect(waitingText(held, context)).toEqual({
      title: "Rosa Ochoa",
      ask: "Alguien se registró con su documento: revisa si es la misma persona",
      detail: "Desde el registro en línea hace 20 min",
      action: "Revisar",
    })
    // El registro de un menor nombró como representante a alguien que ya estaba.
    const representative: WaitingRow = { ...duplicate, id: "t4", source: "representante", personId: "c2", personName: "Rosa Ochoa", patientName: "Sofía Ochoa", detail: "" }
    expect(waitingText(representative, context)).toMatchObject({ title: "Rosa Ochoa", ask: "¿Es representante de Sofía Ochoa?" })
    const reentry: WaitingRow = { kind: "portalReentry", id: "t2", patientId: "p2", contactName: "Lucía Fernández", grantId: "g1", createdAt }
    expect(waitingText(reentry, context)).toEqual({
      title: "Lucía Fernández", ask: "Quiere volver a entrar al portal", detail: "Lo pidió hace 20 min · su acceso sigue vigente", action: "Enviar nuevo enlace",
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
      title: "Inventario de Sede Miraflores",
      detail: "4 productos hacen falta y 1 lote venció",
      action: "Pedir",
    })
    // Solo lo vencido: no hay nada que pedir.
    expect(waitingText({ ...row, needed: 0, neededNames: [] }, context)).toMatchObject({ detail: "1 lote venció", action: "Ver" })
    expect(waitingKey(row)).toBe("inventory:b1")
  })

  it("el día se cuenta en la zona de la clínica, no en la del navegador", () => {
    // 03:00 UTC del 12 es todavía el 11 en Lima.
    expect(daysAgo("2026-10-12T03:00:00.000Z", context)).toBe("ayer")
    expect(daysAgo("2026-10-12T15:00:00.000Z", context)).toBe("hoy")
    expect(daysAgo("2026-10-03T15:00:00.000Z", context)).toBe("hace 9 días")
  })

  it("los resúmenes concuerdan en número", () => {
    expect(waitingText({ kind: "more", of: "conversations", count: 1 }, context).title).toBe("1 persona más espera respuesta")
    expect(waitingText({ kind: "more", of: "conversations", count: 5 }, context).title).toBe("5 personas más esperan respuesta")
    expect(waitingText({ kind: "budgets", total: 4, oldestPresentedAt: "2026-10-03T15:00:00.000Z", items: [] }, context)).toEqual({
      title: "4 presupuestos esperan respuesta", detail: "El más antiguo se presentó hace 9 días", action: "Ver",
    })
    expect(waitingText({ kind: "more", of: "cases", count: 1 }, context).title).toBe("1 caso más de Sofi")
    expect(waitingText({ kind: "person", conversationId: "c", contactId: "p", contactName: "Rosa Quispe", channel: "whatsapp", quote: "¿Atienden hoy?", since: new Date(Date.now() - 2 * 3_600_000).toISOString(), urgent: false, windowClosed: false }, context)).toMatchObject({
      title: "Rosa Quispe", ask: "¿Atienden hoy?", action: "Responder",
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
