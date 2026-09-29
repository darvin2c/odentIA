import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import { type ContractFixtures, runAdapterContract } from "./contract.js"
import { messengerAdapter, verifyMetaChallenge } from "./meta-messaging.js"

const config = { pageId: "PAGE1", pageAccessToken: "TOKEN", appSecret: "appsecret123" }

function sig(rawBody: string): string {
  return `sha256=${createHmac("sha256", "appsecret123").update(rawBody, "utf8").digest("hex")}`
}

const textBody = JSON.stringify({
  object: "page",
  entry: [
    {
      id: "PAGE1",
      messaging: [
        {
          sender: { id: "PSID1" },
          recipient: { id: "PAGE1" },
          timestamp: 1727440000000,
          message: { mid: "mid.1", text: "Hola, ¿tienen citas?" },
        },
      ],
    },
  ],
})

const attachDeliverBody = JSON.stringify({
  object: "page",
  entry: [
    {
      id: "PAGE1",
      messaging: [
        {
          sender: { id: "PSID1" },
          recipient: { id: "PAGE1" },
          timestamp: 1727440001000,
          message: {
            mid: "mid.2",
            attachments: [{ type: "image", payload: { url: "https://cdn.example.com/foto.jpg" } }],
          },
        },
        {
          sender: { id: "PSID1" },
          recipient: { id: "PAGE1" },
          timestamp: 1727440002000,
          delivery: { mids: ["mid.out1"] },
        },
      ],
    },
  ],
})

const fx: ContractFixtures = {
  config,
  capabilities: { templates: false, media: true, interactive: false, readReceipts: true, edit: false },
  verify: [
    { name: "acepta firma HMAC correcta", headers: { "x-hub-signature-256": sig(textBody) }, rawBody: textBody, secret: "ignored", expect: true },
    { name: "rechaza firma incorrecta", headers: { "x-hub-signature-256": "sha256=00firma_invalida" }, rawBody: textBody, secret: "ignored", expect: false },
    { name: "rechaza sin firma", headers: {}, rawBody: textBody, secret: "ignored", expect: false },
  ],
  parse: [
    {
      name: "texto de página",
      rawBody: textBody,
      expected: {
        messages: [
          {
            externalEventId: "mid.1",
            externalMessageId: "mid.1",
            externalThreadId: "msgr:PSID1",
            senderExternalId: "msgr:PSID1",
            content: { type: "text", text: "Hola, ¿tienen citas?" },
            sentAt: new Date(1727440000000).toISOString(),
          },
        ],
        statuses: [],
      },
    },
    {
      name: "adjunto + acuse de entrega",
      rawBody: attachDeliverBody,
      expected: {
        messages: [
          {
            externalEventId: "mid.2",
            externalMessageId: "mid.2",
            externalThreadId: "msgr:PSID1",
            senderExternalId: "msgr:PSID1",
            content: {
              type: "media",
              mediaExternalId: "https://cdn.example.com/foto.jpg",
              mimeType: "image/jpeg",
            },
            sentAt: new Date(1727440001000).toISOString(),
          },
        ],
        statuses: [{ externalMessageId: "mid.out1", status: "delivered" }],
      },
    },
    {
      name: "objeto ajeno se ignora",
      rawBody: JSON.stringify({ object: "instagram", entry: [] }),
      expected: { messages: [], statuses: [] },
    },
  ],
  send: [
    {
      name: "texto construye Send API",
      message: { to: "msgr:PSID1", kind: { type: "text", text: "Hola" } },
      respondWith: { recipient_id: "PSID1", message_id: "mid.out1" },
      expectUrl: "https://graph.facebook.com/v21.0/PAGE1/messages",
      expectBody: {
        recipient: { id: "PSID1" },
        messaging_type: "RESPONSE",
        message: { text: "Hola" },
      },
      expectExternalId: "mid.out1",
    },
    {
      name: "media construye attachment",
      message: {
        to: "PSID1",
        kind: {
          type: "media",
          media: { url: "https://files.example.com/rx.png", mimeType: "image/png", filename: "rx.png" },
        },
      },
      respondWith: { recipient_id: "PSID1", message_id: "mid.out2" },
      expectUrl: "https://graph.facebook.com/v21.0/PAGE1/messages",
      expectBody: {
        recipient: { id: "PSID1" },
        message: { attachment: { type: "image", payload: { url: "https://files.example.com/rx.png" } } },
      },
      expectExternalId: "mid.out2",
    },
  ],
}

it("pasa el contrato del adaptador Messenger", async () => {
  await runAdapterContract(messengerAdapter, fx)
})

it("ignora ecos propios y destinatarios ajenos", () => {
  const echo = JSON.stringify({
    object: "page",
    entry: [
      {
        id: "PAGE1",
        messaging: [
          {
            sender: { id: "PAGE1" },
            recipient: { id: "PSID1" },
            timestamp: 1727440000000,
            message: { mid: "mid.eco", text: "respuesta", is_echo: true },
          },
        ],
      },
    ],
  })
  expect(
    messengerAdapter.parseWebhook({ headers: {}, rawBody: echo, config }),
  ).toEqual({ messages: [], statuses: [] })
  const other = JSON.stringify({
    object: "page",
    entry: [
      {
        id: "OTRA",
        messaging: [
          {
            sender: { id: "PSID9" },
            recipient: { id: "OTRA" },
            timestamp: 1727440000000,
            message: { mid: "mid.9", text: "hola" },
          },
        ],
      },
    ],
  })
  expect(
    messengerAdapter.parseWebhook({ headers: {}, rawBody: other, config }),
  ).toEqual({ messages: [], statuses: [] })
})

it("rechaza plantillas y exige pageId", async () => {
  await expect(
    messengerAdapter.sendMessage(
      config,
      { to: "msgr:1", kind: { type: "template", name: "x", language: "es", params: [] } },
      { fetch },
    ),
  ).rejects.toThrow("plantillas")
  await expect(
    messengerAdapter.sendMessage({}, { to: "msgr:1", kind: { type: "text", text: "hola" } }, { fetch }),
  ).rejects.toThrow("pageId")
})

it("challenge de verificación exige verify_token igual al secreto", () => {
  expect(
    verifyMetaChallenge({ mode: "subscribe", token: "secreto", challenge: "CH" }, "secreto"),
  ).toBe("CH")
  expect(
    verifyMetaChallenge({ mode: "subscribe", token: "otro", challenge: "CH" }, "secreto"),
  ).toBeNull()
})

it("validateConnection usa id y nombre de la página", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ id: "PAGE1", name: "Clínica Dental" }), { status: 200 }
    )) as unknown as typeof fetch
  await expect(messengerAdapter.validateConnection(config, { fetch: stub })).resolves.toEqual({
    externalId: "PAGE1",
    displayName: "Clínica Dental",
  })
  const bad = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid token", code: 190 } }), { status: 401 }
    )) as unknown as typeof fetch
  await expect(messengerAdapter.validateConnection(config, { fetch: bad })).rejects.toThrow(
    "validate falló",
  )
})
