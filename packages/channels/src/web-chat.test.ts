import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import { type ContractFixtures, runAdapterContract } from "./contract.js"
import {
  assertValidWebchatConfig,
  buildWebchatInbound,
  createWebchatToken,
  isWebchatSessionId,
  newWebchatSessionId,
  normalizeOrigin,
  verifyWebchatToken,
  webChatAdapter,
} from "./web-chat.js"

const config = { widgetColor: "#0f766e", greeting: "Hola, ¿en qué podemos ayudarte?" }

function sig(rawBody: string): string {
  return `sha256=${createHmac("sha256", "secreto-webhook").update(rawBody, "utf8").digest("hex")}`
}

const sessionId = "webchat:11111111-1111-4111-8111-111111111111"
const textBody = JSON.stringify({
  sessionId,
  message: { id: "cli-1", text: "Hola, ¿tienen citas?", sentAt: "2026-09-28T10:00:00.000Z" },
})

const batchBody = JSON.stringify({
  sessionId,
  messages: [
    { id: "cli-2", text: "¿Atienden los sábados?", displayName: "Visita  web ", sentAt: "2026-09-28T10:01:00.000Z" },
    { id: "mal!", text: "se descarta por id inseguro", sentAt: "2026-09-28T10:01:00.000Z" },
    { id: "cli-3", text: "   ", sentAt: "2026-09-28T10:01:00.000Z" },
  ],
})

const fx: ContractFixtures = {
  config,
  capabilities: { templates: false, media: false, interactive: false, readReceipts: true, edit: false },
  verify: [
    { name: "acepta firma HMAC correcta", headers: { "x-webchat-signature": sig(textBody) }, rawBody: textBody, secret: "secreto-webhook", expect: true },
    { name: "rechaza firma incorrecta", headers: { "x-webchat-signature": "sha256=00firma_invalida" }, rawBody: textBody, secret: "secreto-webhook", expect: false },
    { name: "rechaza sin firma", headers: {}, rawBody: textBody, secret: "secreto-webhook", expect: false },
  ],
  parse: [
    {
      name: "mensaje único del visitante",
      rawBody: textBody,
      expected: {
        messages: [
          {
            externalEventId: `webchat:11111111-1111-4111-8111-111111111111:cli-1`,
            externalMessageId: `webchat:11111111-1111-4111-8111-111111111111:cli-1`,
            externalThreadId: sessionId,
            senderExternalId: sessionId,
            senderDisplayName: "Visitante del chat web",
            content: { type: "text", text: "Hola, ¿tienen citas?" },
            sentAt: "2026-09-28T10:00:00.000Z",
          },
        ],
        statuses: [],
      },
    },
    {
      name: "lote filtra ids inseguros y vacíos, recorta el nombre",
      rawBody: batchBody,
      expected: {
        messages: [
          {
            externalEventId: `webchat:11111111-1111-4111-8111-111111111111:cli-2`,
            externalMessageId: `webchat:11111111-1111-4111-8111-111111111111:cli-2`,
            externalThreadId: sessionId,
            senderExternalId: sessionId,
            senderDisplayName: "Visita  web",
            content: { type: "text", text: "¿Atienden los sábados?" },
            sentAt: "2026-09-28T10:01:00.000Z",
          },
        ],
        statuses: [],
      },
    },
    { name: "sesión inválida no produce mensajes", rawBody: JSON.stringify({ sessionId: "otro", message: { id: "a", text: "hola" } }), expected: { messages: [], statuses: [] } },
    { name: "cuerpo no JSON no produce mensajes", rawBody: "no-json", expected: { messages: [], statuses: [] } },
  ],
  send: [
    {
      name: "avisa al sitio con POST y usa su deliveryId",
      message: { to: sessionId, kind: { type: "text", text: "Claro, ¿qué día prefieres?" } },
      respondWith: { deliveryId: "dlv_9" },
      expectUrl: "https://tienda.example.test/webchat/eventos",
      expectBody: { event: "operator.message", sessionId, text: "Claro, ¿qué día prefieres?" },
      expectExternalId: "webchat:dlv_9",
    },
  ],
}

// El caso send con push exige notifyUrl: se inyecta solo para ese caso.
const fxWithPush: ContractFixtures = {
  ...fx,
  config: { ...config, notifyUrl: "https://tienda.example.test/webchat/eventos" },
}

it("pasa el contrato del adaptador web_chat", async () => {
  await runAdapterContract(webChatAdapter, fxWithPush)
})

it("sin notifyUrl acepta para entrega local sin red", async () => {
  let calls = 0
  const fetchStub = (async () => {
    calls += 1
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  const got = await webChatAdapter.sendMessage(
    config,
    { to: sessionId, kind: { type: "text", text: "Hola" } },
    { fetch: fetchStub },
  )
  expect(got.externalId.startsWith("webchat:local:")).toBe(true)
  expect(calls).toBe(0)
})

it("rechaza destinos sin sesión válida antes de fingir entrega", async () => {
  const fetchStub = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
  await expect(
    webChatAdapter.sendMessage(config, { to: "tg:123", kind: { type: "text", text: "hola" } }, { fetch: fetchStub }),
  ).rejects.toThrow(/sesión válida/)
})

it("el sitio se guarda como lo dice el navegador; en claro solo en local", () => {
  expect(normalizeOrigin("https://Sonrisa.pe/")).toBe("https://sonrisa.pe")
  expect(normalizeOrigin("https://sonrisa.pe:8443/contacto")).toBe("https://sonrisa.pe:8443")
  expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000")
  expect(normalizeOrigin("http://sonrisa.pe")).toBeNull()
  expect(normalizeOrigin("javascript:alert(1)")).toBeNull()
  expect(normalizeOrigin("no es una dirección")).toBeNull()
})

it("el aviso al sitio va firmado con la clave de la conexión; una prueba no avisa", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) })
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  const withPush = { ...config, notifyUrl: "https://tienda.example.test/webchat/eventos" }
  await webChatAdapter.sendMessage(withPush, { to: sessionId, kind: { type: "text", text: "Hola" } }, { fetch: fetchStub, webhookSecret: "secreto-webhook" })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.headers["x-webchat-signature"]).toBe(sig(calls[0]!.body))
  const test = newWebchatSessionId({ test: true })
  expect(isWebchatSessionId(test)).toBe(true)
  expect(buildWebchatInbound(test, { clientMessageId: "c1", text: "hola" })).toMatchObject({ test: true, externalThreadId: test })
  const got = await webChatAdapter.sendMessage(withPush, { to: test, kind: { type: "text", text: "Hola" } }, { fetch: fetchStub, webhookSecret: "secreto-webhook" })
  expect(got.externalId.startsWith("webchat:local:")).toBe(true)
  expect(calls).toHaveLength(1)
})

it("el token de sesión es válido, expira y tiene alcance de sesión", () => {
  const token = createWebchatToken("secreto-webhook", sessionId)
  const verified = verifyWebchatToken("secreto-webhook", token)
  expect(verified?.sessionId).toBe(sessionId)
  expect(verifyWebchatToken("otro-secreto", token)).toBeNull()
  expect(verifyWebchatToken("secreto-webhook", "v1.malo.999.abc")).toBeNull()
  const expired = createWebchatToken("secreto-webhook", sessionId, -1000)
  expect(verifyWebchatToken("secreto-webhook", expired)).toBeNull()
})

it("la configuración ya no guarda claves anteriores: las sesiones no dependen del código de los avisos", () => {
  expect(assertValidWebchatConfig({ previousSecret: "clave-vieja", rotatedAt: new Date().toISOString() })).toEqual({})
})
