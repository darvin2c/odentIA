// Contrato + comportamiento del adaptador Microsoft 365 con fixtures golden
// con forma oficial de Graph (sin red): delta incremental, reply con hilo,
// adjuntos, OAuth PKCE y resync ante 410.
import { expect, it } from "vitest"
import { type ContractFixtures, createStubFetch, runAdapterContract } from "./contract.js"
import {
  exchangeMicrosoftCode,
  type GraphMessage,
  graphMessageToEvents,
  microsoft365Adapter,
  MicrosoftResyncRequired,
  pollMicrosoftMailbox,
  refreshMicrosoftAccessToken,
} from "./microsoft365.js"
const CONFIG = {
  refreshToken: "refresh-secreto",
  emailAddress: "clinica@example.com",
  accessToken: "access-vigente",
}

const fx: ContractFixtures = {
  config: CONFIG,
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: false },
  verify: [{ name: "sin webhook: siempre falso", headers: {}, rawBody: "{}", secret: "x", expect: false }],
  parse: [
    {
      name: "sin webhook: siempre vacío",
      rawBody: '{"value":[]}',
      expected: { messages: [], statuses: [] },
    },
  ],
  // El envío Graph resuelve la conversación (search + reply): varios requests,
  // fuera del caso simple del harness; se prueba abajo con stub manual.
  send: [],
}

function graphMsg(overrides: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: "mid1",
    conversationId: "conv1",
    subject: "Control",
    bodyPreview: "Hola, confirmo mi cita",
    body: { contentType: "Text", content: "Hola, confirmo mi cita" },
    from: { emailAddress: { address: "paciente@example.com", name: "Paciente" } },
    receivedDateTime: "2026-09-20T15:00:00Z",
    hasAttachments: false,
    ...overrides,
  }
}

it("pasa el contrato del adaptador Microsoft 365", async () => {
  await runAdapterContract(microsoft365Adapter, fx)
})

it("delta inicial guarda el deltaLink como cursor", async () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const fetch = createStubFetch(
    [{ value: [graphMsg()], "@odata.deltaLink": "https://graph/delta?token=2" }],
    captured,
  )
  const got = await pollMicrosoftMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: null },
    { fetch },
  )
  expect(got.nextCursor).toBe("https://graph/delta?token=2")
  expect(got.events).toHaveLength(1)
  expect(got.events[0]).toMatchObject({
    externalEventId: "m365:mid1",
    externalThreadId: "m365-conv:conv1",
    senderExternalId: "mail:paciente@example.com",
  })
  expect(captured[0]?.url).toContain("/messages/delta")
})

it("sigue nextLinks antes de guardar el cursor", async () => {
  const fetch = createStubFetch(
    [
      { value: [graphMsg({ id: "a" })], "@odata.nextLink": "https://graph/next1" },
      { value: [graphMsg({ id: "b" })], "@odata.deltaLink": "https://graph/delta?token=3" },
    ],
    [],
  )
  const got = await pollMicrosoftMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: "https://graph/delta?token=1" },
    { fetch },
  )
  expect(got.nextCursor).toBe("https://graph/delta?token=3")
  expect(got.events.map((e) => e.externalMessageId)).toEqual(["m365:a", "m365:b"])
})

it("omite propios y eliminados (@removed)", async () => {
  const fetch = createStubFetch(
    [
      {
        value: [
          graphMsg({ id: "propio", from: { emailAddress: { address: "clinica@example.com" } } }),
          { id: "borrado", "@removed": { reason: "deleted" } },
        ],
        "@odata.deltaLink": "https://graph/delta?token=4",
      },
    ],
    [],
  )
  const got = await pollMicrosoftMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: "https://graph/delta?token=1" },
    { fetch },
  )
  expect(got.events).toEqual([])
  expect(got.nextCursor).toBe("https://graph/delta?token=4")
})

it("adjuntos generan eventos media además del texto", async () => {
  const fetch = createStubFetch(
    [
      {
        value: [graphMsg({ id: "c", hasAttachments: true })],
        "@odata.deltaLink": "https://graph/delta?token=5",
      },
      {
        value: [
          { id: "att1", name: "rx.jpg", contentType: "image/jpeg", size: 10, isInline: false },
        ],
      },
    ],
    [],
  )
  const got = await pollMicrosoftMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: "https://graph/delta?token=1" },
    { fetch },
  )
  expect(got.events.map((e) => e.externalEventId)).toEqual(["m365:c", "m365:c#att0"])
  expect(got.events[1]?.content).toMatchObject({
    type: "media",
    mediaExternalId: "m365-att:c:att1",
  })
})

it("checkpoint caducado (410) lanza resync", async () => {
  const fetch = (async () => new Response("{}", { status: 410 })) as unknown as typeof globalThis.fetch
  await expect(
    pollMicrosoftMailbox(
      { accessToken: "AT", emailAddress: "c@example.com", cursor: "https://graph/delta?viejo" },
      { fetch },
    ),
  ).rejects.toBeInstanceOf(MicrosoftResyncRequired)
})

it("sendMessage usa la acción reply en el hilo", async () => {
  const seen: { url: string; body: unknown }[] = []
  const fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).includes("$filter=")) {
      return new Response(JSON.stringify({ value: [graphMsg({ id: "mid9" })] }), { status: 200 })
    }
    return new Response(null, { status: 202 })
  }) as unknown as typeof globalThis.fetch
  const got = await microsoft365Adapter.sendMessage(
    CONFIG,
    { to: "m365-conv:conv1", kind: { type: "text", text: "Confirmada tu cita" } },
    { fetch },
  )
  expect(got.externalId).toContain("m365-reply:mid9")
  expect(seen).toHaveLength(2)
  expect(seen[1]?.url).toContain("/messages/mid9/reply")
  const replyBody = seen[1]?.body as { message?: { body?: { content?: string } } }
  expect(replyBody.message?.body?.content).toBe("Confirmada tu cita")
})

it("sin mensaje previo no se inventa destinatario", async () => {
  const fetch = createStubFetch([{ value: [] }], [])
  await expect(
    microsoft365Adapter.sendMessage(
      CONFIG,
      { to: "m365-conv:conv-vacia", kind: { type: "text", text: "hola" } },
      { fetch },
    ),
  ).rejects.toThrow("sin mensaje previo")
})

it("fetchMedia resuelve contentBytes del adjunto", async () => {
  const fetch = createStubFetch(
    [
      {
        id: "att1",
        name: "rx.jpg",
        contentType: "image/jpeg",
        contentBytes: Buffer.from("bytes-rx", "utf8").toString("base64"),
      },
    ],
    [],
  )
  const got = await microsoft365Adapter.fetchMedia?.(CONFIG, "m365-att:c:att1", { fetch })
  expect(got?.filename).toBe("rx.jpg")
  expect(Buffer.from(got?.bytes ?? []).toString("utf8")).toBe("bytes-rx")
})

it("intercambio y refresh distinguen invalid_grant", async () => {
  const client = {
    clientId: "id",
    clientSecret: "sec",
    redirectUri: "https://api.example.com/cb",
    tenant: "common",
  }
  const ok = (async () =>
    new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT2", expires_in: 3599 }), {
      status: 200,
    })) as unknown as typeof fetch
  const set = await exchangeMicrosoftCode(client, { code: "c", codeVerifier: "v" }, { fetch: ok })
  expect(set).toMatchObject({ accessToken: "AT", refreshToken: "RT2" })
  const revoked = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "revocado" }), {
      status: 400,
    })) as unknown as typeof fetch
  await expect(refreshMicrosoftAccessToken(client, "RT", { fetch: revoked })).rejects.toThrow(
    "auth inválida",
  )
})

it("normaliza html a texto y omite propios", () => {
  const html = graphMsg({
    id: "h",
    body: { contentType: "html", content: "<p>Hola<br>mundo</p>" },
    bodyPreview: "",
  })
  const events = graphMessageToEvents(html, "clinica@example.com")
  expect(events).toHaveLength(1)
  expect(events[0]?.content).toEqual({ type: "text", text: "Hola\nmundo" })
  expect(events[0]?.externalThreadId).toBe("m365-conv:conv1")
  const own = graphMsg({
    id: "propio",
    from: { emailAddress: { address: "clinica@example.com" } },
  })
  expect(graphMessageToEvents(own, "clinica@example.com")).toEqual([])
})
