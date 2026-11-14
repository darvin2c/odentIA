import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { canAccess, ORG_ROLES, type Permission } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { HELP_TOPICS, helpSmallTalk, helpTopicForScreen, helpWritePermissions, matchHelpTopics, PRODUCT_ONLY_SCREENS } from "./help-guide.js"
import { helpTopicsFor } from "./products.js"
import { describeHelpSearch, helpBanks, measureHelpBank } from "./help-guide-suite.js"
import { exactHelpOption } from "./help.js"

/**
 * La guía de Ariadna contra el código y contra lo que pregunta la gente. Sin
 * base de datos. El CI la corre en todo PR, aunque el cambio no toque servicios:
 * una pantalla que cambia de nombre no puede llegar a main con la guía atrasada.
 * Lo mismo para latidIA está en `medical/help.test.ts`.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n")

const APPS = ["dental-clinic", "medical-clinic", "optical-clinic"] as const
const treeOf = (app: string) =>
  new Set(
    [...read(`apps/${app}/src/routeTree.gen.ts`).matchAll(/fullPath: '([^']+)'/g)].map(
      (match) => (match[1] ?? "").replace(/\/$/, "") || "/",
    ),
  )

describe("la guía coincide con el código", () => {
  it.each(APPS)("cada tema apunta a una pantalla que existe en %s", (app) => {
    const routes = treeOf(app)
    const all = [...routes]
    for (const topic of HELP_TOPICS) {
      expect(routes.has(topic.path), `${topic.id} → ${topic.path} ya no es una pantalla`).toBe(true)
      // `alsoAt` es la raíz de otras direcciones: basta con que exista algo debajo.
      for (const path of topic.alsoAt ?? []) {
        expect(all.some((route) => route === path || route.startsWith(`${path}/`)), `${topic.id} → ${path} ya no existe`).toBe(true)
      }
    }
    expect(new Set(HELP_TOPICS.map((topic) => topic.id)).size).toBe(HELP_TOPICS.length)
    expect(new Set(HELP_TOPICS.map((topic) => topic.path)).size).toBe(HELP_TOPICS.length)
  })

  it.each(APPS)("toda pantalla de la clínica en %s tiene su tema", (app) => {
    const treeText = read(`apps/${app}/src/routeTree.gen.ts`)
    const screens = [...treeText.matchAll(/id: '\/_org\/[^']*'\s+path: '[^']*'\s+fullPath: '([^']+)'/g)].map((match) => (match[1] ?? "").replace(/\/$/, ""))
    expect(screens.length).toBeGreaterThan(30)
    const orphan = screens.filter((path) => !helpTopicForScreen(path) && !PRODUCT_ONLY_SCREENS.includes(path))
    expect(orphan).toEqual([])
  })

  it("lo que solo muestra un producto tiene su tema en la guía de ese producto", () => {
    for (const path of PRODUCT_ONLY_SCREENS) {
      const owners = CLINICAL_PRODUCTS.filter((product) => helpTopicsFor(product).some((topic) => topic.path === path))
      expect(owners.length, path).toBeGreaterThan(0)
      expect(HELP_TOPICS.some((topic) => topic.path === path), `${path} no va en la guía de odentIA`).toBe(false)
    }
  })

  it("toda entrada del menú y de Configuración tiene su tema, con el mismo nombre", () => {
    const entries = (source: string) =>
      [...source.matchAll(/label: "([^"]+)", to: "([^"]+)"/g)].map((match) => ({ label: match[1] ?? "", to: match[2] ?? "" }))
    const menu = [...entries(read("packages/clinic-app/src/routes/_org.tsx")), ...entries(read("packages/clinic-app/src/routes/_org/settings.tsx"))]
    expect(menu.length).toBeGreaterThan(20)
    for (const item of menu) {
      // Lo que solo muestra un producto se busca en su guía.
      const topics = PRODUCT_ONLY_SCREENS.includes(item.to) ? CLINICAL_PRODUCTS.flatMap((product) => helpTopicsFor(product)) : HELP_TOPICS
      const topic = topics.find((candidate) => candidate.path === item.to)
      expect(topic, `Falta el tema de ${item.label} (${item.to})`).toBeTruthy()
      // La entrada «Configuración» del menú lleva a su primera sección: vale el nombre de la sección o el del grupo.
      expect([topic?.title, topic?.menuLabel, topic?.parent], item.to).toContain(item.label)
    }
  })

  it("cada permiso que nombra un tema existe en la matriz", () => {
    for (const topic of HELP_TOPICS) {
      for (const permission of helpWritePermissions(topic)) {
        expect(ORG_ROLES.some((role) => canAccess(role, permission as Permission)), `${topic.id}: ${permission}`).toBe(true)
      }
    }
    const canChange = (role: string, id: string) =>
      helpWritePermissions(HELP_TOPICS.find((topic) => topic.id === id)!).some((permission) => canAccess(role, permission as Permission))
    // Quien trabaja con ventas renombra las etapas; recepción recibe lo que llega al inventario.
    expect(canChange("reception", "pipelines")).toBe(true)
    expect(canChange("reception", "inventario")).toBe(true)
    // Quien atiende trabaja en la página de sus pacientes, aunque no los registre.
    expect(canChange("clinician", "pacientes")).toBe(true)
  })
})

describeHelpSearch("odentIA", HELP_TOPICS)

describe("la solo lectura por falta de pago", () => {
  const faqsOf = (topicId: string) => HELP_TOPICS.find((topic) => topic.id === topicId)?.faqs ?? []
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null

  it("cómo salir y qué pasa con un comprobante en revisión tienen su respuesta (QA del 11 nov)", () => {
    expect(firstFaq("Mi clínica está en solo lectura, ¿qué hago para volver a usarla?")).toBe("plan-y-pagos-solo-lectura")
    expect(
      firstFaq("Subí mi comprobante antes de que venza el cargo y todavía dice en revisión. ¿Igual me pueden pasar a solo lectura?"),
    ).toBe("plan-y-pagos-comprobante-en-revision")
  })

  it("no promete una prórroga en solo lectura: solo la da un comprobante en los días de gracia (`registerSaasReceipt`)", () => {
    // Lo que dice que un comprobante da más días: solo vale en los días de gracia.
    const answers = faqsOf("plan-y-pagos").filter((faq) => /da (una prórroga|unos días más)/.test(faq.a))
    expect(answers.length).toBeGreaterThan(0)
    for (const faq of answers) expect(faq.a, faq.id).toMatch(/días de gracia/)
    expect(faqsOf("plan-y-pagos").find((faq) => faq.id === "plan-y-pagos-registrar-comprobante")?.a).toContain("en solo lectura ya no da días")
  })
})

describe("saludar y agradecer", () => {
  it("se responden sin buscar", () => {
    expect(helpSmallTalk("Hola")).toContain("soy Ariadna")
    expect(helpSmallTalk("hola Ariadna")).toContain("soy Ariadna")
    expect(helpSmallTalk("¡Muchas gracias!")).toContain("De nada")
    expect(helpSmallTalk("Hola, ¿cómo cambio el logo?")).toBeNull()
  })
})

/** `desarrollo`, `control` y `final` ya se usaron para ajustar: no valen como medida, pero no pueden retroceder. */
describe("lo que se usó para ajustar", () => {
  it("no retrocede", () => {
    // Las 124 de siempre siguen sin fallos. Las 35 de odentIA que se sumaron el 2026-11-10 (lo nuevo de la guía y las de
    // dos partes) no se usaron para ajustar el buscador por palabras, que es solo el respaldo sin Jev: falla 13 de ellas.
    const desarrollo = measureHelpBank(helpBanks.desarrollo, HELP_TOPICS, "odentia")
    expect(desarrollo.bien).toBeGreaterThanOrEqual(138)
    expect(desarrollo.mal).toBeLessThanOrEqual(11)
    expect(desarrollo.noSabe).toBeLessThanOrEqual(2)
    expect(measureHelpBank(helpBanks.control, HELP_TOPICS).bien).toBeGreaterThanOrEqual(130)
    expect(measureHelpBank(helpBanks.final, HELP_TOPICS).bien).toBeGreaterThanOrEqual(85)
  })
})

/** El nombre fijo de cada respuesta: lo usan los videos, el registro y las mediciones. */
describe("cada respuesta tiene su nombre fijo", () => {
  it.each(CLINICAL_PRODUCTS)("único y bien escrito en la guía de %s", (product) => {
    const ids = helpTopicsFor(product).flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.id))
    expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([])
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })
})

// QA del 14 nov (H5 de desarrollo y el auditor): preguntas de «lo que dijo el paciente» que la guía no
// reconocía, sobre todo después de otra pregunta en la misma conversación.
describe("lo que dijo el paciente, con las palabras de quien pregunta", () => {
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null
  it.each([
    ["El paciente puso algo mal, ¿cómo lo corrijo?", "pacientes-cuestionario-corregir-lo-que-puso"],
    ["¿Qué pasa cuando le doy Marcar como revisado?", "pacientes-cuestionario-respondio-antes-de-venir"],
    ["¿Qué significa que diga lo dijo ella sin revisar?", "pacientes-antecedentes-declaracion-original"],
    ["La mamá marcó que no tiene alergias, ¿cuenta como niega?", "pacientes-antecedentes-declaracion-original"],
  ])("«%s»", (question, faq) => {
    expect(firstFaq(question)).toBe(faq)
  })
  it("«El paciente puso algo mal, ¿cómo lo corrijo?» se reconoce tal cual, sin pasar por Jev ni por la pregunta anterior", () => {
    const exact = exactHelpOption("El paciente puso algo mal, ¿cómo lo corrijo?", HELP_TOPICS)
    expect(exact?.kind === "faq" ? exact.faq.id : null).toBe("pacientes-cuestionario-corregir-lo-que-puso")
  })
  it("no promete que lo revisado siga a la vista en la atención firmada", () => {
    const answer = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find(
      (faq) => faq.id === "pacientes-cuestionario-respondio-antes-de-venir",
    )?.a
    expect(answer).not.toContain("sigue a la vista ahí")
    expect(answer).toContain("después de firmarla")
  })
})
