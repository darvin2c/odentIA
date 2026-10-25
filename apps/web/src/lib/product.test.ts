import { afterEach, describe, expect, it, vi } from "vitest"

/** La web de cada producto: dos webs distintas en el mismo servidor, cada una con sus páginas. */
describe("las páginas de cada web", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("latidIA sirve sus páginas; las de odentIA no existen en su dominio", async () => {
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
      "/agentes",
      "/agentes/recepcion",
      "/historia-clinica-electronica",
      "/receta-y-descanso-medico",
      "/agenda-medica",
      "/reportes",
      "/contacto",
    ]) {
      expect(servesPage(path), path).toBe(true)
    }
    // Los archivos no son páginas: se sirven igual.
    for (const path of ["/_astro/hero.js", "/favicon.svg", "/sitemap-index.xml"])
      expect(servesPage(path), path).toBe(true)
    for (const path of [
      "/agenda-odontologica",
      "/historia-clinica-y-odontograma",
      "/presupuestos-dentales",
      "/whatsapp-para-clinicas-dentales",
      "/varias-sedes",
    ]) {
      expect(servesPage(path), path).toBe(false)
    }
  })

  it("odentIA sirve las suyas, con sus palabras; las propias de latidIA no existen en su dominio", async () => {
    const { servesPage, WORDS } = await import("./product")
    expect(WORDS).toMatchObject({ name: "odentIA", clinicians: "odontólogos" })
    expect(servesPage("/agenda-odontologica")).toBe(true)
    expect(servesPage("/agentes/recepcion")).toBe(true)
    for (const path of ["/historia-clinica-electronica", "/receta-y-descanso-medico", "/agenda-medica"])
      expect(servesPage(path), path).toBe(false)
  })
})
