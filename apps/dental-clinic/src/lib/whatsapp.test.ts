import { describe, expect, it } from "vitest"
import type { ConnectionItem } from "./crm"
import { sinceWords } from "./integrations"
import {
  accountWords,
  approvedValues,
  type ClinicMessage,
  closedWindowNotice,
  connectionPending,
  connectionWords,
  countWords,
  dataToken,
  insertAtCursor,
  type MessageData,
  type MessageTextState,
  messageGroups,
  messageRow,
  messageSource,
  messagesSummary,
  ownMessageData,
  previewText,
  setupStep,
  statusDetail,
  statusWords,
  toFieldText,
  toServerBody,
} from "./whatsapp"

const NOW = Date.parse("2026-10-13T15:00:00Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const since = (iso: string) => sinceWords(iso, NOW, "es-PE", "America/Lima")

const PERSONA: MessageData = { key: "persona", label: "Nombre de la persona", example: "Lucía", required: true }
const LUGAR: MessageData = { key: "lugar", label: "Clínica y sede", example: "Clínica Sonríe, sede Centro", required: true }
const CLINICA: MessageData = { key: "clinica", label: "Nombre de la clínica", example: "Clínica Sonríe", required: true }

function text(patch: Partial<MessageTextState> = {}): MessageTextState {
  return {
    body: "Hola, {{persona}}. Te escribimos de {{clinica}}.",
    previewParts: [
      { text: "Hola, ", data: false },
      { text: "Lucía", data: true },
      { text: ". Te escribimos de ", data: false },
      { text: "Clínica Sonríe", data: true },
      { text: ".", data: false },
    ],
    status: "aprobada",
    statusLabel: "Aprobado",
    reason: null,
    since: null,
    isDefault: true,
    ...patch,
  }
}

function message(patch: Partial<ClinicMessage> = {}): ClinicMessage {
  return {
    id: "recordatorio_cita",
    origin: "agente",
    title: "Recordar la cita",
    when: "Un día antes de la cita.",
    line: { key: "recordatorio_cita", title: "Recordar la cita", enabled: true },
    current: text(),
    pending: null,
    buttons: [{ title: "Confirmar", does: "La cita queda confirmada al momento." }],
    variables: [PERSONA, CLINICA],
    category: "Utilidad",
    promotion: false,
    unsendable: null,
    meanwhile: null,
    editable: true,
    deletable: false,
    canRevert: false,
    ...patch,
  }
}

function connection(patch: Partial<ConnectionItem> = {}): ConnectionItem {
  return {
    id: "c1",
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "Clínica",
    externalId: "100200",
    status: "active",
    capabilities: null,
    webhookUrl: "https://api.test/api/webhooks/channels/whatsapp_cloud_api/c1",
    createdAt: minutesAgo(5000),
    updatedAt: minutesAgo(5000),
    webhookVerifiedAt: minutesAgo(4000),
    lastInboundAt: minutesAgo(12),
    ...patch,
  }
}

describe("el texto de un mensaje: datos por nombre y datos entre corchetes", () => {
  const data = [PERSONA, LUGAR]
  const body = "Hola, {{persona}}. Te recordamos la cita en {{lugar}}. Responde a este mensaje."

  it("al campo llega cada dato como su nombre entre corchetes, y vuelve igual al servidor", () => {
    const field = toFieldText(body, data)
    expect(field).toBe("Hola, [Nombre de la persona]. Te recordamos la cita en [Clínica y sede]. Responde a este mensaje.")
    expect(toServerBody(field, data)).toBe(body)
  })

  it("lo que la persona mueve o reescribe sigue siendo el mismo dato", () => {
    expect(toServerBody("Estimada [Nombre de la persona]: su cita es en [Clínica y sede].", data)).toBe(
      "Estimada {{persona}}: su cita es en {{lugar}}.",
    )
    // Escrito a mano, sin tilde, con otras mayúsculas y con espacios de más.
    expect(toServerBody("Cita en [ clinica  y SEDE ] para [nombre de la persona]", data)).toBe("Cita en {{lugar}} para {{persona}}")
  })

  it("unos corchetes que no nombran un dato del mensaje son texto", () => {
    expect(toServerBody("Trae tu [documento] y llega [10 minutos] antes, [Nombre de la persona].", data)).toBe(
      "Trae tu [documento] y llega [10 minutos] antes, {{persona}}.",
    )
    // Un dato de otro mensaje no es de este.
    expect(toServerBody("Te espera [Nombre de la clínica].", data)).toBe("Te espera [Nombre de la clínica].")
  })

  it("un dato que el mensaje no declara llega al campo como vino: el servidor dirá qué hacer", () => {
    expect(toFieldText("Hola, {{persona}}. Tu saldo es {{saldo}}.", data)).toBe("Hola, [Nombre de la persona]. Tu saldo es {{saldo}}.")
    expect(toServerBody("Tu saldo es {{saldo}}.", data)).toBe("Tu saldo es {{saldo}}.")
  })

  it("acepta el dato escrito con espacios dentro de las llaves y conserva los saltos de línea", () => {
    expect(toFieldText("Hola, {{ persona }}.\n\nGracias.", data)).toBe("Hola, [Nombre de la persona].\n\nGracias.")
    expect(toServerBody("Hola, [Nombre de la persona].\n\nGracias.", data)).toBe("Hola, {{persona}}.\n\nGracias.")
  })

  it("un dato repetido viaja repetido: la regla la dice el servidor, no la pantalla", () => {
    expect(toServerBody("[Nombre de la persona], [Nombre de la persona]", data)).toBe("{{persona}}, {{persona}}")
  })

  it("«Poner…» inserta el dato donde está el cursor o sobre lo seleccionado", () => {
    const token = dataToken(PERSONA.label)
    expect(token).toBe("[Nombre de la persona]")
    expect(insertAtCursor("Hola, . Gracias", token, 6)).toEqual({ text: "Hola, [Nombre de la persona]. Gracias", cursor: 28 })
    expect(insertAtCursor("Hola, AQUI.", token, 6, 10)).toEqual({ text: "Hola, [Nombre de la persona].", cursor: 28 })
    // Un cursor fuera del texto no rompe nada: se pone al final.
    expect(insertAtCursor("Hola", token, 99)).toEqual({ text: "Hola[Nombre de la persona]", cursor: 26 })
    expect(insertAtCursor("", token, 0)).toEqual({ text: token, cursor: token.length })
  })

  it("un mensaje nuevo puede llevar los datos de los que envía el equipo, ninguno obligatorio", () => {
    const resume = message({ id: "retomar_conversacion", origin: "bandeja", line: null, variables: [PERSONA, CLINICA] })
    expect(ownMessageData([message(), resume])).toEqual([
      { ...PERSONA, required: false },
      { ...CLINICA, required: false },
    ])
    // Sin ninguno del equipo en la lista no se supone qué datos hay.
    expect(ownMessageData([message()])).toEqual([])
  })
})

describe("la lista de mensajes", () => {
  it("separa los que envía el agente de los que envía el equipo", () => {
    const items = [
      message(),
      message({ id: "retomar_conversacion", origin: "bandeja", line: null }),
      message({ id: "m1", origin: "clinica", line: null }),
      message({ id: "t1", origin: "cuenta", line: null }),
    ]
    const groups = messageGroups(items)
    expect(groups.agent.map((item) => item.id)).toEqual(["recordatorio_cita"])
    expect(groups.team.map((item) => item.id)).toEqual(["retomar_conversacion", "m1", "t1"])
  })

  it("los automáticos dicen cómo está su línea; los demás, de dónde vienen", () => {
    expect(messageSource(message())).toBe("Línea prendida")
    expect(messageSource(message({ line: { key: "x", title: "X", enabled: false } }))).toBe("Línea apagada")
    expect(messageSource(message({ origin: "bandeja", line: null }))).toBe("Viene con odentIA")
    expect(messageSource(message({ origin: "clinica", line: null }))).toBe("Lo creó la clínica")
    expect(messageSource(message({ origin: "cuenta", line: null }))).toBe("Ya estaba en tu cuenta")
  })

  it("la fila muestra el comienzo del texto con datos de ejemplo y el estado con las palabras del servidor", () => {
    const row = messageRow(message(), since)
    expect(row.preview).toBe("Hola, Lucía. Te escribimos de Clínica Sonríe.")
    expect(previewText(message().current.previewParts)).toBe(row.preview)
    expect(row).toMatchObject({ source: "Línea prendida", status: "Aprobado", tone: "ok", note: null })
  })

  it("en revisión dice desde cuándo y qué pasa mientras tanto, con la frase del servidor", () => {
    const meanwhile = "Mientras tanto sale como respuesta a quien escribió en las últimas 24 horas, o por correo."
    const item = message({
      current: text({ status: "en_revision", statusLabel: "En revisión", since: minutesAgo(60 * 30) }),
      meanwhile,
    })
    expect(messageRow(item, since)).toMatchObject({
      status: "En revisión desde ayer",
      tone: "waiting",
      note: { text: meanwhile, tone: "muted" },
    })
    // Sin fecha no se inventa un «desde».
    expect(statusWords({ status: "en_revision", statusLabel: "En revisión", since: null }, since)).toBe("En revisión")
    // Solo «en revisión» lleva el «desde» en la fila.
    expect(statusWords({ status: "aprobada", statusLabel: "Aprobado", since: minutesAgo(10) }, since)).toBe("Aprobado")
  })

  it("un cambio de texto en revisión o rechazado se dice en la misma fila", () => {
    const waiting = message({
      pending: text({ status: "en_revision", statusLabel: "En revisión", isDefault: false }),
      meanwhile: "Tu cambio de texto está en revisión; sigue saliendo el anterior.",
    })
    expect(messageRow(waiting, since)).toMatchObject({
      status: "Aprobado",
      note: { text: "Tu cambio de texto está en revisión; sigue saliendo el anterior.", tone: "waiting" },
    })
    const rejected = message({
      pending: text({ status: "rechazada", statusLabel: "Rechazado", isDefault: false }),
      meanwhile: "WhatsApp no aceptó el cambio: sigue saliendo el texto anterior.",
    })
    expect(messageRow(rejected, since).note).toEqual({
      text: "WhatsApp no aceptó el cambio: sigue saliendo el texto anterior.",
      tone: "danger",
    })
  })

  it("rechazado o retirado invita a ver el motivo; aprobado con la línea apagada dice que está listo", () => {
    const rejected = message({
      current: text({ status: "rechazada", statusLabel: "Rechazado", reason: "WhatsApp lo considera promocional" }),
      meanwhile: "Mientras tanto sale como respuesta a quien escribió en las últimas 24 horas, o por correo.",
    })
    expect(messageRow(rejected, since)).toMatchObject({ tone: "danger", note: { text: "Ver el motivo y qué hacer", tone: "danger" } })
    const retired = message({ current: text({ status: "deshabilitada", statusLabel: "Retirado por WhatsApp" }) })
    expect(messageRow(retired, since)).toMatchObject({ tone: "off", note: { text: "Ver el motivo y qué hacer", tone: "danger" } })
    const ready = message({ line: { key: "x", title: "X", enabled: false } })
    expect(messageRow(ready, since).note).toEqual({ text: "Listo para cuando la prendas", tone: "muted" })
  })

  it("el resumen cuenta el texto vigente de cada mensaje, en singular y en plural", () => {
    const items = [
      message(),
      message({ id: "b" }),
      message({ id: "c", current: text({ status: "en_revision", statusLabel: "En revisión" }) }),
      message({ id: "d", current: text({ status: "rechazada", statusLabel: "Rechazado" }) }),
      message({ id: "e", current: text({ status: "sin_pedir", statusLabel: "Sin pedir a WhatsApp" }) }),
    ]
    expect(messagesSummary(items)).toBe("2 aprobados · 1 en revisión · 1 rechazado · 1 sin pedir")
    expect(messagesSummary([message()])).toBe("1 aprobado")
    expect(messagesSummary([])).toBe("")
  })

  it("un mensaje abierto dice desde cuándo, con qué texto y cómo lo cuenta WhatsApp", () => {
    expect(statusDetail(message({ current: text({ since: minutesAgo(60 * 30) }) }), since)).toBe(
      "Desde ayer, con el texto que trae odentIA. WhatsApp lo cuenta como mensaje de utilidad.",
    )
    expect(statusDetail(message({ current: text({ isDefault: false }) }), since)).toBe(
      "Con el texto de la clínica. WhatsApp lo cuenta como mensaje de utilidad.",
    )
    // Uno propio no tiene un texto de odentIA con el que compararse.
    expect(statusDetail(message({ origin: "clinica", line: null, category: "Marketing", current: text({ isDefault: false }) }), since)).toBe(
      "WhatsApp lo cuenta como mensaje de marketing.",
    )
    // Lo que WhatsApp todavía no recibió, o rechazó, no tiene un tipo que importe.
    expect(statusDetail(message({ current: text({ status: "sin_pedir", statusLabel: "Sin pedir a WhatsApp" }) }), since)).toBe(
      "Con el texto que trae odentIA.",
    )
    expect(statusDetail(message({ current: text({ status: "rechazada", statusLabel: "Rechazado", isDefault: false }) }), since)).toBe(
      "Con el texto de la clínica.",
    )
  })
})

describe("la conexión, en palabras", () => {
  it("conectada: el número y el nombre, que recibe y envía, y el último mensaje", () => {
    const words = connectionWords(
      connection({ health: { number: "+51 999 111 222", name: "Clínica Dental Smile", quality: "alta", dailyLimit: 1000, unlimited: false } }),
      since,
    )
    expect(words).toMatchObject({
      title: "+51 999 111 222 · Clínica Dental Smile",
      tone: "ok",
      status: "Conectado.",
      detail: "Recibe y envía. Último mensaje recibido hace 12 minutos.",
    })
    expect(words.facts).toEqual([
      "Calidad del número: alta",
      `Puede escribirle primero a ${countWords(1000)} personas al día`,
    ])
    // Miles con espacio de no separación, sin punto ni coma.
    expect(countWords(1000)).toBe(`1${String.fromCharCode(0xa0)}000`)
    expect(countWords(250)).toBe("250")
  })

  it("lo que el servidor no entrega no se muestra ni se supone", () => {
    const bare = connectionWords(connection({ health: { quality: null, dailyLimit: null, unlimited: false } }), since)
    expect(bare.facts).toEqual([])
    // Sin número ni nombre de WhatsApp, lo que identifique la cuenta.
    expect(bare.title).toBe("Clínica")
    const unknown = connection({})
    delete unknown.lastInboundAt
    expect(connectionWords(unknown, since).detail).toBe("Recibe y envía.")
    expect(connectionWords(connection({ lastInboundAt: null }), since, null).detail).toBe(
      "Recibe y envía. Todavía no llegó ningún mensaje.",
    )
    expect(connectionWords(connection({ health: { unlimited: true, dailyLimit: null } }), since).facts).toEqual([
      "Puede escribirle primero a todas las personas que haga falta",
    ])
  })

  it("desconectada lo dice, sin calidad ni límite", () => {
    const words = connectionWords(connection({ status: "disabled", health: { quality: "alta", dailyLimit: 1000 } }), since)
    expect(words).toMatchObject({ tone: "off", status: "Desconectado.", facts: [] })
    expect(connectionPending(connection({ status: "disabled", webhookVerifiedAt: null, lastInboundAt: null }))).toBeNull()
  })

  it("a mano: una conexión a medias se retoma en el paso que falta", () => {
    expect(setupStep({ webhookVerifiedAt: null, lastInboundAt: null })).toBe(2)
    expect(setupStep({ webhookVerifiedAt: minutesAgo(5), lastInboundAt: null })).toBe(3)
    expect(setupStep({ webhookVerifiedAt: minutesAgo(5), lastInboundAt: minutesAgo(1) })).toBeNull()
    // Si ya llega un mensaje, la dirección funciona aunque no conste su verificación.
    expect(setupStep({ webhookVerifiedAt: null, lastInboundAt: minutesAgo(1) })).toBeNull()
    // Sin el dato de verificación no se supone que falte.
    expect(setupStep({ lastInboundAt: null })).toBeNull()

    const half = connection({ webhookVerifiedAt: null, lastInboundAt: null })
    expect(connectionPending(half)).toBe("address")
    expect(connectionWords(half, since, "address")).toMatchObject({ tone: "pending", status: "Falta un paso." })
    // La lectura más reciente del alta manda sobre lo que traía la lista.
    expect(connectionPending(half, { webhookVerifiedAt: minutesAgo(1), lastInboundAt: null })).toBe("first-message")
    expect(connectionPending(half, { webhookVerifiedAt: minutesAgo(2), lastInboundAt: minutesAgo(1) })).toBeNull()
    expect(connectionWords(half, since, "first-message")).toMatchObject({
      tone: "ok",
      detail: "Meta ya verificó la dirección. Todavía no llegó ningún mensaje.",
    })
  })

  it("con el botón de Facebook no hay dirección que copiar: solo falta lo que el servidor dejó pendiente", () => {
    const signup = { grantedAt: minutesAgo(5), subscribedAt: minutesAgo(5), registeredAt: minutesAgo(5), pending: [] }
    const done = connection({ webhookVerifiedAt: null, lastInboundAt: null, signup })
    expect(connectionPending(done)).toBeNull()
    expect(connectionWords(done, since, null).detail).toBe("Recibe y envía. Todavía no llegó ningún mensaje.")
    const waiting = connection({
      webhookVerifiedAt: null,
      lastInboundAt: null,
      signup: { ...signup, registeredAt: null, pending: [{ step: "registrar", title: "Falta registrar el número en WhatsApp.", problem: null }] },
    })
    expect(connectionPending(waiting)).toBe("signup")
    expect(connectionWords(waiting, since, "signup")).toMatchObject({ tone: "pending", status: "Falta un paso." })
  })

  it("la cuenta que encontró WhatsApp se dice con lo que entregue", () => {
    expect(accountWords({ number: "+51 999 111 222", name: "Clínica Dental Smile" })).toBe("+51 999 111 222 · Clínica Dental Smile")
    expect(accountWords({ number: null, name: "Clínica Dental Smile" })).toBe("Clínica Dental Smile")
    expect(accountWords({ number: " ", name: null })).toBeNull()
    expect(accountWords(null)).toBeNull()
  })
})

describe("Bandeja, pasadas las 24 horas", () => {
  it("dice cuándo escribió la persona por última vez, antes de escribir", () => {
    expect(closedWindowNotice("Lucía Paredes", minutesAgo(60 * 24 * 2), since)).toEqual({
      lead: "Pasaron 24 horas desde su último mensaje: Lucía Paredes escribió hace 2 días.",
      rest: "Ahora WhatsApp solo deja enviarle un mensaje aprobado. Cuando responda, podrás escribirle con libertad.",
    })
  })

  it("si nunca escribió lo dice; si el servidor no dio la fecha, no supone ninguna de las dos cosas", () => {
    expect(closedWindowNotice("Lucía Paredes", null, since).lead).toBe("Lucía Paredes todavía no escribió por aquí.")
    expect(closedWindowNotice("Lucía Paredes", undefined, since).lead).toBe("Pasaron 24 horas desde su último mensaje.")
    expect(closedWindowNotice("Lucía Paredes", "no es una fecha", since).lead).toBe(
      "Pasaron 24 horas desde su último mensaje.",
    )
  })

  it("los datos que escribe quien envía viajan en el orden que pide el mensaje", () => {
    const fields = [
      { index: 2, label: "Dato 2" },
      { index: 1, label: "Dato 1" },
    ]
    expect(approvedValues({ fields }, { 1: " 20 % en limpiezas ", 2: "octubre" })).toEqual(["20 % en limpiezas", "octubre"])
    // Lo que falta viaja vacío: el servidor dice qué completar.
    expect(approvedValues({ fields }, { 2: "octubre" })).toEqual(["", "octubre"])
    // Un mensaje que no pide datos no envía ninguno.
    expect(approvedValues({ fields: [] }, { 1: "sobra" })).toBeUndefined()
  })
})
