// Contrato + comportamiento del adaptador Gmail con fixtures golden con
// forma oficial de la API (sin red): Poll incremental, reply con hilo,
// adjuntos, OAuth PKCE y casos de error (resync 404, auth 401).
import { expect, it } from "vitest"
import { type ContractFixtures, createStubFetch, runAdapterContract } from "./contract.js"
import {
  exchangeGmailCode,
  type GmailFullMessage,
  GmailAuthError,
  gmailAdapter,
  gmailMessageToEvents,
  GmailResyncRequired,
  pollGmailMailbox,
  refreshGmailAccessToken,
  revokeGmailToken,
} from "./gmail.js"

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
      rawBody: '{"historyId":"1"}',
      expected: { messages: [], statuses: [] },
    },
  ],
  // El envío Gmail resuelve el hilo (threads.get + send): dos requests, fuera
  // del caso simple del harness; se prueba abajo con stub manual.
  send: [],
}

function fullMessage(overrides: Partial<GmailFullMessage> = {}): GmailFullMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.parse("2026-09-20T10:00:00Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Paciente <paciente@example.com>" },
        { name: "Subject", value: "Dolor de muela" },
        { name: "Message-ID", value: "<abc@mail>" },
        { name: "Date", value: "Sat, 20 Sep 2026 10:00:00 -0500" },
      ],
      body: { data: Buffer.from("Hola, me duele mucho", "utf8").toString("base64url"), size: 20 },
    },
    ...overrides,
  }
}

it("pasa el contrato del adaptador Gmail", async () => {
  await runAdapterContract(gmailAdapter, fx)
})

it("normaliza texto con hilo y remitente mail:", () => {
  const events = gmailMessageToEvents(fullMessage(), "clinica@example.com")
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    externalEventId: "gmail:m1",
    externalMessageId: "gmail:m1",
    externalThreadId: "gmail-thread:t1",
    senderExternalId: "mail:paciente@example.com",
    senderDisplayName: "Paciente",
  })
  if (events[0]?.content.type === "text") {
    expect(events[0].content.text).toContain("me duele")
  } else {
    throw new Error("Se esperaba contenido texto")
  }
})

it("omite los enviados por el propio buzón", () => {
  const self = fullMessage({
    labelIds: ["SENT"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "clinica@example.com" }],
      body: { data: Buffer.from("respuesta", "utf8").toString("base64url") },
    },
  })
  expect(gmailMessageToEvents(self, "clinica@example.com")).toEqual([])
})

it("emite un evento media por adjunto además del texto", () => {
  const withAtt = fullMessage({
    id: "m2",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "paciente@example.com" },
        { name: "Subject", value: "Radiografía" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("adjunto mi rx", "utf8").toString("base64url") },
        },
        {
          mimeType: "image/jpeg",
          filename: "rx.jpg",
          body: { attachmentId: "att9", size: 12 },
        },
      ],
    },
  })
  const events = gmailMessageToEvents(withAtt, "clinica@example.com")
  expect(events.map((e) => e.externalEventId)).toEqual(["gmail:m2", "gmail:m2#att0"])
  expect(events[1]?.content).toMatchObject({
    type: "media",
    mediaExternalId: "gmail-att:m2:att9",
    mimeType: "image/jpeg",
  })
})

it("poll incremental avanza el cursor solo con el historyId de Google", async () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const fetch = createStubFetch(
    [
      { history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "777" },
      fullMessage(),
    ],
    captured,
  )
  const got = await pollGmailMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: "700" },
    { fetch },
  )
  expect(got.nextCursor).toBe("777")
  expect(got.events.map((e) => e.externalMessageId)).toEqual(["gmail:m1"])
  expect(captured[0]?.url).toContain("startHistoryId=700")
})

it("primera sincronización usa profile.historyId como cursor", async () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const fetch = createStubFetch(
    [{ emailAddress: "clinica@example.com", historyId: "900" }, { messages: [] }],
    captured,
  )
  const got = await pollGmailMailbox(
    { accessToken: "AT", emailAddress: "clinica@example.com", cursor: null },
    { fetch },
  )
  expect(got).toEqual({ events: [], nextCursor: "900" })
})

it("checkpoint caducado lanza resync (el worker reintenta inicial)", async () => {
  const fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch
  await expect(
    pollGmailMailbox({ accessToken: "AT", emailAddress: "c@example.com", cursor: "1" }, { fetch }),
  ).rejects.toBeInstanceOf(GmailResyncRequired)
})

it("sendMessage responde en el hilo con In-Reply-To", async () => {
  const seen: { url: string; body: unknown }[] = []
  const fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).includes("/threads/")) {
      return new Response(
        JSON.stringify({
          id: "t1",
          messages: [
            {
              id: "m1",
              threadId: "t1",
              payload: {
                headers: [
                  { name: "From", value: "paciente@example.com" },
                  { name: "Subject", value: "Dolor" },
                  { name: "Message-ID", value: "<abc@mail>" },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ id: "m9", threadId: "t1" }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const got = await gmailAdapter.sendMessage(
    CONFIG,
    { to: "gmail-thread:t1", kind: { type: "text", text: "Te agendo mañana" } },
    { fetch },
  )
  expect(got).toEqual({ externalId: "gmail:m9" })
  expect(seen).toHaveLength(2)
  const sentBody = seen[1]?.body as { raw?: string; threadId?: string }
  expect(sentBody.threadId).toBe("t1")
  const mime = Buffer.from(sentBody.raw ?? "", "base64url").toString("utf8")
  expect(mime).toContain("In-Reply-To: <abc@mail>")
  expect(mime).toContain("Subject: Re: Dolor")
})

it("fetchMedia resuelve nombre/mime y descarga los bytes", async () => {
  const seen: string[] = []
  const fetch = (async (url: unknown) => {
    seen.push(String(url))
    if (String(url).includes("/attachments/")) {
      return new Response(
        JSON.stringify({ data: Buffer.from("bytes-rx", "utf8").toString("base64url"), size: 8 }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify(
        fullMessage({
          id: "m2",
          payload: {
            mimeType: "multipart/mixed",
            headers: [{ name: "From", value: "p@example.com" }],
            parts: [{ mimeType: "image/jpeg", filename: "rx.jpg", body: { attachmentId: "att9" } }],
          },
        }),
      ),
      { status: 200 },
    )
  }) as unknown as typeof globalThis.fetch
  const got = await gmailAdapter.fetchMedia?.(CONFIG, "gmail-att:m2:att9", { fetch })
  expect(got?.filename).toBe("rx.jpg")
  expect(got?.mimeType).toBe("image/jpeg")
  expect(Buffer.from(got?.bytes ?? []).toString("utf8")).toBe("bytes-rx")
  // Dos llamadas: mensaje completo (resuelve nombre/mime) + bytes del adjunto.
  expect(seen[1]).toContain("/attachments/att9")
})

it("intercambio OAuth exige access_token o falla explícito", async () => {
  const ok = (async () =>
    new Response(
      JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: "s" }),
      { status: 200 },
    )) as unknown as typeof fetch
  const client = { clientId: "id", clientSecret: "sec", redirectUri: "https://api.example.com/cb" }
  const set = await exchangeGmailCode(client, { code: "c", codeVerifier: "v" }, { fetch: ok })
  expect(set).toMatchObject({ accessToken: "AT", refreshToken: "RT" })
  const bad = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "mal" }), {
      status: 400,
    })) as unknown as typeof fetch
  await expect(
    exchangeGmailCode(client, { code: "c", codeVerifier: "v" }, { fetch: bad }),
  ).rejects.toThrow("invalid_grant")
})

it("refresh distingue revocación (desconectar) de fallo transitorio (reintentar)", async () => {
  const client = { clientId: "id", clientSecret: "sec", redirectUri: "https://x/cb" }
  const revoked = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch
  // Credencial revocada: clase que el worker usa para desactivar el buzón.
  await expect(refreshGmailAccessToken(client, "RT", { fetch: revoked })).rejects.toBeInstanceOf(
    GmailAuthError,
  )
  const transient = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch
  // 500 sin invalid_grant: error genérico reintentable, nunca desactivación.
  const failure = await refreshGmailAccessToken(client, "RT", { fetch: transient }).catch(
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(GmailAuthError)
})

it("revocación best-effort no bloquea la desconexión", async () => {
  const gone = (async () => new Response("", { status: 400 })) as unknown as typeof fetch
  await expect(revokeGmailToken("RT", { fetch: gone })).resolves.toBe(true)
})
