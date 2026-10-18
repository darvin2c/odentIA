import { describe, expect, it } from "vitest"
import type { ConnectionItem } from "./crm"
import {
  awaitsAddress,
  CHANNEL_SETUP,
  channelRows,
  type MailState,
  mailNotice,
  mailRows,
  modelRow,
  rowShortWord,
  secretFields,
  sinceWords,
  validateIntegrationsSearch,
  webchatRows,
} from "./integrations"

const NOW = Date.parse("2026-10-13T15:00:00Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const since = (iso: string) => sinceWords(iso, NOW, "es-PE", "America/Lima")

/** Una conexión tal como la entregaba el servidor antes de añadir actividad y salud. */
function connection(patch: Partial<ConnectionItem>): ConnectionItem {
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
    ...patch,
  }
}

describe("hace cuánto, con palabras", () => {
  it("dice minutos, horas, ayer y días; después, la fecha", () => {
    expect(since(minutesAgo(0))).toBe("hace un momento")
    expect(since(minutesAgo(1))).toBe("hace 1 minuto")
    expect(since(minutesAgo(12))).toBe("hace 12 minutos")
    expect(since(minutesAgo(60))).toBe("hace 1 hora")
    expect(since(minutesAgo(60 * 30))).toBe("ayer")
    expect(since(minutesAgo(60 * 24 * 3))).toBe("hace 3 días")
    expect(since("2026-08-20T15:00:00Z")).toBe("el 20 de agosto")
    // El día es el de la clínica: las 03:00 UTC del 21 todavía son el 20 en Lima.
    expect(since("2026-08-21T03:00:00Z")).toBe("el 20 de agosto")
  })

  it("no afirma nada de una fecha ilegible o futura", () => {
    expect(since("no es una fecha")).toBe("")
    expect(since(new Date(NOW + 60_000).toISOString())).toBe("")
  })
})

describe("mensajería", () => {
  it("sin conexiones, los cuatro canales en orden y cada uno dice qué hace falta", () => {
    const rows = channelRows([], since)
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["WhatsApp", "Sin conectar"],
      ["Instagram", "Sin conectar"],
      ["Messenger", "Sin conectar"],
      ["Telegram", "Sin conectar"],
    ])
    expect(rows[3]?.detail).toEqual({ kind: "connect", needs: "la clave del bot, que da @BotFather." })
    expect(rows.every((row) => row.connection === null && row.tone === "off")).toBe(true)
    expect(rowShortWord(rows[1]!)).toEqual({ text: "Sin conectar", tone: "muted" })
  })

  it("WhatsApp conectado dice su número, su última actividad y lo que pide revisión", () => {
    const [whatsapp] = channelRows(
      [
        connection({
          lastInboundAt: minutesAgo(12),
          health: { number: "+51 999 000 111", name: "Clínica Dental Smile", quality: "alta", dailyLimit: 1000 },
          messages: { aprobados: 6, enRevision: 1, rechazados: 1, pausados: 0 },
        }),
      ],
      since,
    )
    expect(whatsapp).toMatchObject({
      tone: "ok",
      status: "Conectado",
      detail: {
        kind: "account",
        account: "+51 999 000 111",
        activity: "último mensaje hace 12 minutos · 6 mensajes aprobados · 1 en revisión",
      },
      review: [{ label: "1 mensaje rechazado", short: "1 rechazado", tone: "danger" }],
    })
    expect(rowShortWord(whatsapp!)).toEqual({ text: "1 rechazado", tone: "danger" })
  })

  it("lo que el servidor aún no entrega se omite: la fila sigue completa con lo que hay", () => {
    const [whatsapp] = channelRows([connection({})], since)
    expect(whatsapp).toMatchObject({
      status: "Conectado",
      review: [],
      detail: { kind: "account", account: "Clínica", activity: null },
      problem: null,
    })
    // Con el dato en `null` sí se sabe: todavía no llegó nada.
    const [quiet] = channelRows([connection({ lastInboundAt: null })], since)
    expect(quiet?.detail).toMatchObject({ activity: "todavía no llegó ningún mensaje" })
  })

  it("una fila por conexión del mismo canal", () => {
    const rows = channelRows([connection({ id: "a" }), connection({ id: "b", displayName: "Sede Norte" })], since)
    expect(rows.filter((row) => row.channel === "whatsapp").map((row) => row.connection?.id)).toEqual(["a", "b"])
    expect(rows).toHaveLength(5)
    expect(new Set(rows.map((row) => row.key)).size).toBe(5)
  })

  it("la fila es la misma antes y después de conectarla", () => {
    const before = channelRows([], since).find((row) => row.channel === "telegram")
    const after = channelRows([connection({ id: "t1", channel: "telegram" })], since).find((row) => row.channel === "telegram")
    expect(after?.key).toBe(before?.key)
  })

  it("Instagram y Messenger piden atención mientras Meta no verifique la dirección y no llegue nada", () => {
    const pending = connection({ channel: "messenger", provider: "messenger", displayName: "Página", webhookVerifiedAt: null, lastInboundAt: null })
    expect(awaitsAddress(pending)).toBe(true)
    const row = channelRows([pending], since).find((item) => item.channel === "messenger")
    expect(row).toMatchObject({ tone: "attention", status: "Necesita atención" })
    expect(row?.problem).toContain("dirección de avisos")
    expect(rowShortWord(row!)).toEqual({ text: "Resolver", tone: "warning" })

    // Sin el dato no se afirma; verificada o con mensajes, tampoco; Telegram no lo necesita.
    expect(awaitsAddress(connection({ channel: "messenger" }))).toBe(false)
    expect(awaitsAddress({ ...pending, webhookVerifiedAt: minutesAgo(5) })).toBe(false)
    expect(awaitsAddress({ ...pending, lastInboundAt: minutesAgo(5) })).toBe(false)
    expect(awaitsAddress({ ...pending, channel: "telegram" })).toBe(false)
  })

  it("una conexión desconectada conserva su cuenta y dice que no funciona", () => {
    const row = channelRows([connection({ channel: "telegram", provider: "telegram_bot_api", displayName: "@clinica_bot", status: "disabled" })], since).find(
      (item) => item.channel === "telegram",
    )
    expect(row).toMatchObject({
      tone: "off",
      status: "Desconectado",
      detail: { kind: "account", account: "@clinica_bot", activity: "no recibe ni envía mensajes" },
    })
  })

  it("un nombre igual al del canal no identifica la cuenta: se muestra su identificador", () => {
    const row = channelRows([connection({ channel: "telegram", displayName: "Telegram", externalId: "@clinica_bot" })], since).find(
      (item) => item.channel === "telegram",
    )
    expect(row?.detail).toMatchObject({ account: "@clinica_bot" })
  })

  it("los datos del panel se piden con palabras y «Cambiar la clave» solo pide las claves", () => {
    const labels = Object.values(CHANNEL_SETUP).flatMap((setup) => setup.fields.map((field) => field.label))
    // El nombre técnico del dato nunca es su etiqueta.
    for (const technical of ["pageId", "accessToken", "appSecret", "botToken", "instagramId", "token"]) {
      expect(labels.some((label) => label.includes(technical))).toBe(false)
    }
    expect(secretFields("messenger").map((field) => field.key)).toEqual(["pageAccessToken", "appSecret"])
    expect(secretFields("telegram").map((field) => field.key)).toEqual(["botToken"])
    expect(CHANNEL_SETUP.telegram.pasteAddress).toBe(false)
  })
})

describe("chat web", () => {
  const chat = { id: "w1", displayName: "Chat del sitio", status: "active", config: { allowedOrigins: ["https://clinica.test", "https://tienda.clinica.test"] } }

  it("sin chat, dice cómo conectarlo; con chat, su sitio y su actividad", () => {
    expect(webchatRows([], () => undefined, since)[0]).toMatchObject({ status: "Sin conectar", detail: { kind: "connect" } })
    const [row] = webchatRows([chat], () => minutesAgo(90), since)
    expect(row).toMatchObject({
      name: "Chat web",
      status: "Activo",
      detail: { kind: "account", account: "clinica.test y 1 sitio más", activity: "último mensaje hace 1 hora" },
    })
    // Sin fecha del servidor, solo el sitio.
    expect(webchatRows([chat], () => undefined, since)[0]?.detail).toMatchObject({ activity: null })
  })

  it("desactivado no recibe mensajes", () => {
    const [row] = webchatRows([{ ...chat, status: "disabled" }], () => minutesAgo(5), since)
    expect(row).toMatchObject({ tone: "off", status: "Desactivado", detail: { activity: "no recibe mensajes" } })
  })
})

describe("correo", () => {
  const providers: MailState["providers"] = [
    { provider: "gmail", label: "Gmail", channel: "email", configured: true },
    { provider: "microsoft365", label: "Microsoft 365", channel: "email", configured: true },
  ]
  const mailbox = { id: "m1", provider: "gmail" as const, email: "hola@clinica.test", displayName: "hola@clinica.test", synced: true, createdAt: minutesAgo(900), updatedAt: minutesAgo(900) }

  it("siempre dos filas: Gmail y Microsoft 365", () => {
    const rows = mailRows({ providers, connections: [] }, () => undefined, since)
    expect(rows.map((row) => [row.name, row.status, row.available])).toEqual([
      ["Gmail", "Sin conectar", true],
      ["Microsoft 365", "Sin conectar", true],
    ])
    expect(rows[1]?.detail).toEqual({ kind: "connect", needs: "entrar con la cuenta de Microsoft de la clínica." })
  })

  it("un buzón que dejó de estar activo necesita atención y dice quién pide autorizarlo", () => {
    const [gmail] = mailRows({ providers, connections: [{ ...mailbox, status: "disabled" }] }, () => undefined, since)
    expect(gmail).toMatchObject({
      tone: "attention",
      status: "Necesita atención",
      problem: "Google pide volver a autorizar el buzón.",
      detail: { kind: "account", account: "hola@clinica.test", activity: "no trae correo nuevo" },
    })
  })

  it("conectado: la última actividad si el servidor la entrega; si no, lo que ya se sabía del buzón", () => {
    const state = { providers, connections: [{ ...mailbox, status: "active" }] }
    expect(mailRows(state, () => minutesAgo(30), since)[0]?.detail).toMatchObject({ activity: "último correo hace 30 minutos" })
    expect(mailRows(state, () => undefined, since)[0]?.detail).toMatchObject({ activity: "lee el correo nuevo" })
    const fresh = { providers, connections: [{ ...mailbox, status: "active", synced: false }] }
    expect(mailRows(fresh, () => undefined, since)[0]?.detail).toMatchObject({ activity: "todavía no trae correo: la primera lectura está pendiente" })
  })

  it("un proveedor sin habilitar no ofrece conectarse", () => {
    const rows = mailRows({ providers: [{ ...providers[0]!, configured: false }], connections: [] }, () => undefined, since)
    expect(rows[0]).toMatchObject({ status: "No disponible", available: false, detail: { kind: "note" } })
    // El que ni siquiera viene en la lista tampoco está disponible.
    expect(rows[1]).toMatchObject({ name: "Microsoft 365", available: false })
    expect(rowShortWord(rows[0]!).tone).toBe("muted")
  })
})

describe("modelo del agente", () => {
  const checked = minutesAgo(1)

  it("dice «Responde» solo con la comprobación del servidor, y el modelo por su nombre simple", () => {
    expect(modelRow({ responds: true, checkedAt: checked })).toMatchObject({
      tone: "ok",
      status: "Responde",
      detail: { kind: "account", account: "ChatGPT 6", activity: null },
      problem: null,
    })
    // Sin comprobación todavía no afirma nada.
    expect(modelRow(undefined)).toMatchObject({ tone: "off", status: "Comprobando el modelo…", detail: { account: "ChatGPT 6" } })
  })

  it("«No responde» dice que odentIA ya lo sabe, sin el motivo técnico", () => {
    const down = modelRow({ responds: false, checkedAt: checked })
    expect(down).toMatchObject({
      tone: "attention",
      status: "No responde",
      problem: "El modelo de odentIA no responde ahora. Ya avisamos a odentIA y te escribimos cuando vuelva.",
    })
    expect(JSON.stringify(down)).not.toMatch(/LLM_|clave|saldo/)
  })
})

describe("al volver de autorizar el correo", () => {
  it("conserva solo lo que la página entiende", () => {
    expect(validateIntegrationsSearch({ ok: 1, buzon: "gmail", org: "clinica", otro: "x" })).toEqual({ ok: 1, buzon: "gmail" })
    expect(validateIntegrationsSearch({ error: "oauth-denegado", buzon: "" })).toEqual({ error: "oauth-denegado" })
    expect(validateIntegrationsSearch({})).toEqual({})
  })

  it("dice qué pasó sin códigos", () => {
    expect(mailNotice({ ok: 1, buzon: "microsoft365" })).toEqual({
      tone: "success",
      text: "Microsoft 365 quedó conectado: lo que llegue a ese buzón ya entra a la Bandeja.",
    })
    expect(mailNotice({ error: "oauth-denegado" })?.text).toBe("No se conectó el correo: cancelaste la autorización.")
    expect(mailNotice({ error: "oauth-fallo" })?.tone).toBe("danger")
    expect(mailNotice({})).toBeNull()
  })
})
