import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { canAccess, ORG_ROLES, type Permission } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { HELP_TOPICS, type HelpTopic, helpSmallTalk, helpTopicForScreen, matchHelpTopics } from "./help-guide.js"
import { MEDICAL_HELP_TOPICS } from "./medical/help.js"

/**
 * La guía de Ariadna contra el código y contra lo que pregunta la gente. Sin
 * base de datos. El CI la corre en todo PR, aunque el cambio no toque servicios:
 * una pantalla que cambia de nombre no puede llegar a main con la guía atrasada.
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

/** Lo que la pantalla escribe de verdad, sin la guía ni las pruebas. */
function screensText(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__golden__") continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.(test|stories|spec|gen)\./.test(name) && !/^seed|help-guide|medical[\\/]help/.test(name)) {
        if (!/medical[\\/]help\.ts$/.test(path)) out.push(readFileSync(path, "utf8"))
      }
    }
  }
  for (const dir of ["packages/clinic-app/src", "packages/ui-patterns/src", "apps/dental-clinic/src", "apps/medical-clinic/src", "packages/services/src", "packages/clinical/src", "packages/dental/src", "packages/auth/src", "apps/api/src"]) {
    walk(resolve(ROOT, dir))
  }
  return out.join("\n").normalize("NFC").toLowerCase()
}

describe("la guía coincide con el código", () => {
  it.each(APPS)("cada tema apunta a una pantalla que existe en %s", (app) => {
    const routes = treeOf(app)
    for (const topic of HELP_TOPICS) {
      for (const path of [topic.path]) expect(routes.has(path), `${topic.id} → ${path} ya no es una pantalla`).toBe(true)
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
      const needed = typeof topic.writePermission === "string" ? [topic.writePermission] : (topic.writePermission ?? [])
      for (const permission of needed) {
        expect(ORG_ROLES.some((role) => canAccess(role, permission as Permission)), `${topic.id}: ${permission}`).toBe(true)
      }
    }
    // Quien trabaja con ventas renombra las etapas; recepción recibe lo que llega al inventario.
    const reception = (topic: HelpTopic) =>
      (typeof topic.writePermission === "string" ? [topic.writePermission] : (topic.writePermission ?? [])).some((permission) => canAccess("reception", permission as Permission))
    expect(reception(HELP_TOPICS.find((topic) => topic.id === "pipelines")!)).toBe(true)
    expect(reception(HELP_TOPICS.find((topic) => topic.id === "inventario")!)).toBe(true)
  })

  it("lo que cita entre comillas existe en las pantallas", () => {
    const code = screensText()
    /** Se arman con su dato, o son un ejemplo: no están escritos enteros en ninguna parte. */
    const composed = new Set(["Las atiende Sofi", "Lo que Sofi debe saber", "Lo hace Argos", "Comprobé su identidad: vi su documento", "Debe: 100 · A favor: 100 · Saldo: 0"])
    const missing = new Set<string>()
    for (const topic of HELP_TOPICS) {
      const texts = [topic.purpose, ...(topic.faqs ?? []).flatMap((faq) => [faq.q, faq.a])]
      for (const text of texts) {
        for (const match of text.matchAll(/«([^»]+)»/g)) {
          const quoted = (match[1] ?? "").replace(/[.,…:;?¿!¡]+$/g, "").replace(/^¿/, "").trim()
          if (composed.has(quoted) || composed.has(match[1] ?? "")) continue
          const wanted = quoted.normalize("NFC").toLowerCase()
          if (!code.includes(wanted) && !code.includes(wanted.replace(/\bsofi\b/g, "${receptionname}"))) missing.add(quoted)
        }
      }
    }
    expect([...missing].join(" | ")).toBe("")
  })
})

describe.each([
  ["odentIA", HELP_TOPICS],
  ["latidIA", MEDICAL_HELP_TOPICS],
] as const)("buscar en la guía de %s", (_product, topics) => {
  const first = (question: string) => matchHelpTopics(question, topics)[0]?.topic.id ?? null
  const all = (question: string) => matchHelpTopics(question, topics).map((match) => match.topic.id)

  it("toda pregunta frecuente se encuentra a sí misma", () => {
    for (const topic of topics) {
      for (const faq of topic.faqs ?? []) {
        const [match] = matchHelpTopics(faq.q, topics)
        expect(match?.faq?.q, faq.q).toBe(faq.q)
        for (const form of faq.forms ?? []) expect(matchHelpTopics(form, topics)[0]?.faq?.q, form).toBe(faq.q)
      }
    }
  })

  it("nombrar una pantalla como el menú lleva a ella", () => {
    for (const topic of topics) {
      for (const question of [topic.title, `¿Dónde está ${topic.title}?`, `¿Dónde veo ${topic.title}?`, `¿Qué es ${topic.title}?`, `¿Para qué sirve ${topic.title}?`]) {
        expect(first(question), question).toBe(topic.id)
      }
    }
  })

  it("una palabra dentro de otra no cuenta", () => {
    // «ia» en gracias y Francia, «bot» en botón, «pin» en pintar, «tema» en sistema.
    for (const question of ["gracias", "¿Cuál es la capital de Francia?", "¿Para qué sirve este botón?", "¿Puedo pintar el fondo de otro color?", "el sistema está lento"]) {
      expect(all(question), question).toEqual([])
    }
    // «roles» en controles, «áreas» en tareas, «logo» en odontólogo, «log» en logo.
    expect(all("¿Dónde veo los controles del paciente?")).toEqual(["pacientes"])
    expect(all("¿Dónde veo mis tareas?")).toEqual(["tareas"])
    expect(all("¿Cómo cambio el logo?")).toEqual(["organizacion"])
  })

  it("entiende lo que se dice de otra forma", () => {
    expect(first("como paso un turno al jueves")).toBe("agenda")
    expect(first("quiero bloquearlo porque manda publicidad")).toBe("bandeja")
    expect(first("donde mando el link al paciente")).toBe("pacientes")
    expect(first("donde esta el presupueto")).toBe("pacientes")
    expect(first("no le llego la invitacion a la doctora")).toBe("equipo")
  })

  it("responde una sola pantalla", () => {
    expect(all("¿Cómo agendo una cita para un paciente?")).toEqual(["agenda"])
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

interface Asked {
  q: string
  expected: string[]
}
const banks = JSON.parse(readFileSync(new URL("./help-preguntas.json", import.meta.url), "utf8")) as Record<"desarrollo" | "control" | "final" | "ciego", Asked[]>

function measure(bank: readonly Asked[], topics: readonly HelpTopic[]) {
  const out = { bien: 0, mal: 0, noSabe: 0, inventa: 0, aparte: 0 }
  for (const { q, expected } of bank) {
    const got = matchHelpTopics(q, topics).map((match) => match.topic.id)
    if (expected.length === 0) {
      if (got.length === 0) out.aparte += 1
      else out.inventa += 1
    } else if (got.length === 0) out.noSabe += 1
    else if (expected.includes(got[0] ?? "")) out.bien += 1
    else out.mal += 1
  }
  return out
}

/**
 * Lo que la gente pregunta, escrito sin ver la guía. Es la medida de Ariadna:
 * cambiar el buscador o la guía no puede dejarla por debajo de estos pisos, y si
 * mejora, se suben. `desarrollo`, `control` y `final` ya se usaron para ajustar
 * palabras y umbrales; `ciego` no: es el único número honesto, y mirar sus
 * fallos para ajustar lo gasta (hay que escribir otro).
 */
describe("el banco de preguntas", () => {
  it("lo que se usó para ajustar no retrocede", () => {
    expect(measure(banks.desarrollo, HELP_TOPICS)).toMatchObject({ mal: 0, noSabe: 0 })
    expect(measure(banks.control, HELP_TOPICS).bien).toBeGreaterThanOrEqual(130)
    expect(measure(banks.final, HELP_TOPICS).bien).toBeGreaterThanOrEqual(85)
  })

  it.each([
    ["odentIA", HELP_TOPICS],
    ["latidIA", MEDICAL_HELP_TOPICS],
  ] as const)("a ciegas en %s responde bien al menos 7 de cada 10", (_product, topics) => {
    const result = measure(banks.ciego, topics)
    expect(result.bien / (result.bien + result.mal + result.noSabe)).toBeGreaterThanOrEqual(0.7)
    expect(result.mal).toBeLessThanOrEqual(25)
    expect(result.inventa).toBeLessThanOrEqual(4)
  })
})
