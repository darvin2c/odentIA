/**
 * La guía de la Ayuda (entrega 7, tablero 19), sin base: que cada respuesta diga bien quién puede,
 * que no nombre lo que no existe y que lleve a pantallas que existen.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { HELP_GUIDE, HELP_SCREENS, helpGuideFor, whoCan } from "./ayuda.js"
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

  it("lleva a pantallas que existen, y la Ayuda también existe", () => {
    const routes = readFileSync(
      fileURLToPath(new URL("../../web/src/main.tsx", import.meta.url)),
      "utf8",
    )
    for (const screen of [...Object.values(HELP_SCREENS).map((one) => one.path), "/ayuda"])
      expect(routes.includes(`path: "${screen}"`), screen).toBe(true)
  })
})

describe("la guía para cada rol", () => {
  const find = (seat: Parameters<typeof helpGuideFor>[0], id: string) =>
    helpGuideFor(seat)
      .flatMap((group) => group.faqs)
      .find((faq) => faq.id === id)

  it("Ventas ve todas las preguntas, sabe qué no puede y no va a lo que no abre", () => {
    expect(helpGuideFor("sales").flatMap((group) => group.faqs)).toHaveLength(faqs.length)
    expect(find("sales", "pago-por-confirmar")).toMatchObject({
      you: true,
      who: "Dueño, Administrador y Ventas",
      whoCount: 3,
      screen: { label: "Pedidos", path: "/pedidos" },
    })
    // El stock lo cambian Dueño y Administrador; el catálogo sí lo puede abrir.
    expect(find("sales", "cambiar-stock")).toMatchObject({
      you: false,
      who: "Dueño y Administrador",
      screen: { path: "/catalogo" },
    })
    expect(find("sales", "reportes")).toMatchObject({ you: false, screen: null })
    expect(find("sales", "plan")).toMatchObject({
      you: false,
      who: "Dueño",
      whoCount: 1,
      screen: null,
    })
  })

  it("el Dueño puede todo y va a todo; el Administrador, todo menos el plan", () => {
    for (const faq of helpGuideFor("owner").flatMap((group) => group.faqs)) {
      expect(faq.you, faq.id).toBe(true)
      expect(faq.screen, faq.id).not.toBeNull()
    }
    expect(find("admin", "plan")).toMatchObject({ you: false, screen: null })
    expect(find("admin", "cambiar-stock")).toMatchObject({ you: true })
  })

  it("soporte, que solo mira, no va a los pedidos", () => {
    expect(find("support", "anotar-pedido")).toMatchObject({ you: false, screen: null })
    expect(find("support", "agregar-producto")).toMatchObject({
      you: false,
      screen: { path: "/catalogo" },
    })
  })
})
