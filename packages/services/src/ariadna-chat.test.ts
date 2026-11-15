import { describe, expect, it } from "vitest"
import type { AdminAnswer, AdminDecider, AdminQuestion } from "./admin-request.js"
import {
  ARIADNA_APP_HELP,
  ARIADNA_CHAT_QUESTION,
  ariadnaFixedTexts,
  ariadnaRuleIntent,
  askHelpByChat,
} from "./ariadna-chat.js"
import { helpTopicsFor } from "./products.js"

const ORIGIN = "https://sonrisa.odentia32.com"

/**
 * Un decisor guionado: responde la pregunta de Ariadna con `intent` y, en la
 * Ayuda, elige la pregunta frecuente cuyo texto contiene `faq` (o «ninguna»).
 * Anota lo que le llega para comprobar que no viaja nada de más.
 */
function scripted(options: { intent?: string; faq?: string; data?: number } = {}) {
  const seen: string[] = []
  const decider: AdminDecider = {
    async decide(state: string, questions: AdminQuestion[]) {
      seen.push(state)
      const answers: AdminAnswer[] = questions.map((q) => {
        if (q.kind === "yesno")
          return {
            id: q.id,
            kind: "yesno",
            probability: q.id === "help_data" ? (options.data ?? 0.02) : 0.02,
          }
        if (q.id === ARIADNA_CHAT_QUESTION) {
          const pick = options.intent ?? "guia"
          return {
            id: q.id,
            kind: "choice",
            choice: pick,
            confidence: 0.97,
            probabilities: Object.fromEntries(
              q.options.map((o) => [o.value, o.value === pick ? 0.97 : 0.006]),
            ),
          }
        }
        // `help_area` y `help`: la opción que nombra la pregunta frecuente buscada.
        const wanted = !options.faq
          ? undefined
          : q.id === "help_area"
            ? q.options.find((o) =>
                `${o.value} ${o.description ?? ""}`.toLowerCase().includes("agenda"),
              )
            : q.options.find((o) => (o.description ?? "").includes(options.faq as string))
        const pick = wanted?.value ?? "none"
        return {
          id: q.id,
          kind: "choice",
          choice: pick,
          confidence: 0.96,
          probabilities: Object.fromEntries(
            q.options.map((o) => [o.value, o.value === pick ? 0.96 : 0.04 / q.options.length]),
          ),
        }
      })
      return { answers, model: "guion", usage: null }
    },
  }
  return { decider, seen }
}

describe("Ariadna por chat", () => {
  it("«¿cómo anulo una cita?» responde con la guía, el enlace a la pantalla y se presenta la primera vez", async () => {
    const reply = await askHelpByChat({
      product: "dental",
      question: "como anulo una cita?",
      firstReply: true,
      appOrigin: ORIGIN,
    })
    expect(reply.kind).toBe("respuesta")
    if (reply.kind !== "respuesta") return
    expect(reply.faqId).toBe("agenda-cancelar")
    expect(reply.link).toBe(`${ORIGIN}/agenda`)
    expect(reply.text).toMatch(
      /^Soy Ariadna, la Ayuda de odentIA\.\s+Abre la cita y pulsa «Cancelar cita»/,
    )
    expect(reply.text).toContain(`Te dejo la pantalla: ${ORIGIN}/agenda`)
    expect(reply.text).toContain(ARIADNA_APP_HELP)
    // La segunda vez ya no se presenta.
    const again = await askHelpByChat({
      product: "dental",
      question: "como anulo una cita?",
      appOrigin: ORIGIN,
    })
    expect(again.text.startsWith("Abre la cita")).toBe(true)
  })

  it("sin dirección configurada no inventa un enlace", async () => {
    const reply = await askHelpByChat({
      product: "dental",
      question: "como anulo una cita?",
      appOrigin: null,
    })
    expect(reply.kind === "respuesta" && reply.link).toBe(null)
    expect(reply.text).not.toMatch(/https?:/)
  })

  it("«no me deja» ofrece la Ayuda de la app o Soporte; un sí o insistir lo pasa a Soporte; un no, se despide", async () => {
    const offer = await askHelpByChat({ product: "dental", question: "no me deja entrar a caja" })
    expect(offer.kind).toBe("oferta")
    expect(offer.text).toContain("«Ayuda»")
    expect(offer.text).toContain("¿quieres que te pase?")
    for (const yes of ["si", "Sí, por favor", "ok", "dale pasame", "igual no me deja"]) {
      const handed = await askHelpByChat({ product: "dental", question: yes, offered: true })
      expect(handed.kind, yes).toBe("soporte")
    }
    const no = await askHelpByChat({
      product: "dental",
      question: "no gracias, ya pude",
      offered: true,
    })
    expect(no.kind).toBe("respuesta")
  })

  it("los cobros, su plan, otra sede u otro producto pasan a Administración, aunque la guía hable de cobrar", async () => {
    for (const question of [
      "me cobraron dos veces este mes",
      "por que nos cobraron doble?",
      "quiero cambiar de plan",
      "necesito la factura de mi plan",
      "vamos a abrir otra sede, cuanto sale?",
      "tienen algo para opticas? vistia",
    ]) {
      const reply = await askHelpByChat({ product: "dental", question })
      expect(reply.kind, question).toBe("administracion")
    }
    // Cobrar a un paciente sí es de la guía.
    expect(ariadnaRuleIntent("como registro un cobro de un paciente", "dental")).toBeNull()
    // Nombrar su propio producto no es venta.
    expect(ariadnaRuleIntent("como se usa odentia en el celular", "dental")).toBeNull()
  })

  it("a un paciente le explica que escriba a su clínica", async () => {
    const reply = await askHelpByChat({
      product: "dental",
      question: "hola quiero sacar una cita para mañana me duele la muela",
    })
    expect(reply.kind).toBe("paciente")
    expect(reply.text).toContain("escríbele directamente a tu clínica")
    const optica = await askHelpByChat({
      product: "optical",
      question: "mis lentes ya estan listos?",
    })
    expect(optica.kind).toBe("paciente")
    expect(optica.text).toContain("tu óptica")
  })

  it("una pregunta de datos no da datos: dice dónde verlo en la app", async () => {
    const reply = await askHelpByChat({
      product: "dental",
      question: "cuantas citas tengo mañana?",
      appOrigin: ORIGIN,
    })
    expect(reply.kind).toBe("datos")
    expect(reply.text).toMatch(/^Por aquí no veo los datos de tu clínica: los ves en la app, en /)
    expect(reply.text).not.toMatch(/\d+ citas/)
  })

  it("el decisor aparta un cobro escrito de otra forma, y a él solo viaja el texto sin cifras", async () => {
    const { decider, seen } = scripted({ intent: "cobro" })
    const reply = await askHelpByChat(
      {
        product: "medical",
        question: "oigan me sacaron plata de mas de la tarjeta 4557 8812",
        firstReply: true,
      },
      decider,
    )
    expect(reply.kind).toBe("administracion")
    expect(reply.text.startsWith("Soy Ariadna, la Ayuda de latidIA.")).toBe(true)
    expect(seen.join("\n")).not.toMatch(/\d/)
  })

  it("con el decisor, responde la pregunta frecuente que elige; si duda o no está, no inventa y ofrece Soporte", async () => {
    const cancel = scripted({ faq: "¿Cómo cancelo una cita?" })
    const reply = await askHelpByChat(
      { product: "dental", question: "q hago si el paciente ya no viene", appOrigin: ORIGIN },
      cancel.decider,
    )
    expect(reply.kind === "respuesta" && reply.faqId).toBe("agenda-cancelar")
    const none = scripted({})
    const nothing = await askHelpByChat(
      { product: "dental", question: "como hago una torta de chocolate" },
      none.decider,
    )
    expect(nothing.kind).toBe("oferta")
    expect(nothing.text).toContain("No lo encuentro en la guía")
  })

  it("lo que dice es la guía tal cual o uno de sus textos fijos", async () => {
    const guide = helpTopicsFor("optical")
    const answers = new Set(guide.flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.a)))
    const fixed = ariadnaFixedTexts("optical")
    const reply = await askHelpByChat({ product: "optical", question: "como anulo una cita?" })
    const body = reply.text
    expect(
      [...answers].some((answer) => body.includes(answer)) ||
        fixed.some((text) => body.includes(text)),
    ).toBe(true)
  })

  it("un audio o una foto sin texto: pide que lo escriba", async () => {
    const reply = await askHelpByChat({ product: "dental", question: "" })
    expect(reply.kind).toBe("respuesta")
    expect(reply.text).toContain("no puedo ver audios")
  })
})
