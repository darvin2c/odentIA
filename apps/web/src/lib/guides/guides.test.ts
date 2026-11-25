/** Las guías (ADR 0216): cada archivo trae lo que el molde necesita, y lo que enlaza existe. */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cardMeta, dayWords, GUIDES, guidePath, readingMinutes, relatedOf, SHEET_FILES } from "./index"
import { plainText, richParts } from "./rich"
import type { GuideFigure } from "./types"

const PAGES = fileURLToPath(new URL("../../pages/guias/", import.meta.url))
const ALL_PAGES = fileURLToPath(new URL("../../pages", import.meta.url))
const PUBLIC = fileURLToPath(new URL("../../../public", import.meta.url))
const HERE = fileURLToPath(new URL(".", import.meta.url))

describe("cada guía", () => {
  it("tiene su página, su fecha y lo que pide el molde", () => {
    const slugs = new Set<string>()
    for (const guide of GUIDES) {
      expect(slugs.has(guide.slug), guide.slug).toBe(false)
      slugs.add(guide.slug)
      expect(guide.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(existsSync(`${PAGES}${guide.slug}.astro`), `falta src/pages/guias/${guide.slug}.astro`).toBe(true)
      expect(guide.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(guide.updated))).toBe(false)
      expect(guide.short, guide.slug).toHaveLength(3)
      expect(guide.steps.length, guide.slug).toBeGreaterThan(1)
      expect(guide.faq.length, guide.slug).toBeGreaterThan(1)
      expect(guide.sheets.length, guide.slug).toBeGreaterThan(0)
      // Lo que Google muestra entero.
      expect(guide.seoTitle.length, guide.seoTitle).toBeLessThanOrEqual(70)
      expect(guide.description.length, guide.description).toBeLessThanOrEqual(170)
    }
  })

  it("sus plantillas existen en la web y sus guías de «Sigue con» también", () => {
    for (const guide of GUIDES) {
      for (const { sheet } of guide.sheets) expect(existsSync(`${PUBLIC}${SHEET_FILES[sheet]}`), SHEET_FILES[sheet]).toBe(true)
      const related = relatedOf(guide)
      expect(related.length, guide.slug).toBeGreaterThan(0)
      expect(related.map((other) => other.slug)).not.toContain(guide.slug)
    }
  })

  it("no lleva cifras de precio de odentIA: el bloque final las lee de Precios", () => {
    for (const guide of GUIDES) {
      const text = JSON.stringify(guide)
      expect(text, guide.slug).not.toMatch(/USD\s?\d|US\$|crédito de/i)
    }
  })

  it("los enlaces del texto van a la propia web y a páginas que existen", () => {
    const pages = new Set(GUIDES.map(guidePath))
    // Una página de la web: su archivo en src/pages (o la de una guía), sin el «#».
    const exists = (href: string) => {
      const path = href.split("#")[0] ?? ""
      return path === "/" || pages.has(path) || existsSync(`${ALL_PAGES}${path}.astro`) || existsSync(`${ALL_PAGES}${path}/index.astro`)
    }
    const figureTexts = (figure?: GuideFigure) =>
      !figure ? [] : figure.kind === "tabla" ? [...figure.rows.flat(), figure.caption ?? ""] : [figure.caption]
    for (const guide of GUIDES) {
      // Todo lo que la página arma con enlaces (`RichText`).
      const texts = [
        ...guide.short,
        guide.tryIt.text,
        ...guide.steps.flatMap((step) => [...step.text, ...(step.list ?? []), ...(step.after ?? []), ...figureTexts(step.figure)]),
      ]
      for (const part of texts.flatMap(richParts))
        if (part.href) expect(exists(part.href), `${guide.slug}: ${part.href}`).toBe(true)
      // Lo que se muestra sin marcas (la portada y las preguntas) no las lleva: se verían tal cual.
      for (const plain of [guide.lead, ...guide.faq.flatMap((item) => [item.q, item.a])])
        expect(plain, `${guide.slug}: ${plain}`).not.toMatch(/\*\*|\]\(/)
    }
  })

  it("el mapa del sitio lee la misma fecha que la página", () => {
    // astro.config.mjs saca la fecha del archivo con esta misma lectura.
    for (const name of readdirSync(HERE).filter((file) => file.endsWith(".ts") && !["index.ts", "types.ts", "rich.ts"].includes(file) && !file.endsWith(".test.ts"))) {
      const text = readFileSync(`${HERE}${name}`, "utf8")
      const slug = text.match(/slug:\s*"([a-z0-9-]+)"/)?.[1]
      const updated = text.match(/updated:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1]
      const guide = GUIDES.find((item) => item.slug === slug)
      expect(guide, name).toBeDefined()
      expect(updated, name).toBe(guide?.updated)
    }
  })

  it("los minutos salen del texto y la tarjeta dice lo que trae", () => {
    const [first] = GUIDES
    if (!first) throw new Error("sin guías")
    expect(readingMinutes(first)).toBeGreaterThanOrEqual(2)
    expect(cardMeta(first)).toMatch(/^\d+ min · /)
    expect(dayWords("2026-11-24")).toBe("24 nov 2026")
  })
})

describe("el texto con marcas", () => {
  it("arma la negrita y los enlaces de la propia web, nunca los de otra", () => {
    expect(richParts("Pinta de **rojo** la cara.")).toEqual([{ text: "Pinta de " }, { text: "rojo", bold: true }, { text: " la cara." }])
    expect(richParts("lo ves en la [guía de niños](/guias/odontograma-en-ninos).")).toEqual([
      { text: "lo ves en la " },
      { text: "guía de niños", href: "/guias/odontograma-en-ninos" },
      { text: "." },
    ])
    expect(richParts("[otra](https://otra.example)")).toEqual([{ text: "otra" }])
    expect(plainText("**CE** (esmalte)")).toBe("CE (esmalte)")
  })
})

describe("las guías en cada web", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("solo odentIA las tiene: en latidIA y vistIA, /guias no existe y el pie no las muestra", async () => {
    for (const product of ["medical", "optical"]) {
      vi.stubEnv("VITE_PRODUCT", product)
      vi.resetModules()
      const { servesPage } = await import("../product")
      const { footerGroups } = await import("../site")
      const { HAS_GUIDES } = await import("./index")
      expect(HAS_GUIDES, product).toBe(false)
      for (const path of ["/guias", "/guias/como-llenar-un-odontograma", "/guias/odontograma-en-ninos", "/guias/presupuesto-dental"])
        expect(servesPage(path), `${product} ${path}`).toBe(false)
      expect(footerGroups.map((group) => group.title), product).not.toContain("Guías")
    }
    vi.stubEnv("VITE_PRODUCT", "dental")
    vi.resetModules()
    const { servesPage } = await import("../product")
    const { footerGroups } = await import("../site")
    expect(servesPage("/guias/presupuesto-dental")).toBe(true)
    expect(footerGroups.find((group) => group.title === "Guías")?.links.map((link) => link.href)).toEqual([
      "/guias/como-llenar-un-odontograma",
      "/guias/odontograma-en-ninos",
      "/guias/presupuesto-dental",
      "/guias",
    ])
  })
})
