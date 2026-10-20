import { describe, expect, it } from "vitest"
import { splitWhatsAppWebhook, whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js"
import {
  exchangeSignupCode,
  inspectSignupToken,
  MetaSignupError,
  newRegistrationPin,
  refreshSignupToken,
  registerPhoneNumber,
  subscribeAppToAccount,
} from "./whatsapp-embedded-signup.js"

/**
 * Las llamadas de «Conectar con Facebook» contra un `fetch` de prueba que
 * responde con la forma que publica Meta. No acredita que Meta las acepte: la
 * app de odentIA todavía no existe.
 */
const APP = { appId: "APP1", appSecret: "secreto-de-la-app", graphVersion: "v25.0" }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fakeMeta(answer: (call: Call) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const given = answer(call)
    if (given instanceof Error) throw given
    const text = typeof given.body === "string" ? given.body : JSON.stringify(given.body)
    return new Response(text, { status: given.status ?? 200 })
  }) as typeof fetch
  return { calls, fetch: impl }
}

describe("canjear el código", () => {
  it("pide la clave con el identificador y la clave de la app, y el código tal como llegó", async () => {
    const meta = fakeMeta(() => ({ body: { access_token: "CLAVE-DE-LA-CLINICA", token_type: "bearer", expires_in: 5_184_000 } }))
    expect(await exchangeSignupCode(APP, "AQB hl/+=", { fetch: meta.fetch })).toEqual({
      token: "CLAVE-DE-LA-CLINICA",
      expiresInSeconds: 5_184_000,
    })
    expect(meta.calls).toHaveLength(1)
    const url = new URL(meta.calls[0]!.url)
    expect(meta.calls[0]!.method).toBe("GET")
    expect(`${url.origin}${url.pathname}`).toBe("https://graph.facebook.com/v25.0/oauth/access_token")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "APP1",
      client_secret: "secreto-de-la-app",
      code: "AQB hl/+=",
    })
    // La clave secreta viaja en la consulta, como pide Meta, y nunca como cabecera de otra cuenta.
    expect(meta.calls[0]!.headers).toEqual({})
  })

  it("acepta también la clave sola, que es como la muestra la documentación", async () => {
    const bare = fakeMeta(() => ({ body: "EAAJB0123456789abcdefghijZDZD" }))
    expect(await exchangeSignupCode(APP, "c", { fetch: bare.fetch })).toEqual({
      token: "EAAJB0123456789abcdefghijZDZD",
      expiresInSeconds: null,
    })
    const quoted = fakeMeta(() => ({ body: JSON.stringify("EAAJB0123456789abcdefghijZDZD") }))
    expect(await exchangeSignupCode(APP, "c", { fetch: quoted.fetch })).toEqual({
      token: "EAAJB0123456789abcdefghijZDZD",
      expiresInSeconds: null,
    })
  })

  it("lee en cuántos segundos vence la clave, si Meta lo dice; si no, queda sin plazo", async () => {
    const asText = fakeMeta(() => ({ body: { access_token: "CLAVE", expires_in: "5183999" } }))
    expect((await exchangeSignupCode(APP, "c", { fetch: asText.fetch })).expiresInSeconds).toBe(5_183_999)
    const without = fakeMeta(() => ({ body: { access_token: "CLAVE", token_type: "bearer" } }))
    expect((await exchangeSignupCode(APP, "c", { fetch: without.fetch })).expiresInSeconds).toBeNull()
    const zero = fakeMeta(() => ({ body: { access_token: "CLAVE", expires_in: 0 } }))
    expect((await exchangeSignupCode(APP, "c", { fetch: zero.fetch })).expiresInSeconds).toBeNull()
  })

  it("un código vencido llega con el código y el motivo de Meta", async () => {
    const meta = fakeMeta(() => ({
      status: 400,
      body: { error: { message: "This authorization code has expired.", type: "OAuthException", code: 100, fbtrace_id: "A" } },
    }))
    const error = await exchangeSignupCode(APP, "viejo", { fetch: meta.fetch }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MetaSignupError)
    expect(error).toMatchObject({ step: "canjear", httpStatus: 400, code: 100, detail: "This authorization code has expired.", transient: false })
  })

  it("una respuesta que no trae la clave no se toma por buena, y la red caída se distingue", async () => {
    const empty = fakeMeta(() => ({ body: { token_type: "bearer" } }))
    await expect(exchangeSignupCode(APP, "c", { fetch: empty.fetch })).rejects.toMatchObject({
      step: "canjear",
      detail: "Meta respondió sin la clave de la cuenta",
    })
    const html = fakeMeta(() => ({ body: "<html>Sorry, something went wrong</html>" }))
    await expect(exchangeSignupCode(APP, "c", { fetch: html.fetch })).rejects.toBeInstanceOf(MetaSignupError)
    const down = fakeMeta(() => new Error("getaddrinfo ENOTFOUND graph.facebook.com?client_secret=secreto-de-la-app"))
    const error = (await exchangeSignupCode(APP, "c", { fetch: down.fetch }).catch((e: unknown) => e)) as MetaSignupError
    expect(error).toMatchObject({ step: "canjear", httpStatus: 0, code: null, transient: true })
    // El motivo de la red no arrastra la clave de la app.
    expect(error.message).not.toContain("secreto-de-la-app")
  })
})

describe("renovar la clave antes de que venza", () => {
  it("pide otra con la vigente y la clave de la app, por 60 días, y lee cuándo vence", async () => {
    const meta = fakeMeta(() => ({ body: { access_token: "CLAVE-NUEVA", token_type: "bearer", expires_in: 5_183_944 } }))
    expect(await refreshSignupToken(APP, "CLAVE-VIGENTE", { fetch: meta.fetch })).toEqual({
      token: "CLAVE-NUEVA",
      expiresInSeconds: 5_183_944,
    })
    expect(meta.calls).toHaveLength(1)
    const url = new URL(meta.calls[0]!.url)
    expect(meta.calls[0]!.method).toBe("GET")
    expect(`${url.origin}${url.pathname}`).toBe("https://graph.facebook.com/v25.0/oauth/access_token")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      grant_type: "fb_exchange_token",
      client_id: "APP1",
      client_secret: "secreto-de-la-app",
      set_token_expires_in_60_days: "true",
      fb_exchange_token: "CLAVE-VIGENTE",
    })
    expect(meta.calls[0]!.headers).toEqual({})
  })

  it("si Meta dice que no, llega con su código; si no responde, se puede repetir", async () => {
    const dead = fakeMeta(() => ({
      status: 400,
      body: { error: { message: "Error validating access token: Session has expired.", type: "OAuthException", code: 190 } },
    }))
    const error = (await refreshSignupToken(APP, "VIEJA", { fetch: dead.fetch }).catch((e: unknown) => e)) as MetaSignupError
    expect(error).toBeInstanceOf(MetaSignupError)
    expect(error).toMatchObject({ step: "renovar", code: 190, transient: false })
    const down = fakeMeta(() => new TypeError("fetch failed"))
    const failed = (await refreshSignupToken(APP, "VIGENTE", { fetch: down.fetch }).catch((e: unknown) => e)) as MetaSignupError
    expect(failed).toMatchObject({ step: "renovar", transient: true })
    const empty = fakeMeta(() => ({ body: { token_type: "bearer" } }))
    await expect(refreshSignupToken(APP, "VIGENTE", { fetch: empty.fetch })).rejects.toMatchObject({ step: "renovar" })
  })
})

describe("preguntar a Meta por una clave", () => {
  it("dice cuándo vence, con la clave de la app", async () => {
    const meta = fakeMeta(() => ({ body: { data: { app_id: "APP1", type: "SYSTEM_USER", is_valid: true, expires_at: 1_798_675_200, issued_at: 1_793_491_200 } } }))
    expect(await inspectSignupToken(APP, "CLAVE", { fetch: meta.fetch })).toEqual({
      valid: true,
      expiresAt: new Date(1_798_675_200 * 1000),
    })
    const url = new URL(meta.calls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe("https://graph.facebook.com/v25.0/debug_token")
    expect(Object.fromEntries(url.searchParams)).toEqual({ input_token: "CLAVE", access_token: "APP1|secreto-de-la-app" })
  })

  it("una clave que no vence llega sin fecha; una que ya no sirve, como no válida", async () => {
    const never = fakeMeta(() => ({ body: { data: { is_valid: true, expires_at: 0 } } }))
    expect(await inspectSignupToken(APP, "CLAVE", { fetch: never.fetch })).toEqual({ valid: true, expiresAt: null })
    const dead = fakeMeta(() => ({
      body: { data: { is_valid: false, expires_at: 1_790_000_000, error: { code: 190, message: "Session has expired" } } },
    }))
    expect(await inspectSignupToken(APP, "CLAVE", { fetch: dead.fetch })).toEqual({ valid: false, expiresAt: null })
    const odd = fakeMeta(() => ({ body: { data: { is_valid: true } } }))
    await expect(inspectSignupToken(APP, "CLAVE", { fetch: odd.fetch })).rejects.toMatchObject({ step: "revisar" })
  })
})

describe("suscribir la app a la cuenta", () => {
  it("llama a la cuenta con la clave de la clínica y sin cuerpo", async () => {
    const meta = fakeMeta(() => ({ body: { success: true } }))
    await subscribeAppToAccount(APP, "WABA1", "CLAVE", { fetch: meta.fetch })
    expect(meta.calls).toEqual([
      {
        url: "https://graph.facebook.com/v25.0/WABA1/subscribed_apps",
        method: "POST",
        headers: { Authorization: "Bearer CLAVE" },
        body: undefined,
      },
    ])
  })

  it("sin permiso sobre esa cuenta, dice el código de Meta", async () => {
    const meta = fakeMeta(() => ({
      status: 403,
      body: { error: { message: "(#200) Permissions error", type: "OAuthException", code: 200 } },
    }))
    await expect(subscribeAppToAccount(APP, "WABA1", "CLAVE", { fetch: meta.fetch })).rejects.toMatchObject({
      step: "suscribir",
      httpStatus: 403,
      code: 200,
      transient: false,
    })
    const odd = fakeMeta(() => ({ body: { success: false } }))
    await expect(subscribeAppToAccount(APP, "WABA1", "CLAVE", { fetch: odd.fetch })).rejects.toBeInstanceOf(MetaSignupError)
    const broken = fakeMeta(() => ({ status: 500, body: { error: { message: "An unexpected error occurred", code: 2 } } }))
    await expect(subscribeAppToAccount(APP, "WABA1", "CLAVE", { fetch: broken.fetch })).rejects.toMatchObject({ transient: true })
  })
})

describe("registrar el número", () => {
  it("envía el producto y el PIN de 6 dígitos", async () => {
    const meta = fakeMeta(() => ({ body: { success: true } }))
    await registerPhoneNumber(APP, "PN1", "CLAVE", "048213", { fetch: meta.fetch })
    expect(meta.calls).toEqual([
      {
        url: "https://graph.facebook.com/v25.0/PN1/register",
        method: "POST",
        headers: { Authorization: "Bearer CLAVE", "content-type": "application/json" },
        body: { messaging_product: "whatsapp", pin: "048213" },
      },
    ])
  })

  it("un PIN que no es de 6 dígitos no llega a Meta", async () => {
    const meta = fakeMeta(() => ({ body: { success: true } }))
    await expect(registerPhoneNumber(APP, "PN1", "CLAVE", "1234", { fetch: meta.fetch })).rejects.toThrow("6 dígitos")
    expect(meta.calls).toEqual([])
  })

  it("el PIN que no coincide llega con su código y la explicación de Meta", async () => {
    const meta = fakeMeta(() => ({
      status: 400,
      body: {
        error: {
          message: "(#133005) Two step verification PIN Mismatch",
          type: "OAuthException",
          code: 133005,
          error_data: { messaging_product: "whatsapp", details: "The PIN you entered is incorrect." },
        },
      },
    }))
    await expect(registerPhoneNumber(APP, "PN1", "CLAVE", "048213", { fetch: meta.fetch })).rejects.toMatchObject({
      step: "registrar",
      code: 133005,
      detail: "The PIN you entered is incorrect.",
    })
  })

  it("el PIN nuevo tiene siempre 6 dígitos", () => {
    for (let i = 0; i < 200; i++) expect(newRegistrationPin()).toMatch(/^\d{6}$/)
  })
})

describe("repartir un aviso que llega a la dirección de la app", () => {
  const message = (id: string, from: string) => ({ from, id, timestamp: "1735689600", type: "text", text: { body: "Hola" } })
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-A",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51999000111", phone_number_id: "PN-A" },
              contacts: [{ profile: { name: "Ana" }, wa_id: "51911111111" }],
              messages: [message("wamid.A1", "51911111111")],
            },
          },
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51999000111", phone_number_id: "PN-A" },
              statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1735689601" }],
            },
          },
          {
            field: "message_template_status_update",
            value: { event: "APPROVED", message_template_id: 77, message_template_name: "odentia_recordatorio_cita_v1", message_template_language: "es", reason: "NONE" },
          },
        ],
      },
      {
        id: "WABA-B",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51999000222", phone_number_id: "PN-B" },
              messages: [message("wamid.B1", "51922222222")],
            },
          },
          // Sin número: no se sabe de quién es y no se reparte.
          { field: "messages", value: { messaging_product: "whatsapp", messages: [message("wamid.X", "51933333333")] } },
          // Un aviso de cuenta que odentIA no usa.
          { field: "account_update", value: { event: "PARTNER_ADDED", waba_info: { waba_id: "WABA-B" } } },
        ],
      },
    ],
  })

  it("los mensajes y estados van a su número y los cambios de plantilla a su cuenta", () => {
    const deliveries = splitWhatsAppWebhook(raw)
    expect(deliveries.map((d) => (d.kind === "number" ? `número ${d.phoneNumberId}` : `cuenta ${d.accountId}`))).toEqual([
      "número PN-A",
      "número PN-B",
      "cuenta WABA-A",
    ])
    const [a, b, account] = deliveries
    expect(a).toMatchObject({
      kind: "number",
      accountId: "WABA-A",
      messages: [{ externalEventId: "wamid.A1", senderDisplayName: "Ana", content: { type: "text", text: "Hola" } }],
      statuses: [{ externalMessageId: "wamid.OUT1", status: "delivered" }],
    })
    expect(b).toMatchObject({ kind: "number", accountId: "WABA-B", messages: [{ externalEventId: "wamid.B1" }], statuses: [] })
    expect(account).toEqual({
      kind: "account",
      accountId: "WABA-A",
      templateStatuses: [{ externalId: "77", name: "odentia_recordatorio_cita_v1", language: "es", status: "aprobada", reason: null }], templateCategories: [],
    })
  })

  it("la dirección de una conexión sigue leyendo el mismo aviso entero, como antes", () => {
    const parsed = whatsappCloudApiAdapter.parseWebhook({ headers: {}, rawBody: raw, config: {} })
    expect(parsed.messages.map((m) => m.externalEventId)).toEqual(["wamid.A1", "wamid.B1", "wamid.X"])
    expect(parsed.statuses).toHaveLength(1)
    expect(parsed.templateStatuses).toHaveLength(1)
  })

  it("lo que no es un aviso de WhatsApp no reparte nada", () => {
    expect(splitWhatsAppWebhook("no es json")).toEqual([])
    expect(splitWhatsAppWebhook("{}")).toEqual([])
    expect(splitWhatsAppWebhook(JSON.stringify({ entry: [{ id: "W", changes: [{ field: "messages", value: null }] }] }))).toEqual([])
  })
})

describe("una conexión hecha con el botón no guarda la clave secreta de una app", () => {
  const config = { phoneNumberId: "PN1", wabaId: "WABA1", accessToken: "CLAVE" }

  it("envía y lee la cuenta sin ella", async () => {
    const meta = fakeMeta((call) =>
      call.method === "POST"
        ? { body: { messages: [{ id: "wamid.ENVIADO" }] } }
        : { body: { id: "PN1", display_phone_number: "+51 999 000 111", verified_name: "Clínica" } },
    )
    await expect(
      whatsappCloudApiAdapter.sendMessage(config, { to: "wa:51911111111", kind: { type: "text", text: "hola" } }, { fetch: meta.fetch }),
    ).resolves.toEqual({ externalId: "wamid.ENVIADO" })
    await expect(whatsappCloudApiAdapter.validateConnection(config, { fetch: meta.fetch })).resolves.toMatchObject({ externalId: "PN1" })
  })

  it("y su dirección propia no acepta ningún aviso: los suyos llegan por la app de odentIA", () => {
    expect(
      whatsappCloudApiAdapter.verifyWebhook({ headers: { "x-hub-signature-256": "sha256=00" }, rawBody: "{}", config, webhookSecret: "x" }),
    ).toBe(false)
  })
})
