import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import type { KairosChatModel, KairosUse } from "./kairos.js"
import {
  checkSellReply,
  createKairosSeller,
  falseClaims,
  KAIROS_SELL_FALLBACK,
  KAIROS_SELL_HANDOFF,
  KAIROS_SELL_INTRO,
  type KairosSellInput,
  type KairosSellTools,
  SELLER_SYSTEM,
  sellCancelledText,
  sellTimesNotIn,
  sellWhenWords,
} from "./kairos-vende.js"

/** Kairós vende: el recorrido con herramientas y la comprobación antes de enviar, con un modelo guionado. */

// Sábado 14 de noviembre de 2026, 10:00 de Lima.
const now = new Date("2026-11-14T15:00:00Z")
// Lunes 16 a las 10:00 y a las 15:00 de Lima.
const monday10 = new Date("2026-11-16T15:00:00Z")
const monday15 = new Date("2026-11-16T20:00:00Z")

function input(overrides: Partial<KairosSellInput> = {}): KairosSellInput {
  return {
    channel: "whatsapp",
    now,
    firstReply: false,
    product: {
      name: "odentIA",
      audience: "clínicas dentales",
      facts: ["odentIA es el software de Sallca para clínicas dentales."],
      prices: [
        "Programa Fundadores (Fundadores, por invitación): sin cuota, con USD 100 de regalo para los agentes en los primeros 30 días.",
        "Fundadores paga 50 % menos en cada trabajo que el precio de lista durante 12 meses.",
        "Fundadores: Sofi cobra USD 0,05 por responder lo que preguntan (informa), USD 0,50 por gestionar una cita (gestiona).",
      ],
      amounts: [
        { value: 100, currency: "USD" },
        { value: 0.05, currency: "USD" },
        { value: 0.5, currency: "USD" },
      ],
      percents: [50],
    },
    client: { name: "Clínica Sonríe (ficticia)" },
    contact: { name: "Rosa Quispe", hasPhone: true, hasEmail: false },
    displayName: "Rosa",
    history: [{ who: "persona", at: now, text: "Hola, quiero una presentación" }],
    omitted: 0,
    leftContact: { phone: null, email: null },
    proposal: null,
    presentation: null,
    ...overrides,
  }
}

/** Herramientas de mentira que cuentan lo que se les pide. */
function tools(overrides: Partial<KairosSellTools> = {}) {
  const calls: string[] = []
  const base: KairosSellTools = {
    slots: async () => {
      calls.push("slots")
      return [
        { startsAt: monday10, userId: "u-ana", name: "Ana Pérez" },
        { startsAt: monday15, userId: "u-ana", name: "Ana Pérez" },
      ]
    },
    propose: async (slot) => {
      calls.push(`propose:${slot.startsAt.toISOString()}`)
      return { id: "p-1", startsAt: slot.startsAt }
    },
    book: async (id) => {
      calls.push(`book:${id}`)
      return {
        startsAt: monday10,
        assigneeName: "Ana Pérez",
        meetingUrl: "https://meet.example.com/ana",
        confirmation: `Quedó agendada tu presentación de 45 minutos para el ${sellWhenWords(monday10)} (hora de Lima) con Ana Pérez. Es por videollamada: entra a la hora aquí https://meet.example.com/ana`,
      }
    },
    move: async () => {
      throw new Error("no se usa")
    },
    cancel: async () => {
      throw new Error("no se usa")
    },
    saveContact: async (contact) => {
      calls.push("saveContact")
      return contact
    },
    clinicData: async () => {
      calls.push("clinicData")
      return { created: true, similar: [] }
    },
    askGuide: async (question) => {
      calls.push(`askGuide:${question}`)
      return { found: false }
    },
  }
  return { tools: { ...base, ...overrides }, calls }
}

type Step = { tool: string; args?: Record<string, unknown> } | { text: string } | { throws: string }

/** Un modelo que responde lo que dice el guion, paso a paso, y guarda lo que recibió. */
function scripted(steps: Step[]) {
  const seen: BaseMessage[][] = []
  let n = 0
  const invoke = async (messages: BaseMessage[]) => {
    seen.push([...messages])
    // Sin más guion, el modelo insiste con lo último que escribió (así se ve la segunda vez de la comprobación).
    const step = steps[n] ?? [...steps].reverse().find((s) => "text" in s) ?? { text: "Gracias." }
    n += 1
    const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }
    if ("throws" in step) throw new Error(step.throws)
    if ("tool" in step)
      return new AIMessage({
        content: "",
        tool_calls: [{ id: `c${n}`, name: step.tool, args: step.args ?? {} }],
        usage_metadata: usage,
      })
    return new AIMessage({ content: step.text, usage_metadata: usage })
  }
  const model: KairosChatModel = { invoke, bindTools: () => ({ invoke }) }
  return { model, seen }
}

function seller(model: KairosChatModel, timeoutMs?: number) {
  const uses: KairosUse[] = []
  const s = createKairosSeller({
    platform: { openai: { apiKey: "clave-sintetica" }, maxRetries: 0 },
    createModel: async () => model,
    onUse: (use) => {
      uses.push(use)
    },
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  return { seller: s, uses }
}

describe("Kairós vende: la comprobación antes de enviar", () => {
  it("una hora que no ofreció no sale: va el aviso fijo", async () => {
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: "Te puedo dar el martes 17 de noviembre a las 16:00. ¿Te acomoda?" },
    ])
    const t = tools()
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result.kind).toBe("fallo")
    expect(result.text).toBe(KAIROS_SELL_FALLBACK)
    if (result.kind === "fallo") expect(result.why).toMatch(/hora|fecha/)
  })

  it("lo que no pasa la comprobación se reescribe una vez con lo que faltó", async () => {
    const { model, seen } = scripted([
      { text: "Te espero el lunes a las 9:00." },
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { tool: "proponer_hora", args: { referencia: "h1" } },
      { text: "Te propongo el lunes 16 de noviembre a las 10:00 con Ana. ¿Te la confirmo?" },
    ])
    const t = tools()
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result.kind).toBe("respondio")
    const asked = seen[1]?.map((m) => String(m.content)).join("\n") ?? ""
    expect(asked).toContain("Eso no puede salir")
    expect(asked).toContain("ver_horarios")
  })

  it("las horas que devolvió ver_horarios sí salen", async () => {
    const { model, seen } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { tool: "proponer_hora", args: { referencia: "h1" } },
      {
        text: "Te propongo el lunes 16 de noviembre a las 10:00 con Ana. ¿Te la confirmo? También tengo a las 15:00.",
      },
    ])
    const t = tools()
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result).toMatchObject({ kind: "respondio" })
    expect(t.calls).toEqual(["slots", `propose:${monday10.toISOString()}`])
    // El modelo leyó las horas con su referencia y la propuesta, no ids de usuario.
    const lastSeen =
      seen
        .at(-1)
        ?.map((m) => String(m.content))
        .join("\n") ?? ""
    expect(lastSeen).toContain("h1: lunes, 16 de noviembre a las 10:00 con Ana Pérez")
    expect(lastSeen).not.toContain("u-ana")
  })

  it("un precio inventado no sale; uno del plan sí", async () => {
    const invented = scripted([{ text: "El plan cuesta USD 99 al mes." }])
    const bad = await seller(invented.model).seller.answer(input(), tools().tools)
    expect(bad.kind).toBe("fallo")
    if (bad.kind === "fallo") expect(bad.why).toContain("USD 99")

    const real = scripted([
      {
        text: "Como Fundador no pagas cuota y tienes USD 100 de regalo; responder cuesta USD 0,05.",
      },
    ])
    const good = await seller(real.model).seller.answer(input(), tools().tools)
    expect(good.kind).toBe("respondio")
  })

  it("un porcentaje que no es el de la web es un descuento inventado", async () => {
    const off = scripted([{ text: "Te puedo dar 20 % de descuento." }])
    expect((await seller(off.model).seller.answer(input(), tools().tools)).kind).toBe("fallo")
    const web = scripted([{ text: "Fundadores paga 50 % menos en cada trabajo." }])
    expect((await seller(web.model).seller.answer(input(), tools().tools)).kind).toBe("respondio")
  })

  it("un descuento lo pasa al equipo con el mensaje fijo, sin redactar", async () => {
    const { model } = scripted([
      { tool: "pasar_al_equipo", args: { motivo: "Pide un descuento" } },
      { text: "Claro, te hago 30 % de descuento." },
    ])
    const result = await seller(model).seller.answer(input({ firstReply: true }), tools().tools)
    expect(result).toEqual({
      kind: "paso",
      text: `${KAIROS_SELL_INTRO} ${KAIROS_SELL_HANDOFF}`,
      why: "Pide un descuento",
    })
  })

  it("agendar solo confirma la hora que ya esperaba su sí, y la confirmación la pone el código", async () => {
    // Sin una propuesta de antes, agendar no agenda.
    const early = scripted([{ tool: "agendar" }, { text: "Listo." }])
    const t1 = tools()
    const r1 = await seller(early.model).seller.answer(input(), t1.tools)
    expect(t1.calls).toEqual([])
    expect(r1.kind).toBe("respondio")

    const { model } = scripted([{ tool: "agendar" }, { text: "¡Perfecto, Rosa!" }])
    const t2 = tools()
    const result = await seller(model).seller.answer(
      input({
        proposal: { id: "p-1", startsAt: monday10, assigneeName: "Ana Pérez" },
        history: [{ who: "persona", at: now, text: "sí, esa" }],
      }),
      t2.tools,
    )
    expect(t2.calls).toEqual(["book:p-1"])
    expect(result.kind).toBe("respondio")
    expect(result.text).toContain("lunes, 16 de noviembre a las 10:00 (hora de Lima) con Ana Pérez")
    expect(result.text).toContain("https://meet.example.com/ana")
  })

  it("una referencia que no salió de ver_horarios no propone nada", async () => {
    const { model, seen } = scripted([
      { tool: "proponer_hora", args: { referencia: "h9" } },
      { text: "¿Qué día te acomoda?" },
    ])
    const t = tools()
    await seller(model).seller.answer(input(), t.tools)
    expect(t.calls).toEqual([])
    expect(String(seen.at(-1)?.at(-1)?.content)).toContain("no salió de ver_horarios")
  })

  it("si el modelo falla o tarda, va el aviso fijo", async () => {
    const broken = scripted([{ throws: "503 del proveedor" }])
    const failed = await seller(broken.model).seller.answer(input(), tools().tools)
    expect(failed).toMatchObject({ kind: "fallo", text: KAIROS_SELL_FALLBACK })

    const slow: KairosChatModel = {
      invoke: () => new Promise(() => {}),
      bindTools: () => ({ invoke: () => new Promise(() => {}) }),
    }
    const late = await seller(slow, 50).seller.answer(input(), tools().tools)
    expect(late).toMatchObject({ kind: "fallo", why: "El modelo tardó demasiado" })
  })

  it("se presenta la primera vez y mide su gasto con el propósito «vende»", async () => {
    const { model, seen } = scripted([{ text: "Te cuento cómo funciona." }])
    const { seller: s, uses } = seller(model)
    const result = await s.answer(input({ firstReply: true }), tools().tools)
    expect(result.text.startsWith(KAIROS_SELL_INTRO)).toBe(true)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({
      purpose: "vende",
      model: "gpt-6-luna",
      inputTokens: 1000,
      outputTokens: 100,
    })
    expect(uses[0]?.costMicros).not.toBeNull()
    // Lo fijo va primero y es el mismo en toda conversación.
    const system = seen[0]?.[0]?.content
    expect(JSON.stringify(system)).toContain("Eres Kairós, el asistente de Sallca")
    expect(SELLER_SYSTEM).toContain("Nunca prometas descuentos")
  })

  it("checkSellReply: los enlaces y las fechas tienen que venir de lo dado", () => {
    const evidence = [
      { source: "Agendada", text: `${sellWhenWords(monday10)} https://meet.example.com/ana` },
    ]
    const allowed = { amounts: [], percents: [] }
    expect(
      checkSellReply(
        "Te espero el lunes 16 de noviembre a las 10:00 en https://meet.example.com/ana",
        evidence,
        allowed,
        now,
      ).ok,
    ).toBe(true)
    const invented = checkSellReply("Entra a https://zoom.us/j/1", evidence, allowed, now)
    expect(invented.ok).toBe(false)
    expect(checkSellReply("¿El 20 de noviembre?", evidence, allowed, now).ok).toBe(false)
  })

  it("puede decir que no hay la hora que le pidieron y ofrecer las libres", async () => {
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      {
        text: "El domingo 15 de noviembre a las 8 de la noche no tengo. Te ofrezco el lunes 16 de noviembre a las 10:00 o a las 15:00. ¿Cuál prefieres?",
      },
    ])
    const asked = input({
      history: [
        { who: "persona", at: now, text: "Hola, quiero una presentación" },
        { who: "kairos", at: now, text: "Claro, ¿qué día te acomoda?" },
        { who: "persona", at: now, text: "¿El domingo 15 de noviembre a las 8 de la noche?" },
      ],
    })
    const result = await seller(model).seller.answer(asked, tools().tools)
    expect(result).toMatchObject({ kind: "respondio" })
  })

  it("la hora que pidió no se ofrece como si estuviera libre, y una inventada tampoco", async () => {
    const history = [
      {
        who: "persona" as const,
        at: now,
        text: "¿El domingo 15 de noviembre a las 8 de la noche?",
      },
    ]
    const offering = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: "Perfecto, te espero el domingo 15 de noviembre a las 8 de la noche." },
    ])
    const bad = await seller(offering.model).seller.answer(input({ history }), tools().tools)
    expect(bad.kind).toBe("fallo")
    const inventing = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: "Esa no la tengo; te ofrezco el martes 17 de noviembre a las 16:00." },
    ])
    const worse = await seller(inventing.model).seller.answer(input({ history }), tools().tools)
    expect(worse.kind).toBe("fallo")
    // Lo que pidió en un mensaje anterior, ya respondido, no cuenta.
    const old = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: "El domingo 15 de noviembre a las 8 de la noche no tengo." },
    ])
    const earlier = await seller(old.model).seller.answer(
      input({
        history: [
          ...history,
          { who: "kairos", at: now, text: "Esa hora no la tengo." },
          { who: "persona", at: now, text: "Ok, ¿y otra?" },
        ],
      }),
      tools().tools,
    )
    expect(earlier.kind).toBe("fallo")
  })
})

describe("Kairós vende: lo que hizo se confirma aunque el modelo no escriba", () => {
  const waiting = {
    proposal: { id: "p-1", startsAt: monday10, assigneeName: "Ana Pérez" },
    history: [{ who: "persona" as const, at: now, text: "sí, confirmado" }],
  }
  const moved = {
    startsAt: monday15,
    assigneeName: "Ana Pérez",
    meetingUrl: null,
    confirmation: `Tu presentación pasó al ${sellWhenWords(monday15)} (hora de Lima), con Ana Pérez. Es por videollamada: Ana Pérez te comparte el enlace antes de empezar.`,
  }

  it("agendó y el modelo no escribió nada: sale la confirmación, no el aviso fijo", async () => {
    const { model } = scripted([{ tool: "agendar" }, { text: "" }])
    const t = tools()
    const result = await seller(model).seller.answer(input(waiting), t.tools)
    expect(t.calls).toEqual(["book:p-1"])
    expect(result.kind).toBe("respondio")
    expect(result.text).toBe(
      `Quedó agendada tu presentación de 45 minutos para el ${sellWhenWords(monday10)} (hora de Lima) con Ana Pérez. Es por videollamada: entra a la hora aquí https://meet.example.com/ana`,
    )
    if (result.kind === "respondio") expect(result.booked?.startsAt).toEqual(monday10)
  })

  it("agendó y lo que escribió no pasa la comprobación: sale solo la confirmación", async () => {
    const { model } = scripted([
      { tool: "agendar" },
      { text: "¡Listo! Te espero también el martes 17 de noviembre a las 16:00." },
    ])
    const result = await seller(model).seller.answer(
      input({ ...waiting, firstReply: true }),
      tools().tools,
    )
    expect(result.kind).toBe("respondio")
    expect(result.text.startsWith(KAIROS_SELL_INTRO)).toBe(true)
    expect(result.text).toContain("Quedó agendada tu presentación")
    expect(result.text).not.toContain("16:00")
  })

  it("agendó y después el modelo falló o no terminó: también la confirmación", async () => {
    const broken = scripted([{ tool: "agendar" }, { throws: "503 del proveedor" }])
    const failed = await seller(broken.model).seller.answer(input(waiting), tools().tools)
    expect(failed.kind).toBe("respondio")
    expect(failed.text).toContain("Quedó agendada")

    const endless = scripted([
      { tool: "agendar" },
      ...Array.from({ length: 6 }, () => ({
        tool: "ver_horarios",
        args: { desde: null, hasta: null },
      })),
    ])
    const looped = await seller(endless.model).seller.answer(input(waiting), tools().tools)
    expect(looped.kind).toBe("respondio")
    expect(looped.text).toContain("Quedó agendada")
  })

  it("movió y el modelo no escribió nada: sale la confirmación del cambio", async () => {
    const { model } = scripted([{ tool: "mover" }, { text: "   " }])
    const t = tools({ move: async () => moved })
    const result = await seller(model).seller.answer(
      input({
        ...waiting,
        presentation: { startsAt: monday10, assigneeName: "Ana Pérez", meetingUrl: null },
      }),
      t.tools,
    )
    expect(result).toEqual({ kind: "respondio", text: moved.confirmation, booked: moved })
  })

  it("canceló y el modelo no escribió nada: le dice que quedó cancelada", async () => {
    const { model } = scripted([{ tool: "cancelar", args: { motivo: null } }, { text: "" }])
    const t = tools({ cancel: async () => ({ startsAt: monday10 }) })
    const result = await seller(model).seller.answer(
      input({
        history: [{ who: "persona", at: now, text: "quiero cancelar la presentación" }],
        presentation: { startsAt: monday10, assigneeName: "Ana Pérez", meetingUrl: null },
      }),
      t.tools,
    )
    expect(result).toEqual({ kind: "respondio", text: sellCancelledText(monday10), booked: null })
    expect(result.text).toContain("lunes, 16 de noviembre a las 10:00 (hora de Lima)")
  })

  it("sin haber hecho nada, el vacío sigue siendo el aviso fijo", async () => {
    const { model } = scripted([{ text: "" }])
    const result = await seller(model).seller.answer(input(), tools().tools)
    expect(result).toMatchObject({ kind: "fallo", why: "El modelo no escribió nada" })
  })
})

describe("Kairós vende: la hora que pidió, en cualquier forma", () => {
  // Solo el lunes a las 15:00 libre: la hora pedida nunca la sustenta una ofrecida.
  const onlyAfternoon = () =>
    tools({ slots: async () => [{ startsAt: monday15, userId: "u-ana", name: "Ana Pérez" }] })
  const cases: Array<[string, string]> = [
    ["¿me agendas el domingo 15 de noviembre a las 10 am?", "a las 10 a. m."],
    ["¿el domingo 15 de noviembre a las 10 a. m.?", "a las 10 am"],
    ["¿el domingo 15 de noviembre a las 10:00?", "a las 10 de la mañana"],
    ["¿el domingo 15 de noviembre a las 10 de la mañana?", "a las 10:00"],
    ["¿el domingo 15 de noviembre a las 8 pm?", "a las 8 p. m."],
    ["¿el domingo 15 de noviembre a las 8 de la noche?", "a las 20:00"],
    ["¿el domingo 15 de noviembre a las 20:00?", "a las 8 de la noche"],
    ["¿el domingo 15 de noviembre a las 8 p. m.?", "a las 8 pm"],
  ]
  it.each(cases)("pidió «%s» y responde «%s» para decir que no está", async (asked, said) => {
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      {
        text: `El domingo 15 de noviembre ${said} no tengo horarios. Te ofrezco el lunes 16 de noviembre a las 15:00. ¿Te acomoda?`,
      },
    ])
    const result = await seller(model).seller.answer(
      input({ history: [{ who: "persona", at: now, text: asked }] }),
      onlyAfternoon().tools,
    )
    expect(result).toMatchObject({ kind: "respondio" })
  })

  it("en otra forma tampoco se ofrece como libre", async () => {
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: "Perfecto, te agendo el domingo 15 de noviembre a las 10 a. m." },
    ])
    const result = await seller(model).seller.answer(
      input({
        history: [{ who: "persona", at: now, text: "¿el domingo 15 de noviembre a las 10 am?" }],
      }),
      onlyAfternoon().tools,
    )
    expect(result.kind).toBe("fallo")
  })
})

describe("Kairós vende: lo mismo dicho dos veces sale una vez", () => {
  it("un párrafo repetido no se envía dos veces", async () => {
    const line =
      "Hola, soy Kairós, el asistente de Sallca. Recibí un archivo que no puedo ver; ¿me lo escribes?"
    const { model } = scripted([{ text: `${line}\n${line}` }])
    const result = await seller(model).seller.answer(input({ firstReply: true }), tools().tools)
    expect(result).toMatchObject({ kind: "respondio", text: line })
  })
})

describe("Kairós vende: las instrucciones", () => {
  it("piden la moneda con cada precio y no tratan Fundadores como un descuento", () => {
    expect(SELLER_SYSTEM).toContain("cada importe con su moneda")
    expect(SELLER_SYSTEM).toContain(
      "por Fundadores o por cuánto se ahorra con Fundadores no es pedir un descuento",
    )
  })
})

describe("Kairós vende: le pregunta a Ariadna por una función", () => {
  const guide =
    "Para firmar el consentimiento en la tablet, abre la atención y toca «Firmar en la tablet»."

  it("lo que dice la guía sustenta lo que sale y lo cuenta en tono de venta", async () => {
    const { model, seen } = scripted([
      { tool: "preguntar_a_ariadna", args: { pregunta: "¿se puede firmar en la tablet?" } },
      {
        text: "Sí: tu paciente firma el consentimiento en la tablet, sin papeles. ¿Quieres verlo en una presentación?",
      },
    ])
    const t = tools({
      askGuide: async (question) => {
        t.calls.push(`askGuide:${question}`)
        return { found: true, texts: [guide] }
      },
    })
    const result = await seller(model).seller.answer(
      input({ history: [{ who: "persona", at: now, text: "¿se puede firmar en la tablet?" }] }),
      t.tools,
    )
    expect(result.kind).toBe("respondio")
    expect(t.calls).toEqual(["askGuide:¿se puede firmar en la tablet?"])
    const lastSeen =
      seen
        .at(-1)
        ?.map((m) => String(m.content))
        .join("\n") ?? ""
    expect(lastSeen).toContain(guide)
    expect(lastSeen).toContain("tono de venta")
  })

  it("lo que la guía no tiene no se afirma: el modelo lo lee así", async () => {
    const { model, seen } = scripted([
      { tool: "preguntar_a_ariadna", args: { pregunta: "¿emite facturas a la SUNAT?" } },
      { text: "Eso te lo muestro en la presentación. ¿Te agendo una?" },
    ])
    const t = tools()
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result.kind).toBe("respondio")
    const lastSeen =
      seen
        .at(-1)
        ?.map((m) => String(m.content))
        .join("\n") ?? ""
    expect(lastSeen).toContain("no lo encuentra")
  })

  it("una hora que dice la guía no sustenta una hora de presentación", async () => {
    const { model } = scripted([
      { tool: "preguntar_a_ariadna", args: { pregunta: "¿manda un resumen semanal?" } },
      { text: "Sí, cada lunes te llega el resumen. ¿Te va la presentación el lunes a las 8:00?" },
    ])
    const t = tools({
      askGuide: async () => ({ found: true, texts: ["El resumen llega cada lunes a las 8:00."] }),
    })
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result.kind).toBe("fallo")
  })

  it("si la guía duda, le pasa las preguntas parecidas para volver a preguntar con una", async () => {
    const { model, seen } = scripted([
      { tool: "preguntar_a_ariadna", args: { pregunta: "¿manda recordatorios?" } },
      { text: "Eso te lo muestro en la presentación. ¿Te agendo una?" },
    ])
    const t = tools({
      askGuide: async () => ({ found: false, close: ["¿Dónde enciendo los recordatorios de cita?"] }),
    })
    await seller(model).seller.answer(input(), t.tools)
    const lastSeen = seen.at(-1)?.map((m) => String(m.content)).join("\n") ?? ""
    expect(lastSeen).toContain("- ¿Dónde enciendo los recordatorios de cita?")
    expect(lastSeen).toContain("tal cual")
  })

  it("las instrucciones mandan preguntarle antes de afirmar una función", () => {
    expect(SELLER_SYSTEM).toContain("preguntar_a_ariadna")
    expect(SELLER_SYSTEM).toMatch(/no digas que el sistema lo hace ni que no lo hace/)
  })

  it("el doble le pregunta y responde con la guía", async () => {
    const fake = createKairosSeller({ platform: { fake: true, maxRetries: 0 }, onUse: () => {} })
    const t = tools({
      askGuide: async () => ({ found: true, texts: [guide] }),
    })
    const result = await fake.answer(
      input({ history: [{ who: "persona", at: now, text: "¿Se puede firmar en la tablet?" }] }),
      t.tools,
    )
    expect(result.kind).toBe("respondio")
    expect(result.text).toContain("tablet")
  })
})

describe("Kairós vende: el doble por reglas", () => {
  const fake = createKairosSeller({ platform: { fake: true, maxRetries: 0 }, onUse: () => {} })

  it("sin clínica pregunta su nombre; con ella y WhatsApp ofrece una hora", async () => {
    const noClinic = await fake.answer(input({ client: null, contact: null }), tools().tools)
    expect(noClinic.kind).toBe("respondio")
    expect(noClinic.text).toContain("¿Cómo se llama tu clínica?")

    const t = tools()
    const offered = await fake.answer(input(), t.tools)
    expect(t.calls).toEqual(["slots", `propose:${monday10.toISOString()}`])
    expect(offered.text).toContain("lunes, 16 de noviembre a las 10:00")
  })

  it("por Instagram pide su contacto antes de ofrecer horas", async () => {
    const t = tools()
    const result = await fake.answer(
      input({ channel: "instagram", contact: { name: "Rosa", hasPhone: false, hasEmail: false } }),
      t.tools,
    )
    expect(t.calls).toEqual([])
    expect(result.text).toContain("WhatsApp")
  })

  it("un descuento va al equipo y un paciente recibe la explicación", async () => {
    const discount = await fake.answer(
      input({ history: [{ who: "persona", at: now, text: "¿Me hacen un descuento?" }] }),
      tools().tools,
    )
    expect(discount.kind).toBe("paso")
    const patient = await fake.answer(
      input({ history: [{ who: "persona", at: now, text: "Hola, me duele una muela" }] }),
      tools().tools,
    )
    expect(patient.kind).toBe("paciente")
  })
})

describe("Kairós vende: después de su tiempo no hace nada", () => {
  const waiting = {
    proposal: { id: "p-1", startsAt: monday10, assigneeName: "Ana Pérez" },
    history: [{ who: "persona" as const, at: now, text: "sí, confirmado" }],
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("lo que el modelo pide después del tiempo no llega a las herramientas", async () => {
    // El modelo tarda y recién entonces pide agendar: el aviso fijo ya salió.
    const invoke = async () => {
      await wait(80)
      return new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "agendar", args: {} }] })
    }
    const late: KairosChatModel = { invoke, bindTools: () => ({ invoke }) }
    const t = tools()
    const result = await seller(late, 20).seller.answer(input(waiting), t.tools)
    expect(result).toMatchObject({ kind: "fallo", why: "El modelo tardó demasiado" })
    await wait(150)
    expect(t.calls).toEqual([])
  })

  it("la herramienta que estaba escribiendo ve el turno cortado", async () => {
    const { model } = scripted([{ tool: "agendar" }, { text: "Listo." }])
    let aborted: boolean | null = null
    const t = tools({
      book: async (_id, ctx) => {
        await wait(80)
        aborted = ctx.signal.aborted
        throw new Error("Se acabó el tiempo de este turno")
      },
    })
    const result = await seller(model, 20).seller.answer(input(waiting), t.tools)
    expect(result.kind).toBe("fallo")
    await wait(150)
    expect(aborted).toBe(true)
  })

  it("lo agendado antes del tiempo sale con su confirmación, no con el aviso fijo", async () => {
    const invoke = async (messages: BaseMessage[]) => {
      if (messages.some((message) => message.getType() === "tool")) {
        await wait(200)
        return new AIMessage({ content: "Listo." })
      }
      return new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "agendar", args: {} }] })
    }
    const model: KairosChatModel = { invoke, bindTools: () => ({ invoke }) }
    const result = await seller(model, 50).seller.answer(input(waiting), tools().tools)
    expect(result.kind).toBe("respondio")
    expect(result.text).toContain("Quedó agendada tu presentación")
  })
})

describe("Kairós vende: no da por hecho lo que no hizo", () => {
  const offered = { tool: "ver_horarios", args: { desde: null, hasta: null } }

  it("decir que agendó, reservó, movió o canceló sin hacerlo no sale", async () => {
    for (const text of [
      "Listo, quedó agendada tu presentación.",
      `Te reservé el ${sellWhenWords(monday10)} con Ana Pérez.`,
      `Listo, el ${sellWhenWords(monday10)} con Ana Pérez.`,
      "Ya la moví al lunes con Ana Pérez.",
      "Cancelé tu presentación.",
    ]) {
      const { model } = scripted([offered, { text }])
      const result = await seller(model).seller.answer(input(), tools().tools)
      expect(result, text).toMatchObject({ kind: "fallo" })
      if (result.kind === "fallo") expect(result.why).toContain("daba por hecho")
    }
  })

  it("preguntar o proponer sí sale", async () => {
    for (const text of [
      `¿Te la agendo para el ${sellWhenWords(monday10)} con Ana Pérez?`,
      `Tengo libre el ${sellWhenWords(monday10)} con Ana Pérez. ¿Te sirve?`,
      "Si me confirmas, queda agendada.",
    ]) {
      const { model } = scripted([offered, { text }])
      const result = await seller(model).seller.answer(input(), tools().tools)
      expect(result, text).toMatchObject({ kind: "respondio" })
    }
  })
})

describe("Kairós vende: los topes pasan al equipo", () => {
  it("un tope del día o una segunda presentación no se insiste: pasa al equipo", async () => {
    for (const code of ["KAIROS_TOPE", "PRESENTATION_EXISTS"]) {
      const { model } = scripted([{ tool: "agendar" }, { text: "Gracias." }])
      const t = tools({
        book: async () => {
          throw Object.assign(new Error(`Kairós llegó al tope (${code})`), { code })
        },
      })
      const result = await seller(model).seller.answer(
        input({
          proposal: { id: "p-1", startsAt: monday10, assigneeName: "Ana Pérez" },
          history: [{ who: "persona", at: now, text: "sí" }],
        }),
        t.tools,
      )
      expect(result).toMatchObject({ kind: "paso", text: KAIROS_SELL_HANDOFF })
      if (result.kind === "paso") expect(result.why).toContain("tope")
    }
  })
})

describe("Kairós vende: lo que da por hecho se mira contra lo que hay", () => {
  const booked = { startsAt: monday10, assigneeName: "Ana Pérez", meetingUrl: null }
  const tomorrow = sellWhenWords(monday10)

  it("recordar la presentación que ya tiene sí sale (el «sí, perfecto» después de agendar o mover)", async () => {
    for (const text of [
      "Perfecto, tu presentación ya quedó agendada. Te esperamos.",
      `Listo, ya quedó movida al ${tomorrow} con Ana Pérez.`,
      `Tu presentación está confirmada para el ${tomorrow}.`,
    ]) {
      const { model } = scripted([{ text }])
      const result = await seller(model).seller.answer(
        input({
          presentation: booked,
          history: [{ who: "persona", at: now, text: "sí, perfecto" }],
        }),
        tools().tools,
      )
      expect(result, text).toMatchObject({ kind: "respondio" })
    }
  })

  it("dar por agendada otra hora que la de su presentación no sale", async () => {
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      { text: `Listo, quedó agendada para el ${sellWhenWords(monday15)} con Ana Pérez.` },
    ])
    const result = await seller(model).seller.answer(input({ presentation: booked }), tools().tools)
    expect(result).toMatchObject({ kind: "fallo" })
    if (result.kind === "fallo")
      expect(result.why).toContain("daba por hecho lo que no hizo (agendar)")
  })

  it("mover en este turno vale como agendada a la hora nueva", async () => {
    const moved = {
      startsAt: monday15,
      assigneeName: "Ana Pérez",
      meetingUrl: null,
      confirmation: `Tu presentación pasó al ${sellWhenWords(monday15)} (hora de Lima), con Ana Pérez.`,
    }
    const { model } = scripted([
      { tool: "mover" },
      { text: `Listo, la moví al ${sellWhenWords(monday15)}; quedó agendada a esa hora.` },
    ])
    const result = await seller(model).seller.answer(
      input({
        presentation: booked,
        proposal: { id: "p-1", startsAt: monday15, assigneeName: "Ana Pérez" },
        history: [{ who: "persona", at: now, text: "sí, a las 3" }],
      }),
      tools({ move: async () => moved }).tools,
    )
    expect(result).toMatchObject({ kind: "respondio" })
    if (result.kind === "respondio") expect(result.text).toContain("la moví")
  })

  it("dar por cancelada la presentación que sigue en pie no sale", async () => {
    const { model } = scripted([{ text: "Listo, tu presentación quedó cancelada." }])
    const result = await seller(model).seller.answer(input({ presentation: booked }), tools().tools)
    expect(result).toMatchObject({ kind: "fallo" })
    if (result.kind === "fallo") expect(result.why).toContain("cancelar")
  })

  it("falseClaims: la regla sin el modelo", () => {
    const none = { presentation: null, booked: null, cancelled: null }
    expect(falseClaims("Quedó agendada tu presentación.", none)).toEqual(["agendar"])
    expect(
      falseClaims("Quedó agendada tu presentación.", { ...none, presentation: booked }),
    ).toEqual([])
    // Si la canceló en este turno, ya no tiene presentación abierta.
    expect(
      falseClaims("Quedó agendada tu presentación.", {
        presentation: booked,
        booked: null,
        cancelled: { startsAt: monday10 },
      }),
    ).toEqual(["agendar"])
    expect(falseClaims("Cancelé tu presentación.", { ...none, presentation: booked })).toEqual([
      "cancelar",
    ])
    expect(
      falseClaims("Cancelé tu presentación.", { ...none, cancelled: { startsAt: monday10 } }),
    ).toEqual([])
  })
})

describe("Kairós vende: las horas se leen igual en la comprobación y en la medición", () => {
  it("«11:00 a. m.» es 11:00, no también 00:00", () => {
    expect(sellTimesNotIn("Sí, tengo el lunes a las 11:00 a. m. con Ana Torres.", [])).toEqual([
      [660],
    ])
    expect(sellTimesNotIn("Sí, tengo el lunes a las 11:00 a. m. con Ana Torres.", [660])).toEqual(
      [],
    )
  })

  it("«11 a. m.», «12:00 p. m.», «12 m.» y «00:00»", () => {
    expect(sellTimesNotIn("el lunes a las 11 a. m.", [660])).toEqual([])
    expect(sellTimesNotIn("el lunes a las 12:00 p. m.", [720])).toEqual([])
    expect(sellTimesNotIn("el lunes a las 12 m.", [720])).toEqual([])
    expect(sellTimesNotIn("el lunes a las 12 m.", [0])).toEqual([[720]])
    expect(sellTimesNotIn("el lunes a las 00:00", [0])).toEqual([])
    expect(sellTimesNotIn("el lunes a las 00:00", [720])).toEqual([[0]])
  })

  it("la comprobación deja salir «11:00 a. m.» y «12 m.» ofrecidas", async () => {
    // Lunes 16 a las 11:00 y a las 12:00 de Lima.
    const at11 = new Date("2026-11-16T16:00:00Z")
    const at12 = new Date("2026-11-16T17:00:00Z")
    const t = tools({
      slots: async () => [
        { startsAt: at11, userId: "u-ana", name: "Ana Pérez" },
        { startsAt: at12, userId: "u-ana", name: "Ana Pérez" },
      ],
    })
    const { model } = scripted([
      { tool: "ver_horarios", args: { desde: null, hasta: null } },
      {
        text: "Tengo el lunes 16 de noviembre a las 11:00 a. m. o a las 12 m. con Ana Pérez. ¿Cuál prefieres?",
      },
    ])
    const result = await seller(model).seller.answer(input(), t.tools)
    expect(result).toMatchObject({ kind: "respondio" })
  })
})

describe("Kairós vende: registra el nombre que dijo", () => {
  const call = (clinica: string) => ({
    tool: "datos_de_la_clinica",
    args: { clinica, persona: null, producto: null, ciudad: null },
  })

  it("«mi consultorio dental» no es un nombre: no registra y le pide el nombre", async () => {
    const { model, seen } = scripted([
      call("Consultorio dental"),
      { text: "¿Cómo se llama tu consultorio?" },
    ])
    const t = tools()
    const result = await seller(model).seller.answer(
      input({
        client: null,
        history: [
          {
            who: "persona",
            at: now,
            text: "hola, quiero info del sistema para mi consultorio dental",
          },
        ],
      }),
      t.tools,
    )
    expect(result).toMatchObject({ kind: "respondio" })
    expect(t.calls).not.toContain("clinicData")
    expect(String(seen[1]?.at(-1)?.content)).toContain("todavía no lo dijo")
  })

  it("un nombre que no escribió la persona tampoco", async () => {
    const { model } = scripted([call("Clínica Dental Sonrisas"), { text: "¿Cómo se llama?" }])
    const t = tools()
    await seller(model).seller.answer(input({ client: null }), t.tools)
    expect(t.calls).not.toContain("clinicData")
  })

  it("el nombre que dijo sí se registra", async () => {
    const { model } = scripted([
      call("Consultorio Dental Santa Rosa"),
      { text: "Gracias, ya la registré." },
    ])
    const t = tools()
    await seller(model).seller.answer(
      input({
        client: null,
        history: [
          {
            who: "persona",
            at: now,
            text: "se llama Consultorio Dental Santa Rosa, estamos en Arequipa",
          },
        ],
      }),
      t.tools,
    )
    expect(t.calls).toContain("clinicData")
  })
})
