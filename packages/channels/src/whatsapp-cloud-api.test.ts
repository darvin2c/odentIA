import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import whatsappFixtures from "./__fixtures__/whatsapp.json"
import { type ContractFixtures, runAdapterContract } from "./contract.js"
import { whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js"

// Golden JSON con forma oficial de Cloud API; el contrato lo valida en runtime.
const fx: ContractFixtures = whatsappFixtures as unknown as ContractFixtures

it("pasa el contrato del adaptador WhatsApp", async () => {
  await runAdapterContract(whatsappCloudApiAdapter, fx)
})

it("verify calcula HMAC sobre el raw exacto", () => {
  const rawBody = '{"object":"whatsapp_business_account"}'
  const sig = `sha256=${createHmac("sha256", "appsecret123").update(rawBody, "utf8").digest("hex")}`
  expect(
    whatsappCloudApiAdapter.verifyWebhook({
      headers: { "X-Hub-Signature-256": sig },
      rawBody,
      config: fx.config,
      webhookSecret: "cualquiera",
    }),
  ).toBe(true)
  expect(
    whatsappCloudApiAdapter.verifyWebhook({
      headers: { "X-Hub-Signature-256": sig },
      rawBody: `${rawBody} `,
      config: fx.config,
      webhookSecret: "cualquiera",
    }),
  ).toBe(false)
})

it("sendMessage exige phoneNumberId", async () => {
  await expect(
    whatsappCloudApiAdapter.sendMessage(
      {},
      { to: "wa:1", kind: { type: "text", text: "hola" } },
      { fetch },
    ),
  ).rejects.toThrow("phoneNumberId")
})

it("fetchMedia resuelve url firmada y descarga con Bearer", async () => {
  const bytes = new TextEncoder().encode("fake-audio")
  const seen: { url: string; auth: string | null }[] = []
  const stub = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(url), auth: init?.headers?.["Authorization"] ?? null })
    if (String(url).includes("graph.facebook.com")) {
      return new Response(
        JSON.stringify({ url: "https://cdn.example.com/m", mime_type: "audio/ogg" }),
        {
          status: 200,
        },
      )
    }
    return new Response(bytes, { status: 200 })
  }) as unknown as typeof fetch
  const got = await whatsappCloudApiAdapter.fetchMedia?.(fx.config, "media-1", { fetch: stub })
  expect(got?.filename).toBe("media-1.ogg")
  expect(got?.mimeType).toBe("audio/ogg")
  expect(seen).toEqual([
    { url: "https://graph.facebook.com/v21.0/media-1", auth: "Bearer TOKEN" },
    { url: "https://cdn.example.com/m", auth: "Bearer TOKEN" },
  ])
})

it("validateConnection usa verified_name", async () => {
  const stub = (async () =>
    new Response(
      JSON.stringify({
        id: "PNID",
        display_phone_number: "511999888777",
        verified_name: "Clínica",
      }),
      { status: 200 },
    )) as unknown as typeof fetch
  const got = await whatsappCloudApiAdapter.validateConnection(fx.config, { fetch: stub })
  expect(got).toEqual({ externalId: "PNID", displayName: "Clínica" })
})

// ------------------------------------------------ plantillas y botones ---

/** `fetch` de prueba: guarda cada llamada y responde lo que se le diga, en orden. */
function fakeFetch(...responses: unknown[]) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const next = responses.shift() as { status?: number; json: unknown } | undefined
    return new Response(JSON.stringify(next?.json ?? {}), { status: next?.status ?? 200 })
  }) as typeof fetch
  return { calls, fetch: impl }
}

function parse(value: unknown, field = "messages") {
  return whatsappCloudApiAdapter.parseWebhook({
    headers: {},
    rawBody: JSON.stringify({ entry: [{ changes: [{ field, value }] }] }),
    config: fx.config,
  })
}

it("envía la plantilla con sus variables y lo que devuelve cada botón", async () => {
  const { calls, fetch } = fakeFetch({ json: { messages: [{ id: "wamid.1" }] } })
  await whatsappCloudApiAdapter.sendMessage(
    fx.config,
    {
      to: "wa:51999000111",
      kind: {
        type: "template",
        name: "odentia_recordatorio_cita_v1",
        language: "es",
        params: ["Lucía", "Clínica Sonríe", "mañana a las 10:00"],
        buttons: [
          { id: "odentia:confirmar:j1", title: "Confirmar" },
          { id: "odentia:no-puedo:j1", title: "No podré ir" },
        ],
      },
    },
    { fetch },
  )
  expect(calls[0]?.body).toMatchObject({
    to: "51999000111",
    type: "template",
    template: {
      name: "odentia_recordatorio_cita_v1",
      language: { code: "es" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "Lucía" }, { type: "text", text: "Clínica Sonríe" }, { type: "text", text: "mañana a las 10:00" }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "odentia:confirmar:j1" }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "odentia:no-puedo:j1" }] },
      ],
    },
  })
})

it("una plantilla sin variables no envía un cuerpo vacío", async () => {
  const { calls, fetch } = fakeFetch({ json: { messages: [{ id: "wamid.2" }] } })
  await whatsappCloudApiAdapter.sendMessage(
    fx.config,
    { to: "wa:1", kind: { type: "template", name: "seguimiento", language: "es", params: [] } },
    { fetch },
  )
  expect((calls[0]?.body as { template: { components: unknown[] } }).template.components).toEqual([])
})

it("dentro de la ventana, el texto con botones sale como mensaje interactivo", async () => {
  const { calls, fetch } = fakeFetch({ json: { messages: [{ id: "wamid.3" }] } })
  await whatsappCloudApiAdapter.sendMessage(
    fx.config,
    {
      to: "wa:1",
      kind: { type: "text", text: "Te esperamos mañana a las 10:00.", buttons: [{ id: "a", title: "Confirmar" }] },
    },
    { fetch },
  )
  expect(calls[0]?.body).toMatchObject({
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Te esperamos mañana a las 10:00." },
      action: { buttons: [{ type: "reply", reply: { id: "a", title: "Confirmar" } }] },
    },
  })
})

it("un botón tocado llega como texto con su identificador, venga de plantilla o de mensaje interactivo", () => {
  const base = { from: "51999000111", timestamp: "1760000000" }
  const quick = parse({ messages: [{ ...base, id: "m1", type: "button", button: { payload: "odentia:confirmar:j1", text: "Confirmar" } }] })
  expect(quick.messages[0]?.content).toEqual({ type: "text", text: "Confirmar", replyId: "odentia:confirmar:j1" })
  const interactive = parse({
    messages: [{ ...base, id: "m2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "odentia:no-puedo:j1", title: "No podré ir" } } }],
  })
  expect(interactive.messages[0]?.content).toEqual({ type: "text", text: "No podré ir", replyId: "odentia:no-puedo:j1" })
})

it("lee las plantillas de la cuenta con estado, categoría, variables y botones, siguiendo las páginas", async () => {
  const { calls, fetch } = fakeFetch(
    {
      json: {
        data: [
          {
            id: "900", name: "odentia_recordatorio_cita_v1", language: "es", status: "APPROVED", category: "UTILITY",
            components: [
              { type: "BODY", text: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}." },
              { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }, { type: "URL", text: "Ver", url: "https://x" }, { type: "QUICK_REPLY", text: "No podré ir" }] },
            ],
          },
          { id: "901", name: "promo", language: "es", status: "REJECTED", category: "MARKETING", rejected_reason: "INVALID_FORMAT", components: [{ type: "BODY", text: "Oferta" }] },
        ],
        paging: { cursors: { after: "c2" }, next: "https://graph.facebook.com/next" },
      },
    },
    { json: { data: [{ id: "902", name: "pausada", language: "es_MX", status: "PAUSED", category: "UTILITY", rejected_reason: "NONE", components: [] }], paging: { cursors: { after: "c3" } } } },
  )
  const templates = await whatsappCloudApiAdapter.listTemplates!(fx.config, { fetch })
  expect(templates).toEqual([
    { externalId: "900", name: "odentia_recordatorio_cita_v1", language: "es", category: "utility", status: "aprobada", reason: null, body: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}.", variables: 3, buttons: ["Confirmar", "No podré ir"] },
    { externalId: "901", name: "promo", language: "es", category: "marketing", status: "rechazada", reason: "INVALID_FORMAT", body: "Oferta", variables: 0, buttons: [] },
    { externalId: "902", name: "pausada", language: "es_MX", category: "utility", status: "pausada", reason: null, body: "", variables: 0, buttons: [] },
  ])
  expect(calls).toHaveLength(2)
  expect(calls[0]?.url).toContain("/message_templates?fields=")
  expect(calls[1]?.url).toContain("after=c2")
})

it("pide la aprobación con un ejemplo por variable y devuelve lo que respondió Meta", async () => {
  const { calls, fetch } = fakeFetch({ json: { id: "950", status: "PENDING", category: "MARKETING" } })
  const result = await whatsappCloudApiAdapter.requestTemplate!(
    fx.config,
    {
      name: "odentia_seguimiento_presupuesto_v1", language: "es", category: "utility",
      body: "Hola, {{1}}. Tu presupuesto «{{2}}» sigue pendiente.", examples: ["Lucía", "Ortodoncia"], buttons: ["Quiero retomarlo"],
    },
    { fetch },
  )
  // Meta puede cambiar la categoría: se devuelve la suya, no la pedida.
  expect(result).toEqual({ externalId: "950", status: "en_revision", category: "marketing" })
  expect(calls[0]).toMatchObject({
    method: "POST",
    body: {
      name: "odentia_seguimiento_presupuesto_v1",
      language: "es",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Hola, {{1}}. Tu presupuesto «{{2}}» sigue pendiente.", example: { body_text: [["Lucía", "Ortodoncia"]] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quiero retomarlo" }] },
      ],
    },
  })
  expect(calls[0]?.url).toMatch(/\/message_templates$/)
})

it("una solicitud que Meta rechaza dice el motivo de Meta", async () => {
  const { fetch } = fakeFetch({ status: 400, json: { error: { message: "(#200) Permissions error" } } })
  await expect(
    whatsappCloudApiAdapter.requestTemplate!(
      fx.config,
      { name: "x", language: "es", category: "utility", body: "Hola", examples: [], buttons: [] },
      { fetch },
    ),
  ).rejects.toThrow("(#200) Permissions error")
})

it("un aviso de cambio de estado de plantilla no se confunde con un mensaje", () => {
  const result = parse(
    { event: "REJECTED", message_template_id: 950, message_template_name: "odentia_seguimiento_presupuesto_v1", message_template_language: "es", reason: "ABUSIVE_CONTENT" },
    "message_template_status_update",
  )
  expect(result.messages).toEqual([])
  expect(result.templateStatuses).toEqual([
    { externalId: "950", name: "odentia_seguimiento_presupuesto_v1", language: "es", status: "rechazada", reason: "ABUSIVE_CONTENT" },
  ])
})
