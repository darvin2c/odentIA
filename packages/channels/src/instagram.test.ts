import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import { type ContractFixtures, runAdapterContract } from "./contract.js"
import { configureMetaGraphVersion } from "./meta-graph.js"
import { instagramAdapter } from "./meta-messaging.js"
import { ProviderRejectedError, ProviderThrottledError } from "./protocol.js"

// Flujo Instagram API con Instagram Login (docs primarias):
// host graph.instagram.com, token de usuario de Instagram,
// POST /{IG-ID}/messages sin messaging_type.
const config = { instagramId: "IG1", accessToken: "TOKEN", appSecret: "appsecret123" }

function sig(rawBody: string): string {
  return `sha256=${createHmac("sha256", "appsecret123").update(rawBody, "utf8").digest("hex")}`
}

const textBody = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "IG1",
      messaging: [
        {
          sender: { id: "IGSID9" },
          recipient: { id: "IG1" },
          timestamp: 1727440000000,
          message: { mid: "mid.ig1", text: "¿Hacen ortodoncia?" },
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
  ],
  parse: [
    {
      name: "texto de instagram",
      rawBody: textBody,
      expected: {
        messages: [
          {
            externalEventId: "mid.ig1",
            externalMessageId: "mid.ig1",
            externalThreadId: "ig:IGSID9",
            senderExternalId: "ig:IGSID9",
            content: { type: "text", text: "¿Hacen ortodoncia?" },
            sentAt: new Date(1727440000000).toISOString(),
          },
        ],
        statuses: [],
      },
    },
    {
      name: "objeto page se ignora",
      rawBody: JSON.stringify({ object: "page", entry: [] }),
      expected: { messages: [], statuses: [] },
    },
  ],
  send: [
    {
      name: "texto va a IG-ID/messages sin messaging_type",
      message: { to: "ig:IGSID9", kind: { type: "text", text: "Hola" } },
      respondWith: { recipient_id: "IGSID9", message_id: "mid.igout1" },
      expectUrl: "https://graph.instagram.com/v25.0/IG1/messages",
      expectBody: {
        recipient: { id: "IGSID9" },
        message: { text: "Hola" },
      },
      expectExternalId: "mid.igout1",
    },
    {
      name: "video construye attachment",
      message: {
        to: "ig:IGSID9",
        kind: {
          type: "media",
          media: { url: "https://files.example.com/video.mp4", mimeType: "video/mp4", filename: "video.mp4" },
        },
      },
      respondWith: { recipient_id: "IGSID9", message_id: "mid.igout2" },
      expectUrl: "https://graph.instagram.com/v25.0/IG1/messages",
      expectBody: {
        recipient: { id: "IGSID9" },
        message: { attachment: { type: "video", payload: { url: "https://files.example.com/video.mp4" } } },
      },
      expectExternalId: "mid.igout2",
    },
    {
      name: "pdf admitido como file",
      message: {
        to: "ig:IGSID9",
        kind: {
          type: "media",
          media: { url: "https://f.example.com/a.pdf", mimeType: "application/pdf", filename: "a.pdf" },
        },
      },
      respondWith: { recipient_id: "IGSID9", message_id: "mid.igout3" },
      expectUrl: "https://graph.instagram.com/v25.0/IG1/messages",
      expectBody: {
        recipient: { id: "IGSID9" },
        message: { attachment: { type: "file", payload: { url: "https://f.example.com/a.pdf" } } },
      },
      expectExternalId: "mid.igout3",
    },
  ],
}

it("pasa el contrato del adaptador Instagram", async () => {
  await runAdapterContract(instagramAdapter, fx)
})

it("rechaza texto mayor a 1000 bytes y exige instagramId", async () => {
  await expect(
    instagramAdapter.sendMessage(
      config,
      { to: "ig:1", kind: { type: "text", text: "a".repeat(1001) } },
      { fetch },
    ),
  ).rejects.toBeInstanceOf(ProviderRejectedError)
  await expect(
    instagramAdapter.sendMessage({}, { to: "ig:1", kind: { type: "text", text: "hola" } }, { fetch }),
  ).rejects.toThrow("instagramId")
})

it("lo que Instagram rechaza con su error no salió, y su límite de ritmo se puede reintentar", async () => {
  const send = (status: number, json: unknown) =>
    instagramAdapter.sendMessage(config, { to: "ig:1", kind: { type: "text", text: "hola" } }, {
      fetch: (async () => new Response(JSON.stringify(json), { status })) as typeof fetch,
    })
  const rejected = send(400, { error: { message: "(#100) No matching user found", code: 100 } })
  await expect(rejected).rejects.toBeInstanceOf(ProviderRejectedError)
  await expect(rejected).rejects.toThrow("No matching user found")
  await expect(send(400, { error: { message: "Application request limit reached", code: 4 } })).rejects.toBeInstanceOf(ProviderThrottledError)
  await expect(send(502, null)).rejects.not.toBeInstanceOf(ProviderRejectedError)
})

it("Instagram usa la misma versión de Meta que WhatsApp y el botón de Facebook", async () => {
  const urls: string[] = []
  const stub = (async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ recipient_id: "IGSID9", message_id: "mid.v26" }), {
      status: 200,
    })
  }) as unknown as typeof fetch
  configureMetaGraphVersion("v26.0")
  try {
    await instagramAdapter.sendMessage(
      config,
      { to: "ig:IGSID9", kind: { type: "text", text: "Hola" } },
      { fetch: stub },
    )
  } finally {
    configureMetaGraphVersion(null)
  }
  expect(urls).toEqual(["https://graph.instagram.com/v26.0/IG1/messages"])
})

it("validateConnection usa username de la cuenta", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ id: "IG1", username: "clinica.dental" }), { status: 200 }
    )) as unknown as typeof fetch
  await expect(instagramAdapter.validateConnection(config, { fetch: stub })).resolves.toEqual({
    externalId: "IG1",
    displayName: "@clinica.dental",
  })
})
