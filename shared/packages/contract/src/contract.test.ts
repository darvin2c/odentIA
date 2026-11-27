import { describe, expect, it } from "vitest"
import {
  accountState,
  adminRequest,
  adminRequestResult,
  appEvent,
  CONTRACT_MAX_EVENT_BYTES,
  CONTRACT_MAX_RECEIPT_BYTES,
  CONTRACT_PATHS,
  HELP_GUIDE_MAX_OPTIONS,
  HELP_GUIDE_MAX_TOPICS,
  helpAskAnswer,
  helpAskQuestion,
  helpFeedback,
  MAX_TEAM_MEMBERS,
  stateQuestion,
} from "./messages.js"
import { isSigningSecret, signMessage, verifySignedMessage } from "./signing.js"

// El ejemplo de la especificación de Standard Webhooks (el mismo de sus bibliotecas oficiales).
const SPEC = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
}
const SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`

describe("la firma del acuerdo (Standard Webhooks)", () => {
  it("firma igual que la especificación", () => {
    expect(
      signMessage({ secret: SPEC.secret, id: SPEC.id, body: SPEC.body, timestamp: SPEC.timestamp })[
        "webhook-signature"
      ],
    ).toBe(SPEC.signature)
  })

  it("acepta lo firmado y rechaza lo cambiado, lo viejo, otro secreto o una clave sin medida", () => {
    const now = new Date("2026-11-22T12:00:00Z")
    const timestamp = Math.floor(now.getTime() / 1000)
    const body = '{"account":"tienda-1"}'
    const headers = new Headers(signMessage({ secret: SECRET, id: "aviso-1", body, timestamp }))
    expect(verifySignedMessage({ secret: SECRET, headers, body, now })).toBe("aviso-1")
    expect(verifySignedMessage({ secret: SECRET, headers, body: `${body} `, now })).toBeNull()
    expect(
      verifySignedMessage({
        secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
        headers,
        body,
        now,
      }),
    ).toBeNull()
    expect(
      verifySignedMessage({
        secret: SECRET,
        headers,
        body,
        now: new Date(now.getTime() + 6 * 60_000),
      }),
    ).toBeNull()
    const long = new Headers(signMessage({ secret: SECRET, id: "x".repeat(201), body, timestamp }))
    expect(verifySignedMessage({ secret: SECRET, headers: long, body, now })).toBeNull()
    expect(isSigningSecret("corto")).toBe(false)
    expect(isSigningSecret(SECRET)).toBe(true)
  })
})

describe("los mensajes del acuerdo", () => {
  const at = "2026-11-22T12:00:00.000Z"

  it("la app avisa que abrió una cuenta, lo que usó y que pide soporte", () => {
    for (const event of [
      {
        type: "cuenta.abierta",
        timestamp: at,
        data: { account: "tienda-1", name: "Calzados Rosa", country: "PE", ownerUserId: "u-1" },
      },
      {
        type: "uso.contado",
        timestamp: at,
        data: {
          account: "tienda-1",
          kind: "conversacion",
          outcome: "pedido",
          conversation: "c-1",
          occurredAt: at,
          channel: "whatsapp",
        },
      },
      {
        type: "soporte.pedido",
        timestamp: at,
        data: { account: "tienda-1", userId: "u-1", kind: "cobro", question: "¿Cómo pago?" },
      },
      // Desde la Ayuda de cualquier rol: la pantalla y el rol van con la pregunta (ADR 0221).
      {
        type: "soporte.pedido",
        timestamp: at,
        data: {
          account: "tienda-1",
          userId: "u-2",
          kind: "pregunta",
          question: "No me deja confirmar el pago",
          screen: "/pedidos?pedido=p-1",
          role: "Ventas",
        },
      },
    ])
      expect(appEvent.safeParse(event).success, event.type).toBe(true)
  })

  it("rechaza lo que no es del acuerdo", () => {
    const bad = [
      { type: "cuenta.cerrada", timestamp: at, data: {} },
      {
        type: "cuenta.abierta",
        timestamp: at,
        data: { account: "t", name: "x", country: "Perú", ownerUserId: "u" },
      },
      {
        type: "cuenta.abierta",
        timestamp: "ayer",
        data: { account: "t", name: "x", country: null, ownerUserId: "u" },
      },
      // El precio nunca lo dice la app.
      {
        type: "uso.contado",
        timestamp: at,
        data: {
          account: "t",
          kind: "conversacion",
          outcome: "cita",
          conversation: "c",
          occurredAt: at,
        },
      },
      {
        type: "soporte.pedido",
        timestamp: at,
        data: { account: "t", userId: "u", kind: "acceso", question: "x" },
      },
      {
        type: "soporte.pedido",
        timestamp: at,
        data: { account: " ", userId: "u", kind: "pregunta", question: "x" },
      },
      {
        type: "soporte.pedido",
        timestamp: at,
        data: {
          account: "t",
          userId: "u",
          kind: "pregunta",
          question: "x",
          screen: "/".repeat(201),
        },
      },
    ]
    for (const event of bad)
      expect(appEvent.safeParse(event).success, JSON.stringify(event)).toBe(false)
  })

  it("la respuesta del estado de una cuenta que no conoce y de una que sí", () => {
    expect(stateQuestion.safeParse({ account: "tienda-1" }).success).toBe(true)
    const unknown = {
      account: "tienda-1",
      found: false,
      at,
      access: null,
      agents: null,
      budget: null,
      plan: null,
      charges: [],
      payments: [],
      notices: [],
      support: [],
    }
    expect(accountState.safeParse(unknown).success).toBe(true)
    const known = {
      ...unknown,
      found: true,
      access: { allowed: true, status: "prueba", reason: null, readOnlyAt: null, trialEndsAt: at },
      agents: { trialExhausted: false, capReached: false },
      budget: {
        currency: "USD",
        creditCents: 0,
        creditUsedCents: 0,
        capCents: null,
        spentCents: 0,
        periodStart: at,
        periodEnd: at,
      },
      plan: { code: "g", name: "Plan", currency: "USD", priceCents: 0, creditCents: 0 },
    }
    expect(accountState.safeParse(known).success).toBe(true)
    expect(
      accountState.safeParse({ ...known, access: { ...known.access, status: "otra" } }).success,
    ).toBe(false)
    // Cada caso dice quién lo abrió; el de una administración que aún no lo manda también entra.
    const kase = { id: "k-1", status: "abierto", question: "Hola", createdAt: at, replies: [] }
    expect(
      accountState.safeParse({ ...known, support: [kase, { ...kase, id: "k-2", userId: "u-2" }] })
        .success,
    ).toBe(true)
  })
})

describe("lo nuevo del acuerdo (ADR 0213)", () => {
  const at = "2026-11-23T12:00:00.000Z"
  const receipt = (base64: string, contentType = "image/png") => ({
    type: "pago.comprobante",
    timestamp: at,
    data: {
      account: "tienda-1",
      userId: "u-1",
      chargeId: "c-1",
      amountCents: 1500,
      methodCode: "yape",
      file: { contentType, base64 },
    },
  })

  it("el comprobante va en base64, con un tipo de la lista y hasta su tope", () => {
    expect(appEvent.safeParse(receipt("iVBORw0KGgo=")).success).toBe(true)
    expect(appEvent.safeParse(receipt("iVBORw0KGgo=", "text/html")).success).toBe(false)
    expect(appEvent.safeParse(receipt("no es base64!")).success).toBe(false)
    const big = "A".repeat(Math.ceil((CONTRACT_MAX_RECEIPT_BYTES * 4) / 3) + 8)
    expect(appEvent.safeParse(receipt(big)).success).toBe(false)
    // El aviso con el archivo más grande cabe en lo que se acepta.
    const largest = JSON.stringify(
      receipt("A".repeat(Math.ceil((CONTRACT_MAX_RECEIPT_BYTES * 4) / 3))),
    )
    expect(largest.length).toBeLessThan(CONTRACT_MAX_EVENT_BYTES)
  })

  it("lo que pide la administración: abrir, dejar entrar a soporte y quitar, con su motivo", () => {
    const owner = { userId: "u-1", name: "Rosa", email: "Rosa@Tienda.test" }
    const open = adminRequest.parse({
      type: "cuenta.abrir",
      timestamp: at,
      data: {
        account: "7d0f1f6e-1d7b-4c43-9a3b-5f3e1d7b4c43",
        name: "Calzados",
        currency: "PEN",
        country: "PE",
        owner,
      },
    })
    expect(open.type === "cuenta.abrir" && open.data.owner.email).toBe("rosa@tienda.test")
    expect(
      adminRequest.safeParse({
        type: "soporte.entrar",
        timestamp: at,
        data: { account: "t", staff: owner, minutes: 30, reason: "Mirar el catálogo" },
      }).success,
    ).toBe(true)
    for (const bad of [
      // La tienda la elige la administración: un id, no un nombre.
      {
        type: "cuenta.abrir",
        timestamp: at,
        data: { account: "tienda", name: "x", currency: "PEN", country: null, owner },
      },
      // Más de una hora, como en las clínicas, no.
      {
        type: "soporte.entrar",
        timestamp: at,
        data: { account: "t", staff: owner, minutes: 120, reason: "Mirar" },
      },
      // Sin motivo, no.
      { type: "equipo.quitar", timestamp: at, data: { account: "t", userId: "u-2", reason: " " } },
      { type: "cuenta.cerrar", timestamp: at, data: { account: "t" } },
    ])
      expect(adminRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(adminRequestResult.safeParse({ status: "hecho", message: null }).success).toBe(true)
    expect(adminRequestResult.safeParse({ status: "listo", message: null }).success).toBe(false)
  })

  it("el equipo de una cuenta va entero, cada persona una vez y con un rol del acuerdo", () => {
    const team = (members: unknown, name: unknown = "Calzados Rosa") => ({
      type: "equipo.cambiado",
      timestamp: at,
      data: { account: "tienda-1", name, members },
    })
    expect(
      appEvent.safeParse(
        team([
          { userId: "u-1", role: "owner" },
          { userId: "u-2", role: "sales" },
        ]),
      ).success,
    ).toBe(true)
    // Ya no queda nadie: también se avisa.
    expect(appEvent.safeParse(team([])).success).toBe(true)
    for (const bad of [
      team([
        { userId: "u-1", role: "owner" },
        { userId: "u-1", role: "admin" },
      ]),
      // El rol es de la lista del acuerdo, no la palabra de la app.
      team([{ userId: "u-1", role: "Dueño" }]),
      team([{ userId: " ", role: "owner" }]),
      team([{ userId: "u-1", role: "owner" }], " "),
      team(
        Array.from({ length: MAX_TEAM_MEMBERS + 1 }, (_, i) => ({
          userId: `u-${i}`,
          role: "sales",
        })),
      ),
    ])
      expect(appEvent.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false)
  })

  it("el estado sin medios de pago (una administración de antes) se lee como lista vacía", () => {
    const parsed = accountState.parse({
      account: "t",
      found: false,
      at,
      access: null,
      agents: null,
      budget: null,
      plan: null,
      charges: [],
      payments: [],
      notices: [],
      support: [],
    })
    expect(parsed.paymentMethods).toEqual([])
  })
})

describe("la app le pregunta a la Ayuda", () => {
  const topic = {
    id: "pedidos",
    path: "/pedidos",
    title: "Pedidos",
    parent: null,
    purpose: "Los pedidos de la tienda.",
    terms: ["ventas"],
    faqs: [{ id: "pedido-anular", q: "¿Cómo anulo un pedido?", a: "Ábrelo y toca «Anular»." }],
  }
  const question = { question: "¿cómo anulo?", screen: "/pedidos", previous: null, guide: [topic] }

  it("lleva la pregunta, la pantalla, la anterior y la guía entera", () => {
    expect(CONTRACT_PATHS.help).toBe("/api/contract/help")
    expect(helpAskQuestion.safeParse(question).success).toBe(true)
    expect(
      helpAskQuestion.safeParse({ ...question, screen: null, previous: { question: "¿y?", where: "Pedidos" } }).success,
    ).toBe(true)
  })

  it("rechaza una guía vacía, de más, con temas o preguntas repetidas, y una pregunta vacía o larga", () => {
    const twice = { ...topic, id: "otro", faqs: topic.faqs }
    for (const bad of [
      { ...question, guide: [] },
      { ...question, guide: Array.from({ length: HELP_GUIDE_MAX_TOPICS + 1 }, (_, i) => ({ ...topic, id: `t${i}`, faqs: [] })) },
      { ...question, guide: [topic, topic] },
      { ...question, guide: [topic, twice] },
      { ...question, question: "  " },
      { ...question, question: "x".repeat(501) },
      { ...question, screen: "/".repeat(201) },
      { question: "¿cómo anulo?", screen: null, guide: [topic] },
    ])
      expect(helpAskQuestion.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false)
  })

  it("la guía suma como mucho lo que Jev mira en dos tandas, entre temas y preguntas frecuentes", () => {
    const guide = (lastFaqs: number) => [
      ...Array.from({ length: 7 }, (_, t) => ({
        ...topic,
        id: `t${t}`,
        faqs: Array.from({ length: 70 }, (_, f) => ({ ...topic.faqs[0]!, id: `t${t}-f${f}` })),
      })),
      { ...topic, id: "ultimo", faqs: Array.from({ length: lastFaqs }, (_, f) => ({ ...topic.faqs[0]!, id: `u-f${f}` })) },
    ]
    expect(HELP_GUIDE_MAX_OPTIONS).toBe(498)
    // 8 temas y 490 preguntas: 498.
    expect(helpAskQuestion.safeParse({ ...question, guide: guide(0) }).success).toBe(true)
    const over = helpAskQuestion.safeParse({ ...question, guide: guide(1) })
    expect(over.success).toBe(false)
    expect(over.error?.issues.map((issue) => issue.message)).toContain(
      "La guía lleva como mucho 498 respuestas entre temas y preguntas frecuentes",
    )
  })

  const ASK_ID = "6f1d8a52-3c1b-4b8e-9f3e-2a7c5d9e0b11"

  it("responde con ids de la guía, nunca frases, y el id de la pregunta", () => {
    const answer = { askId: ASK_ID, via: "jev", verdict: "duda", shown: [], offered: ["faq:pedido-anular", "tema:pedidos"], written: null }
    expect(helpAskAnswer.safeParse(answer).success).toBe(true)
    expect(helpAskAnswer.safeParse({ ...answer, offered: ["¿Cómo anulo un pedido?"] }).success).toBe(false)
    expect(helpAskAnswer.safeParse({ ...answer, via: "exacta" }).success).toBe(false)
    expect(helpAskAnswer.safeParse({ ...answer, askId: "pregunta-1" }).success).toBe(false)
    const { askId: _, ...withoutId } = answer
    expect(helpAskAnswer.safeParse(withoutId).success).toBe(false)
  })

  it("lo que dijo la persona: «¿Te sirvió?» o «Ninguna es lo que busco», uno de los dos", () => {
    expect(CONTRACT_PATHS.helpFeedback).toBe("/api/contract/help/feedback")
    expect(helpFeedback.safeParse({ askId: ASK_ID, helpful: true }).success).toBe(true)
    expect(helpFeedback.safeParse({ askId: ASK_ID, helpful: false }).success).toBe(true)
    expect(helpFeedback.safeParse({ askId: ASK_ID, noneFits: true }).success).toBe(true)
    for (const bad of [
      { askId: ASK_ID },
      { askId: ASK_ID, helpful: true, noneFits: true },
      { askId: ASK_ID, noneFits: false },
      { askId: "pregunta-1", helpful: true },
    ])
      expect(helpFeedback.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})
