import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import PRODUCT_PAGES from "./product-pages.json"

/** Las direcciones de src/pages: un archivo, una dirección, sin la extensión y sin «/index». */
const PAGES_DIR = fileURLToPath(new URL("../pages", import.meta.url))
function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? pageFiles(join(dir, entry.name)) : entry.name.endsWith(".astro") ? [join(dir, entry.name)] : [],
  )
}
const ROUTES = pageFiles(PAGES_DIR).map(
  (file) => `/${relative(PAGES_DIR, file).replaceAll("\\", "/").replace(/\.astro$/, "").replace(/(^|\/)index$/, "")}`,
)

/** La web de cada producto: una web por producto en el mismo servidor, cada una con sus páginas. */
describe("las páginas de cada web", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("latidIA sirve sus páginas; las de odentIA y las de vistIA no existen en su dominio", async () => {
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
      "/presentacion",
      "/presentacion/fundadores",
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
      "/agenda-para-opticas",
      "/pedidos-de-lentes",
      "/portal-del-cliente",
    ]) {
      expect(servesPage(path), path).toBe(false)
    }
  })

  it("odentIA sirve las suyas, con sus palabras; las propias de latidIA y de vistIA no existen en su dominio", async () => {
    const { servesPage, WORDS, PRODUCT, HAS_CLIO } = await import("./product")
    expect(PRODUCT).toBe("dental")
    expect(WORDS).toMatchObject({ name: "odentIA", clinicians: "odontólogos" })
    expect(HAS_CLIO).toBe(true)
    expect(servesPage("/agenda-odontologica")).toBe(true)
    expect(servesPage("/agentes/recepcion")).toBe(true)
    expect(servesPage("/agentes/asistente-clinico")).toBe(true)
    expect(servesPage("/portal-del-paciente")).toBe(true)
    for (const path of [
      "/historia-clinica-electronica",
      "/receta-y-descanso-medico",
      "/agenda-medica",
      "/radiografias-y-ecografias",
      "/agenda-para-opticas",
      "/pedidos-de-lentes",
      "/portal-del-cliente",
    ])
      expect(servesPage(path), path).toBe(false)
  })

  it("vistIA sirve las de una óptica, con sus palabras y sin Clío", async () => {
    vi.stubEnv("VITE_PRODUCT", "optical")
    const { servesPage, WORDS, AGENTS, HAS_CLIO, BRAND, DEFAULT_DOMAIN } = await import("./product")
    expect(WORDS).toMatchObject({ name: "vistIA", clinician: "optómetra", clinicians: "optómetras", clinic: "óptica", patients: "clientes" })
    expect(BRAND).toBe("vistia")
    expect(DEFAULT_DOMAIN).toBe("vistia.localhost")
    expect(AGENTS).toEqual(["sofi", "argos"])
    expect(HAS_CLIO).toBe(false)
    for (const path of [
      "/",
      "/precios",
      "/solicitar-invitacion",
      "/contacto",
      "/agentes",
      "/agentes/recepcion",
      "/agentes/administrador",
      "/agenda-para-opticas",
      "/historia-clinica-electronica",
      "/pedidos-de-lentes",
      "/omnicanal",
      "/caja-y-cobros",
      "/portal-del-cliente",
      "/reportes",
      "/seguridad",
      "/buscador",
      "/terminos",
      "/privacidad",
      "/cookies",
      "/encargo-de-tratamiento",
      "/subencargados",
      "/aviso-legal",
      "/pe/libro-de-reclamaciones",
    ])
      expect(servesPage(path), path).toBe(true)
    for (const path of [
      // Clío no dicta en una óptica, y vistIA aún no tiene presentación de Fundadores.
      "/agentes/asistente-clinico",
      "/presentacion",
      "/presentacion/fundadores",
      // Lo de odentIA y lo de latidIA.
      "/agenda-odontologica",
      "/historia-clinica-y-odontograma",
      "/radiografias-y-tomografia",
      "/presupuestos-dentales",
      "/varias-sedes",
      "/agenda-medica",
      "/receta-y-descanso-medico",
      "/radiografias-y-ecografias",
      "/portal-del-paciente",
    ])
      expect(servesPage(path), path).toBe(false)
  })

  it("un producto que la web no conoce detiene el armado", async () => {
    vi.stubEnv("VITE_PRODUCT", "veterinary")
    await expect(import("./product")).rejects.toThrow("VITE_PRODUCT=veterinary")
  })

  it("cada página que sirve una web existe, y cada página propia la sirve su web", () => {
    for (const [product, pages] of Object.entries(PRODUCT_PAGES)) {
      for (const path of pages.serves) expect(ROUTES, `${product}: ${path}`).toContain(path)
      for (const path of pages.own) expect(pages.serves, `${product}: ${path}`).toContain(path)
    }
  })
})
