import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { canAccess, ORG_ROLES, type Permission } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { HELP_TOPICS, helpSmallTalk, helpTopicForScreen, helpWritePermissions } from "./help-guide.js"
import { describeHelpSearch, helpBanks, measureHelpBank } from "./help-guide-suite.js"

/**
 * La guía de Ariadna contra el código y contra lo que pregunta la gente. Sin
 * base de datos. El CI la corre en todo PR, aunque el cambio no toque servicios:
 * una pantalla que cambia de nombre no puede llegar a main con la guía atrasada.
 * Lo mismo para latidIA está en `medical/help.test.ts`.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n")

const APPS = ["dental-clinic", "medical-clinic"] as const
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
    const orphan = screens.filter((path) => !helpTopicForScreen(path))
    expect(orphan).toEqual([])
  })

  it("toda entrada del menú y de Configuración tiene su tema, con el mismo nombre", () => {
    const entries = (source: string) =>
      [...source.matchAll(/label: "([^"]+)", to: "([^"]+)"/g)].map((match) => ({ label: match[1] ?? "", to: match[2] ?? "" }))
    const menu = [...entries(read("packages/clinic-app/src/routes/_org.tsx")), ...entries(read("packages/clinic-app/src/routes/_org/settings.tsx"))]
    expect(menu.length).toBeGreaterThan(20)
    for (const item of menu) {
      const topic = HELP_TOPICS.find((candidate) => candidate.path === item.to)
      expect(topic, `Falta el tema de ${item.label} (${item.to})`).toBeTruthy()
      // La entrada «Configuración» del menú lleva a su primera sección: vale el nombre de la sección o el del grupo.
      expect([topic?.title, topic?.parent], item.to).toContain(item.label)
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
    expect(measureHelpBank(helpBanks.desarrollo, HELP_TOPICS)).toMatchObject({ mal: 0, noSabe: 0 })
    expect(measureHelpBank(helpBanks.control, HELP_TOPICS).bien).toBeGreaterThanOrEqual(130)
    expect(measureHelpBank(helpBanks.final, HELP_TOPICS).bien).toBeGreaterThanOrEqual(85)
  })
})
