import { afterEach, describe, expect, it, vi } from "vitest"

/** La web de cada producto (issue 229, decisión 18): latidIA empieza con su web mínima. */
describe("las páginas de cada web", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("latidIA sirve inicio, precios, invitación y legales; lo demás no existe en su dominio", async () => {
    vi.stubEnv("VITE_PRODUCT", "medical")
    const { servesPage, WORDS } = await import("./product")
    expect(WORDS).toMatchObject({ name: "latidIA", clinicians: "médicos" })
    for (const path of [
      "/",
      "/precios",
      "/precios/",
      "/solicitar-invitacion",
      "/terminos",
      "/pe/libro-de-reclamaciones",
    ]) {
      expect(servesPage(path), path).toBe(true)
    }
    // Los archivos no son páginas: se sirven igual.
    for (const path of ["/_astro/hero.js", "/favicon.svg", "/sitemap-index.xml"])
      expect(servesPage(path), path).toBe(true)
    for (const path of [
      "/agenda-odontologica",
      "/contacto",
      "/agentes/recepcion",
      "/historia-clinica-y-odontograma",
    ]) {
      expect(servesPage(path), path).toBe(false)
    }
  })

  it("odentIA sirve todas, con sus palabras", async () => {
    const { servesPage, WORDS } = await import("./product")
    expect(WORDS).toMatchObject({ name: "odentIA", clinicians: "odontólogos" })
    expect(servesPage("/agenda-odontologica")).toBe(true)
  })
})
