/**
 * La guía de la Ayuda (entrega 7, tablero 19), sin base: que cada respuesta diga bien quién puede,
 * que no nombre lo que no existe y que lleve a pantallas que existen.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type HelpAskAnswer, helpAskQuestion } from "@odentia/contract"
import { describe, expect, it } from "vitest"
import {
  HELP_GUIDE,
  HELP_SCREENS,
  HELP_WORDS,
  helpAnswerFor,
  helpReplyOf,
  helpReplyWithoutAriadna,
  helpScreenOf,
  helpScreenView,
  helpTopics,
  storePath,
  whoCan,
} from "./ayuda.js"
import { ROLE_NAMES, ROLE_PERMISSIONS } from "./permisos.js"

const faqs = HELP_GUIDE.flatMap((group) => group.faqs)

/** Lo que muestra la app del equipo (`apps/web/src`), sin sus pruebas. */
function webSource(): string {
  const root = fileURLToPath(new URL("../../web/src/", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
    .map((file) => readFileSync(join(root, file), "utf8"))
    .join("\n")
}

describe("la guía", () => {
  it("cada pregunta tiene su nombre fijo, único, y cada tema sus preguntas", () => {
    const ids = faqs.map((faq) => faq.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const group of HELP_GUIDE) expect(group.faqs.length, group.id).toBeGreaterThan(0)
    for (const faq of faqs) {
      expect(faq.id, faq.id).toMatch(/^[a-z0-9-]+$/)
      expect(faq.a.length, faq.id).toBeGreaterThan(0)
    }
  })

  it("quién puede sale de los permisos, nunca del texto", () => {
    expect(whoCan("plan")).toBe("Dueño")
    expect(whoCan("configuracion")).toBe("Dueño y Administrador")
    expect(whoCan("pagos.confirmar")).toBe("Dueño, Administrador y Ventas")
    for (const faq of faqs) {
      const named = (["owner", "admin", "sales"] as const).filter((role) =>
        whoCan(faq.needs).includes(ROLE_NAMES[role]),
      )
      const allowed = (["owner", "admin", "sales"] as const).filter((role) =>
        ROLE_PERMISSIONS[role].includes(faq.needs),
      )
      expect(named, faq.id).toEqual(allowed)
      // Las respuestas no nombran roles: si cambia la matriz, no dicen otra cosa que «Lo pueden hacer».
      for (const text of [faq.q, ...faq.a])
        expect(text, faq.id).not.toMatch(/\b(Dueño|Administrador|Ventas)\b/)
    }
  })

  it("no nombra decisiones internas", () => {
    for (const faq of faqs)
      for (const text of [faq.q, ...faq.a])
        expect(text, faq.id).not.toMatch(/\bADR\b|decisión \d|issue|lienzo|tablero/i)
  })

  it("lo que pone entre comillas es lo que dice la pantalla de hoy", () => {
    const source = webSource()
    for (const faq of faqs)
      for (const text of [faq.q, ...faq.a])
        for (const [, quoted] of text.matchAll(/«([^»]+)»/g))
          expect(source.includes(quoted as string), `${faq.id}: «${quoted}»`).toBe(true)
  })

  it("lleva a pantallas que existen", () => {
    const routes = readFileSync(
      fileURLToPath(new URL("../../web/src/main.tsx", import.meta.url)),
      "utf8",
    )
    for (const screen of Object.values(HELP_SCREENS).map((one) => one.path))
      expect(routes.includes(`path: "${screen}"`), screen).toBe(true)
    // La Ayuda es el panel de la cabecera: ya no tiene página.
    expect(routes.includes('path: "/ayuda"')).toBe(false)
  })

  it("viaja entera a Ariadna como el acuerdo la pide: un tema por pantalla, con sus preguntas", () => {
    const guide = helpTopics()
    expect(() =>
      helpAskQuestion.parse({
        question: "¿Cómo subo un producto?",
        screen: "/",
        previous: null,
        guide,
      }),
    ).not.toThrow()
    expect(guide.map((topic) => topic.id)).toEqual(Object.keys(HELP_SCREENS))
    expect(guide.flatMap((topic) => topic.faqs)).toHaveLength(faqs.length)
    expect(guide.find((topic) => topic.id === "marca")).toMatchObject({
      path: "/configuracion/marca",
      title: "Tu marca",
      parent: "Configuración",
    })
    expect(guide.find((topic) => topic.id === "pedidos")?.parent).toBeNull()
    // Los párrafos van unidos, tal cual.
    const pasarA = guide.flatMap((topic) => topic.faqs).find((faq) => faq.id === "pasar-a")
    expect(pasarA?.a).toBe(faqs.find((faq) => faq.id === "pasar-a")?.a.join("\n\n"))
  })
})

const STORE = "6a1d6b52-6f73-4a5c-9b3a-5c0a1d0e2401"

describe("la pantalla donde está", () => {
  it("es la de la ruta dentro de la tienda, la más precisa", () => {
    expect(storePath(`/tiendas/${STORE}/pedidos?pedido=p-1`, STORE)).toBe("/pedidos")
    expect(storePath(`/tiendas/${STORE}`, STORE)).toBe("/")
    expect(helpScreenOf("/")).toBe("inicio")
    expect(helpScreenOf("/catalogo/prod-1")).toBe("catalogo")
    expect(helpScreenOf("/configuracion")).toBe("configuracion")
    expect(helpScreenOf("/configuracion/datos")).toBe("datos")
    expect(helpScreenOf("/configuracion/marca")).toBe("marca")
    expect(helpScreenOf("/clientes/cl-1")).toBe("clientes")
    expect(helpScreenOf("/no-existe")).toBeNull()
  })

  it("sugiere hasta tres preguntas de esa pantalla que su rol puede hacer", () => {
    const owner = helpScreenView("owner", "/pedidos")
    expect(owner.title).toBe("Pedidos")
    expect(owner.suggestions).toHaveLength(3)
    // A Ventas no se le sugiere lo que no puede hacer, aunque abra la pantalla.
    expect(helpScreenView("sales", "/catalogo")).toEqual({ title: "Catálogo", suggestions: [] })
    expect(helpScreenView("sales", "/")).toEqual({
      title: "Inicio",
      suggestions: ["¿Qué me toca hacer hoy?"],
    })
    // Soporte solo mira: nada de pedidos que hacer.
    expect(helpScreenView("support", "/pedidos").suggestions).toEqual([])
    expect(helpScreenView("owner", "/clientes").title).toBe("Clientes")
    expect(helpScreenView("owner", "/no-existe")).toEqual({ title: null, suggestions: [] })
  })

  it("a quien no configura la tienda le explica por qué en Configuración solo ve sus avisos", () => {
    const why = "¿Por qué en Configuración solo veo mis avisos?"
    expect(helpScreenView("sales", "/configuracion/avisos").suggestions).toContain(why)
    // A quien sí la configura no se le pregunta.
    expect(helpScreenView("owner", "/configuracion/avisos").suggestions).not.toContain(why)
    expect(helpScreenView("admin", "/configuracion/avisos").suggestions).not.toContain(why)
    // Soporte no tiene avisos: tampoco se le pregunta.
    expect(helpScreenView("support", "/configuracion/avisos").suggestions).not.toContain(why)
    // Y la respuesta le dice a quién pedírselo.
    expect(helpAnswerFor("sales", STORE, "faq:configuracion-sin-permiso")?.restriction).toContain(
      "Dueño y Administrador",
    )
  })

  it("a quien no configura la tienda le explica por qué en Configuración solo ve sus avisos", () => {
    const why = "¿Por qué en Configuración solo veo mis avisos?"
    expect(helpScreenView("sales", "/configuracion/avisos").suggestions).toContain(why)
    // A quien sí la configura no se le pregunta.
    expect(helpScreenView("owner", "/configuracion/avisos").suggestions).not.toContain(why)
    expect(helpScreenView("admin", "/configuracion/avisos").suggestions).not.toContain(why)
    // Soporte no tiene avisos: tampoco se le pregunta.
    expect(helpScreenView("support", "/configuracion/avisos").suggestions).not.toContain(why)
    // Y la respuesta le dice a quién pedírselo.
    expect(helpAnswerFor("sales", STORE, "faq:configuracion-sin-permiso")?.restriction).toContain(
      "Dueño y Administrador",
    )
  })
})

describe("cada respuesta para el rol de quien pregunta", () => {
  it("Ventas sabe qué no puede, a quién pedírselo, y no va a lo que no abre", () => {
    expect(helpAnswerFor("sales", STORE, "faq:pago-por-confirmar")).toEqual({
      topicId: "pedidos",
      where: "Pedidos",
      text: faqs.find((faq) => faq.id === "pago-por-confirmar")?.a.join("\n\n"),
      path: `/tiendas/${STORE}/pedidos`,
      restriction: null,
    })
    // El stock lo cambian Dueño y Administrador; el catálogo sí lo puede abrir.
    expect(helpAnswerFor("sales", STORE, "faq:cambiar-stock")).toMatchObject({
      path: `/tiendas/${STORE}/catalogo`,
      restriction:
        "Con tu rol (Ventas) no se puede: pídeselo a quien sí puede. Lo pueden hacer: Dueño y Administrador.",
    })
    expect(helpAnswerFor("sales", STORE, "faq:reportes")).toMatchObject({ path: null })
    expect(helpAnswerFor("sales", STORE, "faq:plan")).toMatchObject({
      path: null,
      restriction:
        "Con tu rol (Ventas) no se puede: pídeselo a quien sí puede. Lo puede hacer: Dueño.",
    })
    expect(helpAnswerFor("sales", STORE, "faq:te-toca")?.path).toBe(`/tiendas/${STORE}`)
  })

  it("el Dueño puede todo y va a todo; el Administrador, todo menos el plan", () => {
    for (const faq of faqs) {
      const answer = helpAnswerFor("owner", STORE, `faq:${faq.id}`)
      expect(answer?.restriction, faq.id).toBeNull()
      expect(answer?.path, faq.id).not.toBeNull()
    }
    expect(helpAnswerFor("admin", STORE, "faq:plan")).toMatchObject({ path: null })
    expect(helpAnswerFor("admin", STORE, "faq:cambiar-stock")?.restriction).toBeNull()
  })

  it("soporte, que solo mira, no va a los pedidos y sabe que no puede", () => {
    expect(helpAnswerFor("support", STORE, "faq:anotar-pedido")).toMatchObject({
      path: null,
      restriction: expect.stringContaining("Con tu rol (Soporte de gestorIA) no se puede"),
    })
    expect(helpAnswerFor("support", STORE, "faq:agregar-producto")).toMatchObject({
      path: `/tiendas/${STORE}/catalogo`,
    })
  })

  it("lo que no es de la guía no se responde", () => {
    expect(helpAnswerFor("owner", STORE, "faq:no-existe")).toBeNull()
    expect(helpAnswerFor("owner", STORE, "tema:no-existe")).toBeNull()
    expect(helpAnswerFor("owner", STORE, "tema:toString")).toBeNull()
  })
})

describe("lo que respondió Ariadna, hecho texto", () => {
  const ASK = "0c6f7f4e-4d1b-4f43-9f4f-0b8a9b1f3a11"
  const answer = (parts: Partial<HelpAskAnswer>): HelpAskAnswer => ({
    askId: ASK,
    via: "jev",
    verdict: "ninguna",
    shown: [],
    offered: [],
    written: null,
    ...parts,
  })

  it("seguro: cada respuesta con su pantalla, y la redactada si vino", () => {
    const reply = helpReplyOf(
      answer({
        verdict: "seguro",
        shown: ["faq:cambiar-stock", "tema:pedidos"],
        written: "Unido.",
      }),
      "sales",
      STORE,
    )
    expect(reply).toMatchObject({
      askId: ASK,
      kind: "guia",
      written: "Unido.",
      argos: false,
      basedOn: "La guía de gestorIA: Catálogo y Pedidos.",
    })
    expect(reply.answers.map((one) => [one.where, one.path])).toEqual([
      ["Catálogo", `/tiendas/${STORE}/catalogo`],
      ["Pedidos", `/tiendas/${STORE}/pedidos`],
    ])
    expect(reply.answers[0]?.restriction).toContain("Lo pueden hacer: Dueño y Administrador.")
    expect(reply.answers[1]?.text).toBe(HELP_SCREENS.pedidos.purpose)
  })

  it("seguro con ids que no son de la guía no inventa: no está", () => {
    expect(
      helpReplyOf(answer({ verdict: "seguro", shown: ["faq:otra"] }), "owner", STORE),
    ).toMatchObject({ kind: "nada", say: HELP_WORDS.notInGuide, answers: [] })
  })

  it("duda: las preguntas para elegir, tal cual", () => {
    const reply = helpReplyOf(
      answer({ verdict: "duda", offered: ["faq:link-de-pago", "tema:pagos"] }),
      "owner",
      STORE,
    )
    expect(reply).toMatchObject({ kind: "duda", say: HELP_WORDS.doubt })
    expect(reply.choices).toEqual([
      { question: "¿Cómo le mando un link de pago?", where: "Pedidos" },
      { question: "¿Para qué sirve Cobros?", where: "Cobros" },
    ])
  })

  it("ninguna: no está en la guía", () => {
    expect(helpReplyOf(answer({}), "owner", STORE)).toMatchObject({
      kind: "nada",
      say: HELP_WORDS.notInGuide,
    })
  })

  it("datos: a Reportes si su rol lo ve; si no, a quién pedírselo", () => {
    expect(helpReplyOf(answer({ verdict: "datos" }), "admin", STORE)).toMatchObject({
      kind: "datos",
      argos: false,
      answers: [{ where: "Reportes", path: `/tiendas/${STORE}/reportes` }],
    })
    const sales = helpReplyOf(answer({ verdict: "datos" }), "sales", STORE)
    expect(sales).toMatchObject({ kind: "datos", argos: false, answers: [] })
    expect(sales.say).toContain("Pídeselo a quien ve Reportes: Dueño y Administrador.")
  })

  it("sin Ariadna, solo una pregunta exacta de la guía; lo demás no se inventa", () => {
    const exact = helpReplyWithoutAriadna(
      "como subo un producto con tallas y stock",
      "owner",
      STORE,
      "local-1",
    )
    expect(exact).toMatchObject({
      askId: "local-1",
      kind: "guia",
      written: null,
      answers: [{ where: "Catálogo", path: `/tiendas/${STORE}/catalogo` }],
    })
    expect(
      helpReplyWithoutAriadna("¿Cómo subo un producto?", "owner", STORE, "local-2"),
    ).toMatchObject({ kind: "nada", say: "Ahora no puedo buscar bien en la guía.", answers: [] })
  })
})
