import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import whatsappFixtures from "./__fixtures__/whatsapp.json"
import { type ContractFixtures, runAdapterContract } from "./contract.js"
import { buildBody, splitWhatsAppWebhook, whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js"

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
    { url: "https://graph.facebook.com/v25.0/media-1", auth: "Bearer TOKEN" },
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
  expect(got).toEqual({
    externalId: "PNID",
    displayName: "Clínica",
    account: { name: "Clínica", number: "511999888777" },
  })
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

it("lo elegido de una lista llega como un botón: el texto que vio y su identificador", () => {
  const base = { from: "51999000111", timestamp: "1760000000" }
  const got = parse({
    messages: [
      {
        ...base,
        id: "m3",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: {
            id: "sede:sanisidro",
            title: "Sede San Isidro",
            description: "Av. Javier Prado 123",
          },
        },
      },
    ],
  })
  expect(got.messages[0]?.content).toEqual({
    type: "text",
    text: "Sede San Isidro",
    replyId: "sede:sanisidro",
  })
})

it("una reacción se pega al mensaje que la recibió; sin emoji es que la quitó (decisión 7)", () => {
  const base = { from: "51999000111", timestamp: "1760000000" }
  const put = parse({
    messages: [
      {
        ...base,
        id: "m4",
        type: "reaction",
        reaction: { message_id: "wamid.propuesta", emoji: "👍" },
      },
    ],
  })
  expect(put.messages[0]).toMatchObject({
    externalThreadId: "wa:51999000111",
    content: { type: "reaction", targetExternalMessageId: "wamid.propuesta", emoji: "👍" },
  })
  const removed = parse({
    messages: [
      {
        ...base,
        id: "m5",
        type: "reaction",
        reaction: { message_id: "wamid.propuesta", emoji: "" },
      },
    ],
  })
  expect(removed.messages[0]?.content).toEqual({
    type: "reaction",
    targetExternalMessageId: "wamid.propuesta",
    emoji: null,
  })
})

it("una ubicación entra con su nombre y dirección; un reenviado se marca", () => {
  const base = { from: "51999000111", timestamp: "1760000000" }
  const location = parse({
    messages: [
      {
        ...base,
        id: "m6",
        type: "location",
        location: {
          latitude: -12.12,
          longitude: -77.03,
          name: "Dental Smile",
          address: "Av. Larco 345, Miraflores",
        },
      },
    ],
  })
  expect(location.messages[0]?.content).toEqual({
    type: "location",
    latitude: -12.12,
    longitude: -77.03,
    name: "Dental Smile",
    address: "Av. Larco 345, Miraflores",
  })
  const forwarded = parse({
    messages: [
      {
        ...base,
        id: "m7",
        type: "text",
        text: { body: "Promo 2x1" },
        context: { forwarded: true },
      },
    ],
  })
  expect(forwarded.messages[0]).toMatchObject({
    forwarded: true,
    content: { type: "text", text: "Promo 2x1" },
  })
  const many = parse({
    messages: [
      {
        ...base,
        id: "m8",
        type: "text",
        text: { body: "Promo 2x1" },
        context: { frequently_forwarded: true },
      },
    ],
  })
  expect(many.messages[0]?.forwarded).toBe(true)
  expect(
    parse({ messages: [{ ...base, id: "m9", type: "text", text: { body: "Hola" } }] }).messages[0]
      ?.forwarded,
  ).toBeUndefined()
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
    { externalId: "900", name: "odentia_recordatorio_cita_v1", language: "es", category: "utility", status: "aprobada", reason: null, body: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}.", variables: 3, buttons: ["Confirmar", "No podré ir"], link: { title: "Ver", url: "https://x" }, unsupported: null },
    { externalId: "901", name: "promo", language: "es", category: "marketing", status: "rechazada", reason: "INVALID_FORMAT", body: "Oferta", variables: 0, buttons: [], link: null, unsupported: null },
    { externalId: "902", name: "pausada", language: "es_MX", category: "utility", status: "pausada", reason: null, body: "", variables: 0, buttons: [], link: null, unsupported: null },
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

it("pide el botón de «Su enlace» con su dirección fija y el dato al final, antes de los de respuesta", async () => {
  const { calls, fetch } = fakeFetch({ json: { id: "951", status: "PENDING", category: "UTILITY" } })
  await whatsappCloudApiAdapter.requestTemplate!(
    fx.config,
    {
      name: "odentia_aviso_cita_datos_v1", language: "es", category: "utility",
      body: "Hola, {{1}}. Antes de venir, completa tus datos aquí.", examples: ["Pedro"], buttons: ["No enviar más"],
      link: { title: "Ver mi cita y mis datos", url: "https://smile.odentia.app/reserva?token={{1}}", example: "https://smile.odentia.app/reserva?token=abc" },
    },
    { fetch },
  )
  expect(calls[0]?.body).toMatchObject({
    components: [
      { type: "BODY" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Ver mi cita y mis datos", url: "https://smile.odentia.app/reserva?token={{1}}", example: ["https://smile.odentia.app/reserva?token=abc"] },
          { type: "QUICK_REPLY", text: "No enviar más" },
        ],
      },
    ],
  })
})

it("una plantilla con «Su enlace» lleva el token en su botón y corre los de respuesta un lugar", () => {
  const body = buildBody("51999", {
    type: "template", name: "odentia_aviso_cita_datos_v1", language: "es", params: ["Pedro"],
    link: "ab".repeat(32), buttons: [{ id: "odentia:baja:j1", title: "No enviar más" }],
  }) as { template: { components: unknown[] } }
  expect(body.template.components).toEqual([
    { type: "body", parameters: [{ type: "text", text: "Pedro" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ab".repeat(32) }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "odentia:baja:j1" }] },
  ])
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

const SIN_FORMA_DE_PAGO =
  "WhatsApp no envió el mensaje porque la cuenta de WhatsApp de la clínica no tiene una forma de pago. Agrégala en Meta (Configuración de pagos de WhatsApp Business) y vuelve a intentarlo."

it("un envío rechazado porque la cuenta no tiene forma de pago lo dice en palabras", async () => {
  const { fetch } = fakeFetch({
    status: 400,
    json: {
      error: {
        message: "(#131042) Business eligibility payment issue",
        type: "OAuthException",
        code: 131042,
        error_data: { messaging_product: "whatsapp", details: "There was an error related to your payment method." },
      },
    },
  })
  const sent = whatsappCloudApiAdapter.sendMessage(fx.config, { to: "wa:1", kind: { type: "text", text: "Hola" } }, { fetch })
  await expect(sent).rejects.toThrow(SIN_FORMA_DE_PAGO)
  await expect(sent).rejects.not.toThrow(/payment/i)
})

it("un envío rechazado porque la clave de Meta venció lo dice en palabras, con su arreglo", async () => {
  // Lo que responde el Graph API con una clave vencida (darvin2c/odentIA#121).
  const { fetch } = fakeFetch({
    status: 401,
    json: {
      error: {
        message: "Error validating access token: Session has expired on Tuesday, 31-Dec-26 10:00:00 PST.",
        type: "OAuthException",
        code: 190,
        error_subcode: 463,
      },
    },
  })
  const sent = whatsappCloudApiAdapter.sendMessage(fx.config, { to: "wa:1", kind: { type: "text", text: "Hola" } }, { fetch })
  await expect(sent).rejects.toThrow(
    "WhatsApp no envió el mensaje porque la conexión con Meta venció o fue retirada. Vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp.",
  )
  await expect(sent).rejects.not.toThrow(/Session has expired/)
})

it("el aviso de un envío fallido trae el motivo: en palabras si se conoce, con su código si no", () => {
  const failed = (id: string, error: unknown) => ({ id, status: "failed", timestamp: "1760000000", errors: [error] })
  const result = parse({
    metadata: { phone_number_id: "PNID" },
    statuses: [
      failed("wamid.PAGO", { code: 131042, title: "Business eligibility payment issue" }),
      failed("wamid.SINWA", { code: 131026, title: "Message undeliverable" }),
      failed("wamid.OTRO", { code: 131047, title: "Re-engagement message" }),
    ],
  })
  expect(result.statuses).toEqual([
    { externalMessageId: "wamid.PAGO", status: "failed", error: SIN_FORMA_DE_PAGO },
    // 131026: el número no tiene WhatsApp; se dice en palabras y se marca para la ficha.
    {
      externalMessageId: "wamid.SINWA",
      status: "failed",
      error: expect.stringMatching(/no tenga WhatsApp/),
      notOnWhatsApp: true,
    },
    { externalMessageId: "wamid.OTRO", status: "failed", error: "131047: Re-engagement message" },
  ])
  expect(result.statuses[1]?.error).not.toMatch(/undeliverable|131026/i)
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

it("marca lo que odentIA no sabe enviar: encabezado con datos o archivo, o datos por nombre (ADR 0040)", async () => {
  const { fetch } = fakeFetch({
    json: {
      data: [
        { id: "1", name: "con_logo", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hola, {{1}}." }] },
        { id: "2", name: "con_titulo", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "HEADER", format: "TEXT", text: "Tu cita, {{1}}" }, { type: "BODY", text: "Hola." }] },
        { id: "3", name: "titulo_fijo", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "HEADER", format: "TEXT", text: "Clínica" }, { type: "BODY", text: "Hola, {{1}}." }] },
        { id: "4", name: "por_nombre", language: "es", status: "APPROVED", category: "UTILITY", parameter_format: "NAMED", components: [{ type: "BODY", text: "Hola, {{nombre}}." }] },
      ],
    },
  })
  const templates = await whatsappCloudApiAdapter.listTemplates!(fx.config, { fetch })
  expect(templates.map((item) => [item.name, item.unsupported])).toEqual([
    ["con_logo", "encabezado"],
    ["con_titulo", "encabezado"],
    // Un encabezado fijo no pide datos: se puede enviar.
    ["titulo_fijo", null],
    ["por_nombre", "datos_por_nombre"],
  ])
})

it("el aviso de cambio de categoría llega aparte de los estados, y la dirección de la app lo reparte a su cuenta", () => {
  const value = { message_template_id: 952, message_template_name: "odentia_seguimiento_inasistencia_v1", message_template_language: "es", previous_category: "UTILITY", new_category: "MARKETING" }
  const result = parse(value, "template_category_update")
  expect(result.messages).toEqual([])
  expect(result.templateStatuses).toBeUndefined()
  expect(result.templateCategories).toEqual([
    { externalId: "952", name: "odentia_seguimiento_inasistencia_v1", language: "es", category: "marketing", previous: "utility" },
  ])
  const deliveries = splitWhatsAppWebhook(JSON.stringify({ entry: [{ id: "WABA9", changes: [{ field: "template_category_update", value }] }] }))
  expect(deliveries).toEqual([
    { kind: "account", accountId: "WABA9", templateStatuses: [], templateCategories: [expect.objectContaining({ category: "marketing" })], accountEvents: [] },
  ])
})

it("un aviso que no dice el estado de la plantilla no cambia nada, y «reinstated» la vuelve a dejar aprobada", () => {
  const update = (event: string) =>
    parse(
      { event, message_template_id: 951, message_template_name: "odentia_recordatorio_cita_v1", message_template_language: "es", reason: "NONE" },
      "message_template_status_update",
    ).templateStatuses
  expect(update("LOCKED")).toBeUndefined()
  expect(update("UNARCHIVED")).toBeUndefined()
  expect(update("REINSTATED")).toEqual([
    { externalId: "951", name: "odentia_recordatorio_cita_v1", language: "es", status: "aprobada", reason: null },
  ])
  expect(update("DISABLED")?.[0]?.status).toBe("deshabilitada")
})

// ------------------------------------------------------ salud y borrado ---

it("lee la calidad y el tope diario con el campo vigente, y deja sin dato lo que Meta no entrega", async () => {
  const meta = fakeFetch(
    { json: { quality_rating: "GREEN", whatsapp_business_manager_messaging_limit: "TIER_2K", id: "PNID" } },
    { json: { quality_rating: "YELLOW", whatsapp_business_manager_messaging_limit: "TIER_UNLIMITED" } },
    { json: { quality_rating: "UNKNOWN", whatsapp_business_manager_messaging_limit: "TIER_NOT_SET" } },
    { json: { id: "PNID" } },
    { status: 400, json: { error: { message: "(#100) Tried accessing nonexisting field" } } },
  )
  const read = () => whatsappCloudApiAdapter.readHealth!(fx.config, { fetch: meta.fetch })
  expect(await read()).toEqual({ quality: "alta", dailyLimit: 2000, unlimited: false })
  expect(meta.calls[0]?.url).toBe(
    "https://graph.facebook.com/v25.0/PNID?fields=quality_rating,whatsapp_business_manager_messaging_limit",
  )
  expect(await read()).toEqual({ quality: "media", dailyLimit: null, unlimited: true })
  expect(await read()).toEqual({ quality: null, dailyLimit: null, unlimited: false })
  expect(await read()).toEqual({ quality: null, dailyLimit: null, unlimited: false })
  await expect(read()).rejects.toThrow("(#100) Tried accessing nonexisting field")
})

it("elimina una plantilla por su nombre y dice el motivo si Meta no la elimina", async () => {
  const meta = fakeFetch({ json: { success: true } }, { status: 400, json: { error: { message: "(#200) Permissions error" } } })
  await whatsappCloudApiAdapter.deleteTemplate!(fx.config, { name: "clinica_tu_trabajo_ab12cd34" }, { fetch: meta.fetch })
  expect(meta.calls[0]).toMatchObject({
    method: "DELETE",
    url: "https://graph.facebook.com/v25.0/WABA1/message_templates?name=clinica_tu_trabajo_ab12cd34",
  })
  await expect(
    whatsappCloudApiAdapter.deleteTemplate!(fx.config, { name: "x" }, { fetch: meta.fetch }),
  ).rejects.toThrow("(#200) Permissions error")
})

it("bloquea y desbloquea números con la Block Users API y dice cuáles confirmó Meta (ADR 0054)", async () => {
  const meta = fakeFetch(
    { json: { messaging_product: "whatsapp", block_users: { added_users: [{ input: "51999000111", wa_id: "51999000111" }] } } },
    {
      status: 400,
      json: {
        block_users: {
          failed_users: [{ input: "51999000222", errors: [{ code: 139100, message: "Failed to block user" }] }],
        },
        error: { message: "(#139100) Failed to block users" },
      },
    },
    { json: { messaging_product: "whatsapp", block_users: { removed_users: [{ input: "51999000111", wa_id: "51999000111" }] } } },
  )
  const set = (users: string[], blocked: boolean) => whatsappCloudApiAdapter.setBlocked!(fx.config, { users, blocked }, { fetch: meta.fetch })
  expect(await set(["wa:51999000111"], true)).toEqual({ done: ["wa:51999000111"], failed: [] })
  expect(meta.calls[0]).toMatchObject({ method: "POST", url: "https://graph.facebook.com/v25.0/PNID/block_users" })
  expect(meta.calls[0]?.body).toEqual({ messaging_product: "whatsapp", block_users: [{ user: "51999000111" }] })
  // Meta no lo bloqueó (escribió hace más de 24 horas): se dice, no se da por hecho.
  await expect(set(["wa:51999000222"], true)).rejects.toThrow("(#139100) Failed to block users")
  expect(await set(["wa:51999000111"], false)).toEqual({ done: ["wa:51999000111"], failed: [] })
  expect(meta.calls[2]?.method).toBe("DELETE")
})

// Cargas con la forma oficial de Cloud API (mensajes audio, video y sticker).
it("la nota de voz, el audio y el video entran como media; el sticker no entra", () => {
  const contacts = [{ profile: { name: "Ana Paz" }, wa_id: "51999000111" }]
  const metadata = { display_phone_number: "51992154378", phone_number_id: "123456789" }
  const base = { from: "51999000111", timestamp: "1760000000" }
  const got = parse({
    messaging_product: "whatsapp",
    metadata,
    contacts,
    messages: [
      {
        ...base,
        id: "wamid.voz",
        type: "audio",
        audio: { mime_type: "audio/ogg; codecs=opus", sha256: "abc", id: "media-voz", voice: true },
      },
      {
        ...base,
        id: "wamid.audio",
        type: "audio",
        audio: { mime_type: "audio/mpeg", sha256: "def", id: "media-audio", voice: false },
      },
      {
        ...base,
        id: "wamid.video",
        type: "video",
        video: { caption: "Así sangra", mime_type: "video/mp4", sha256: "ghi", id: "media-video" },
      },
      {
        ...base,
        id: "wamid.sticker",
        type: "sticker",
        sticker: { mime_type: "image/webp", sha256: "jkl", id: "media-sticker", animated: false },
      },
    ],
  })
  expect(got.messages.map((m) => [m.externalMessageId, m.content])).toEqual([
    ["wamid.voz", { type: "media", mediaExternalId: "media-voz", mimeType: "audio/ogg; codecs=opus" }],
    ["wamid.audio", { type: "media", mediaExternalId: "media-audio", mimeType: "audio/mpeg" }],
    [
      "wamid.video",
      { type: "media", mediaExternalId: "media-video", mimeType: "video/mp4", caption: "Así sangra" },
    ],
  ])
  expect(got.messages[2]?.senderDisplayName).toBe("Ana Paz")
})

/*
 * Coexistencia: las formas que publica la guía de Meta para un número que sigue
 * en la app WhatsApp Business del celular. No acredita lo que Meta envía de verdad.
 * https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
 */
const metadata = { display_phone_number: "51987654321", phone_number_id: "PNID" }

it("lo que el equipo escribe desde el celular llega en el hilo de la persona, como del equipo", () => {
  const parsed = parse(
    {
      messaging_product: "whatsapp",
      metadata,
      message_echoes: [
        { from: "51987654321", to: "51999000111", id: "wamid.E1", timestamp: "1735689600", type: "text", text: { body: "Te esperamos" } },
        // Una reacción del equipo no es un mensaje que la Bandeja muestre.
        { from: "51987654321", to: "51999000111", id: "wamid.E2", timestamp: "1735689601", type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } },
      ],
    },
    "smb_message_echoes",
  )
  expect(parsed.messages).toEqual([
    {
      externalEventId: "wamid.E1",
      externalMessageId: "wamid.E1",
      externalThreadId: "wa:51999000111",
      senderExternalId: "wa:51999000111",
      sentAt: "2025-01-01T00:00:00.000Z",
      content: { type: "text", text: "Te esperamos" },
      fromBusinessApp: true,
    },
  ])
})

it("el historial trae lo de cada lado con su hora, y dice si la clínica no lo compartió", () => {
  const parsed = parse(
    {
      messaging_product: "whatsapp",
      metadata,
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 100 },
          threads: [
            {
              id: "51999000111",
              messages: [
                { from: "51999000111", id: "wamid.H1", timestamp: "1735689600", type: "text", text: { body: "¿Hay cita?" }, history_context: { status: "DELIVERED" } },
                { from: "51987654321", id: "wamid.H2", timestamp: "1735689660", type: "text", text: { body: "Sí" }, history_context: { status: "READ" } },
              ],
            },
          ],
        },
      ],
    },
    "history",
  )
  expect(parsed.messages.map((m) => [m.externalMessageId, m.externalThreadId, m.fromBusinessApp ?? false, m.history, m.historyStatus])).toEqual([
    ["wamid.H1", "wa:51999000111", false, true, undefined],
    ["wamid.H2", "wa:51999000111", true, true, "read"],
  ])
  expect(parsed.historyDeclined).toBeUndefined()
  const declined = parse({ messaging_product: "whatsapp", metadata, history: [{ errors: [{ code: 2593109, title: "History sync is turned off" }] }] }, "history")
  expect(declined).toEqual({ messages: [], statuses: [], historyDeclined: true })
  // Se reparte al número aunque no traiga mensajes.
  const split = splitWhatsAppWebhook(JSON.stringify({ entry: [{ id: "WABA", changes: [{ field: "history", value: { metadata, history: [{ errors: [{ code: 2593109 }] }] } }] }] }))
  expect(split).toMatchObject([{ kind: "number", phoneNumberId: "PNID", historyDeclined: true }])
})

it("la agenda del celular llega como contactos del canal, sin más", () => {
  const parsed = parse(
    {
      messaging_product: "whatsapp",
      metadata,
      state_sync: [
        { type: "contact", contact: { full_name: "Rosa Quispe", first_name: "Rosa", phone_number: "+51 999 000 111" }, action: "add", metadata: { timestamp: "1735689600" } },
        { type: "contact", contact: { phone_number: "51999000222" }, action: "remove", metadata: { timestamp: "1735689600" } },
        { type: "contact", contact: { full_name: "Sin número" }, action: "add" },
      ],
    },
    "smb_app_state_sync",
  )
  expect(parsed.appContacts).toEqual([
    { externalUserId: "wa:51999000111", name: "Rosa Quispe", removed: false },
    { externalUserId: "wa:51999000222", name: null, removed: true },
  ])
})
