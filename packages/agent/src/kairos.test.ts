import type { ServerResponse } from "node:http"
import { describe, expect, it } from "vitest"
import {
  createKairosWriter,
  fakeKairosWriter,
  type KairosClientFacts,
  type KairosUse,
} from "./kairos.js"
import { LlmConfigError } from "./llm.js"
import { cacheMarked, fakeProvider, json, systemBlock, toolCallReply } from "./test-provider.js"

const client: KairosClientFacts = {
  name: "Clínica Sonríe (ficticia)",
  product: "dental",
  city: null,
  stage: "Contacto",
}
const contacts = [
  { id: "c-rosa", name: "Rosa Quispe" },
  { id: "c-luis", name: "Luis Mamani" },
]
const demos = [{ id: "d-1", name: "Sonrisa" }]
// 2026-11-12 es jueves.
const today = "2026-11-12"

function chat(response: ServerResponse, message: Record<string, unknown>) {
  json(response, 200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-6-luna",
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...message },
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 },
  })
}

async function withProvider(
  reply: (n: number, response: ServerResponse, url: string | undefined) => void,
) {
  const provider = await fakeProvider(reply)
  const uses: KairosUse[] = []
  const writer = createKairosWriter({
    platform: {
      openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` },
      maxRetries: 0,
    },
    onUse: (use) => {
      uses.push(use)
    },
  })
  return { provider, uses, writer }
}

describe("fakeKairosWriter", () => {
  it("ordena una llamada con la presentación del jueves a las 10, la demo y su socio", async () => {
    const read = await fakeKairosWriter.parseAnnotation({
      text: "Llamé a Rosa, le gustó. Su socio Pedro Ruiz es quien decide. Presentación el jueves a las 10 con la demo Sonrisa.",
      today,
      client,
      contacts,
      demos,
    })
    expect(read.activity).toMatchObject({
      kind: "llamada",
      direction: "salio",
      contactId: "c-rosa",
    })
    expect(read.task).toEqual({
      kind: "presentacion",
      title: "Presentación",
      dueOn: "2026-11-19",
      dueAt: "2026-11-19T15:00:00.000Z",
      contactId: "c-rosa",
      demoId: "d-1",
    })
    expect(read.newContacts).toEqual([{ name: "Pedro Ruiz", title: "Socio", roles: ["decide"] }])
  })

  it("ordena un WhatsApp sin respuesta con la llamada de mañana, sin hora", async () => {
    const read = await fakeKairosWriter.parseAnnotation({
      text: "Le escribí por WhatsApp a Luis, no contestó. Volver a llamar mañana.",
      today,
      client,
      contacts,
      demos,
    })
    expect(read.activity).toMatchObject({
      kind: "whatsapp",
      direction: "salio",
      outcome: "No contestó",
      contactId: "c-luis",
    })
    expect(read.task).toMatchObject({ kind: "llamar", dueOn: "2026-11-13", dueAt: null })
    expect(read.newContacts).toEqual([])
  })

  it("una nota con datos de la clínica no inventa tarea ni dirección", async () => {
    const read = await fakeKairosWriter.parseAnnotation({
      text: "Son 3 doctores, usan Excel y están en Arequipa.",
      today,
      client,
      contacts,
      demos,
    })
    expect(read.activity).toMatchObject({ kind: "nota", direction: null, contactId: null })
    expect(read.task).toBeNull()
    expect(read.data).toEqual({
      professionals: "2-3",
      currentTool: "cuaderno_excel",
      city: "Arequipa",
    })
  })

  it("redacta correo con asunto y firma, y WhatsApp sin asunto", async () => {
    const mail = await fakeKairosWriter.draftMessage({
      client,
      contact: { name: "Rosa Quispe" },
      channel: "correo",
      goal: "primera_respuesta",
      facts: ["Dejó su solicitud en la web el 10 de noviembre"],
      senderName: "Ana Torres",
    })
    expect(mail.subject).toBe("Tu solicitud de odentIA")
    expect(mail.body.startsWith("Hola, Rosa:")).toBe(true)
    expect(mail.body.endsWith("Ana Torres")).toBe(true)
    const whatsapp = await fakeKairosWriter.draftMessage({
      client,
      channel: "whatsapp",
      goal: "retomar",
      facts: [],
      senderName: "Ana Torres",
    })
    expect(whatsapp.subject).toBeUndefined()
    expect(whatsapp.body).toContain("Hola, equipo de Clínica Sonríe (ficticia):")
  })

  it("resume solo con los hechos y dice lo que falta saber", async () => {
    const facts = [
      { text: "Rosa Quispe es la gerente y decide", source: "contacto:c-rosa" },
      { text: "Le interesa la agenda por WhatsApp", source: "actividad:a-1" },
    ]
    const result = await fakeKairosWriter.summarizeClient({ client, facts })
    expect(result.sources.map((source) => source.source)).toEqual([
      "contacto:c-rosa",
      "actividad:a-1",
    ])
    expect(result.summary).toBe(
      "Rosa Quispe es la gerente y decide. Le interesa la agenda por WhatsApp.",
    )
    expect(result.missing).toEqual([
      "En qué ciudad está",
      "Cuántos profesionales atienden",
      "Qué usa hoy para su agenda e historias",
    ])
  })

  it("con LLM_MODEL=fake y sin modelo inyectado es el doble", () => {
    expect(createKairosWriter({ platform: { fake: true }, onUse: () => {} })).toBe(fakeKairosWriter)
  })
})

describe("createKairosWriter con el proveedor", () => {
  it("sin la clave del proveedor no escribe nada", async () => {
    const writer = createKairosWriter({ platform: {}, onUse: () => {} })
    await expect(writer.weeklySummary({ figures: [] })).rejects.toBeInstanceOf(LlmConfigError)
  })

  it("ordena la anotación con la herramienta, toma solo los ids que conoce y anota el gasto", async () => {
    const args = {
      activity: {
        kind: "llamada",
        direction: "salio",
        outcome: "Quiere verlo",
        body: "Llamé a Rosa.",
        contactId: "c-rosa",
      },
      task: {
        kind: "presentacion",
        title: "Presentar odentIA",
        dueOn: "2026-11-19",
        time: "10:00",
        contactId: "c-inventado",
        demoId: "d-1",
      },
      newContacts: [{ name: "Pedro Ruiz", title: "Socio", roles: ["decide"] }],
      data: { city: null, professionals: "4-9", currentTool: null },
    }
    const { provider, uses, writer } = await withProvider((_n, response) =>
      chat(response, {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "ordenar_anotacion", arguments: JSON.stringify(args) },
          },
        ],
      }),
    )
    try {
      const read = await writer.parseAnnotation({
        text: "Llamé a Rosa…",
        today,
        client,
        contacts,
        demos,
      })
      expect(read).toEqual({
        activity: {
          kind: "llamada",
          direction: "salio",
          outcome: "Quiere verlo",
          body: "Llamé a Rosa.",
          contactId: "c-rosa",
        },
        task: {
          kind: "presentacion",
          title: "Presentar odentIA",
          dueOn: "2026-11-19",
          dueAt: "2026-11-19T15:00:00.000Z",
          contactId: null,
          demoId: "d-1",
        },
        newContacts: [{ name: "Pedro Ruiz", title: "Socio", roles: ["decide"] }],
        data: { professionals: "4-9" },
      })
      const body = provider.requests[0]?.body as {
        tool_choice?: unknown
        messages: Array<{ content: unknown }>
      }
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "ordenar_anotacion" },
      })
      // Lo que cambia (hoy, la anotación) va en el mensaje del turno; lo fijo, marcado para la caché.
      expect(systemBlock(provider.requests[0])).toEqual(cacheMarked("text"))
      expect(JSON.stringify(body.messages[1])).toContain("Hoy: 2026-11-12 (jueves)")
      expect(uses).toEqual([
        {
          purpose: "anotar",
          model: "gpt-6-luna",
          inputTokens: 1_000,
          outputTokens: 200,
          cachedTokens: 0,
          costMicros: 200,
        },
      ])
    } finally {
      await provider.close()
    }
  })

  it("sin la herramienta o con piezas incompletas no rellena: es un error, y lo gastado se anota igual", async () => {
    const { provider, uses, writer } = await withProvider((n, response, url) =>
      n === 1
        ? toolCallReply(response, url, "ordenar_anotacion")
        : chat(response, { content: "Listo, lo anoté." }),
    )
    try {
      const ask = { text: "Llamé a Rosa", today, client, contacts, demos }
      await expect(writer.parseAnnotation(ask)).rejects.toMatchObject({
        code: "KAIROS_UNREADABLE",
        status: 502,
      })
      await expect(writer.parseAnnotation(ask)).rejects.toMatchObject({ code: "KAIROS_UNREADABLE" })
      expect(uses.map((use) => use.purpose)).toEqual(["anotar", "anotar"])
    } finally {
      await provider.close()
    }
  })

  it("redacta el correo con su asunto y anota el borrador", async () => {
    const { provider, uses, writer } = await withProvider((_n, response) =>
      chat(response, {
        content:
          "Asunto: Tu solicitud de odentIA\n\nHola, Rosa:\nGracias por escribirnos.\n\nAna Torres",
      }),
    )
    try {
      const draft = await writer.draftMessage({
        client,
        contact: { name: "Rosa Quispe", title: "Gerente" },
        channel: "correo",
        goal: "primera_respuesta",
        facts: ["Dejó su solicitud en la web el 10 de noviembre"],
        senderName: "Ana Torres",
      })
      expect(draft).toEqual({
        subject: "Tu solicitud de odentIA",
        body: "Hola, Rosa:\nGracias por escribirnos.\n\nAna Torres",
      })
      const human = JSON.stringify(
        (provider.requests[0]?.body as { messages?: unknown[] } | undefined)?.messages?.[1],
      )
      expect(human).toContain("Primera respuesta a quien dejó su solicitud en la web")
      expect(human).toContain("Firma: Ana Torres")
      expect(uses[0]?.purpose).toBe("borrador")
    } finally {
      await provider.close()
    }
  })

  it("el resumen deja fuera la frase sin fuente o con una fuente que no existe", async () => {
    const { provider, writer } = await withProvider((_n, response) =>
      chat(response, {
        content:
          "RESUMEN\n- Rosa decide la compra [H1]\n- Tiene 12 sedes [H9]\n- Sin fuente\n- Le interesa la agenda [H2][H1]\nFALTA\n- Qué usa hoy",
      }),
    )
    try {
      const facts = [
        { text: "Rosa Quispe es la gerente y decide", source: "contacto:c-rosa" },
        { text: "Le interesa la agenda por WhatsApp", source: "actividad:a-1" },
      ]
      const result = await writer.summarizeClient({ client, facts })
      expect(result).toEqual({
        summary: "Rosa decide la compra. Le interesa la agenda.",
        sources: [
          { text: "Rosa decide la compra.", source: "contacto:c-rosa" },
          { text: "Le interesa la agenda.", source: "actividad:a-1" },
          { text: "Le interesa la agenda.", source: "contacto:c-rosa" },
        ],
        missing: ["Qué usa hoy"],
      })
    } finally {
      await provider.close()
    }
  })

  it("el resumen semanal no se guarda si cita una cifra que no recibió", async () => {
    let text = "Entraron 3 de 7 clínicas este mes."
    const { provider, writer } = await withProvider((_n, response) =>
      chat(response, { content: text }),
    )
    try {
      const figures = [{ label: "Conversión", words: "3 de 7" }]
      await expect(writer.weeklySummary({ figures })).resolves.toEqual({ text })
      text = "Entraron 3 de 7 clínicas; el mes que viene serán 10."
      await expect(writer.weeklySummary({ figures })).rejects.toMatchObject({
        code: "KAIROS_UNSUPPORTED_FIGURE",
      })
    } finally {
      await provider.close()
    }
  })
})
