import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type HelpTopic, matchHelpTopics } from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"

/**
 * Lo que se le exige a la guía de cada producto. Lo corren `help-guide.test.ts`
 * (odentIA) y `medical/help.test.ts` (latidIA): lo común no importa lo médico.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))

/** Lo que la pantalla escribe de verdad, sin la guía, las pruebas ni los comentarios. */
function screensText(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__golden__") continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.(test|stories|spec|gen)\./.test(name) && !/^seed|^help-guide/.test(name) && !/(medical|optical)[\\/]help\.ts$/.test(path)) {
        // Sin comentarios: un botón que se fue no puede seguir valiendo porque alguien lo nombra en uno.
        out.push(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      }
    }
  }
  for (const dir of ["packages/clinic-app/src", "packages/ui-patterns/src", "apps/dental-clinic/src", "apps/medical-clinic/src", "apps/optical-clinic/src", "packages/services/src", "packages/clinical/src", "packages/dental/src", "packages/auth/src", "apps/api/src"]) {
    walk(resolve(ROOT, dir))
  }
  return out.join("\n").normalize("NFC").toLowerCase()
}

/** Se arman con su dato, o son lo que escribe la persona: no están escritos enteros en ninguna parte. */
const COMPOSED = new Set([
  "Las atiende Sofi",
  "Lo que Sofi debe saber",
  "Lo hace Argos",
  "Pregúntale a Argos",
  "Comprobé su identidad: vi su documento",
  "Atender (10:00)",
  "En 6 meses",
  "Enviárselo ahora",
  "Aceptó 2 de 3",
  "sesión 1 de 2",
  "sesión 2 de 2",
  "Necesita consentimiento · Preparar",
  "Debe: 100 · A favor: 100 · Falta pagar: 0",
  "Corona · sesión 1 de 2: mar 10 nov, 9:00 · la sesión 2 se reserva en esa cita",
  "sí, ahí estaré",
  "y en agosto",
  // Su paso y su total salen de lo que dejó escrito en su celular (`draftResumeWords`).
  "Vas en el paso 3 de 6",
])

/** Lo que una guía cita entre comillas y no aparece en ninguna pantalla ni servicio. */
export function missingQuotedNames(topics: readonly HelpTopic[]): string[] {
  const code = screensText()
  const missing = new Set<string>()
  for (const topic of topics) {
    const texts = [topic.purpose, ...(topic.faqs ?? []).flatMap((faq) => [faq.q, faq.a])]
    for (const text of texts) {
      for (const match of text.matchAll(/«([^»]+)»/g)) {
        const quoted = (match[1] ?? "").replace(/[.,…:;?¿!¡]+$/g, "").replace(/^¿/, "").trim()
        if (COMPOSED.has(quoted)) continue
        const wanted = quoted.normalize("NFC").toLowerCase()
        if (!code.includes(wanted) && !code.includes(wanted.replace(/\bsofi\b/g, "${receptionname}"))) missing.add(quoted)
      }
    }
  }
  return [...missing]
}

/**
 * Una pregunta del banco. `expected` es la pantalla, con la que se ajustó el
 * buscador; lo demás es la respuesta, con la que `eval:ayuda` (del agente) mide
 * lo que la persona recibe. Ejemplos escritos por el equipo, nunca mensajes reales.
 */
interface Asked {
  q: string
  expected: string[]
  /** La guía con que se etiquetó la respuesta. */
  producto: "odentia" | "latidia" | "vistia"
  /** Ruta de la pantalla desde donde se preguntó, si se sabe. */
  pantalla?: string
  /** Lo que la responde, mostrado tal cual: preguntas frecuentes (su pregunta exacta) o el párrafo de una pantalla (su id). */
  faqs?: string[]
  temas?: string[]
  /** `ninguna`: la guía no la responde. `datos`: es de las cifras de la clínica (lo responde Argos). */
  es?: "ninguna" | "datos"
  /** La misma pregunta ya está en este banco de ajuste: `eval:ayuda` no la cuenta para confirmar. */
  repite?: "desarrollo" | "control" | "final"
  /** Pide dos cosas a la vez y su respuesta está repartida: `faqs` y `temas` llevan las partes, y ninguna la responde sola. */
  partes?: boolean
  /**
   * Es una pregunta de seguimiento: sola no se entiende («¿y cómo la creo?»). `q` es la pregunta
   * anterior y `donde`, la pantalla de su respuesta, como en el menú. Está etiquetada sabiendo la anterior.
   */
  antes?: { q: string; donde?: string }
}

/**
 * `ronda` son las 14 preguntas de la ronda de QA del 2026-11-04 y, como
 * `ciego`, nadie las usó para ajustar. `cifras` son preguntas sobre las cifras
 * de la clínica y lo que cuenta cada una.
 */
export const helpBanks = JSON.parse(readFileSync(new URL("./help-preguntas.json", import.meta.url), "utf8")) as Record<
  "desarrollo" | "control" | "final" | "ciego" | "ronda" | "cifras",
  Asked[]
>

const PRODUCTS: ReadonlySet<unknown> = new Set(["odentia", "latidia", "vistia"])
/** La etiqueta del banco de cada guía, por el nombre del producto. */
const BANK_LABEL: Readonly<Record<string, Asked["producto"]>> = { odentIA: "odentia", latidIA: "latidia", vistIA: "vistia" }
const NOT_IN_GUIDE: ReadonlySet<unknown> = new Set(["ninguna", "datos"])
const TUNING = ["desarrollo", "control", "final"] as const

/**
 * El piso a ciegas del buscador por palabras, con las preguntas de `ciego` de cada producto
 * (sin las de seguimiento). odentIA: 121 de 155 con pantalla (0,78). latidIA: 22 de 33 (0,67):
 * hasta el 2026-11-10 se medía con las 135 de odentIA (0,72); con las suyas, escritas sin ver
 * la guía, acierta menos, y el piso es ese valor. vistIA no tiene piso todavía (21 de 33).
 */
const BLIND_FLOOR: Readonly<Partial<Record<Asked["producto"], { bien: number; mal: number; inventa: number }>>> = {
  odentia: { bien: 0.7, mal: 25, inventa: 4 },
  latidia: { bien: 0.65, mal: 8, inventa: 4 },
}

/**
 * Lo que el banco da como respuesta de este producto y su guía no tiene, o una
 * pregunta sin una sola etiqueta. Un producto o un `es` que no existen, o un
 * `repite` sin esa pregunta, salen con cualquier producto.
 */
export function helpBankLabelProblems(product: Asked["producto"], topics: readonly HelpTopic[]): string[] {
  const faqs = new Set(topics.flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.q)))
  const ids = new Set(topics.map((topic) => topic.id))
  /** Cómo se llama cada pantalla en el menú: lo que vale en `antes.donde`. */
  const screens = new Set(topics.flatMap((topic) => [topic.title, ...(topic.menuLabel ? [topic.menuLabel] : [])]))
  const asked =(bank: string) => new Set((helpBanks[bank as keyof typeof helpBanks] ?? []).map((item) => normalizeForSearch(item.q)))
  const problems: string[] = []
  for (const [bank, items] of Object.entries(helpBanks)) {
    for (const item of items) {
      if (!PRODUCTS.has(item.producto)) problems.push(`[${bank}] «${item.q}»: el producto «${String(item.producto)}» no existe (odentia, latidia o vistia)`)
      if (item.es !== undefined && !NOT_IN_GUIDE.has(item.es)) problems.push(`[${bank}] «${item.q}»: «es» vale ninguna o datos, no «${String(item.es)}»`)
      if (item.repite !== undefined && (!TUNING.includes(item.repite) || !asked(item.repite).has(normalizeForSearch(item.q)))) {
        problems.push(`[${bank}] «${item.q}»: no está repetida en «${String(item.repite)}»`)
      }
      if (item.producto !== product) continue
      const answers = (item.faqs?.length ?? 0) + (item.temas?.length ?? 0)
      if ((answers > 0) === (item.es !== undefined)) problems.push(`[${bank}] «${item.q}»: lleva una respuesta o «es», solo uno`)
      for (const q of item.faqs ?? []) if (!faqs.has(q)) problems.push(`[${bank}] «${item.q}»: la guía no tiene la pregunta frecuente «${q}»`)
      for (const id of item.temas ?? []) if (!ids.has(id)) problems.push(`[${bank}] «${item.q}»: la guía no tiene la pantalla «${id}»`)
      for (const id of item.expected) if (!ids.has(id)) problems.push(`[${bank}] «${item.q}»: «expected» nombra la pantalla «${id}», que la guía no tiene`)
      if (item.partes !== undefined && (item.partes !== true || answers < 2)) problems.push(`[${bank}] «${item.q}»: «partes» es true y lleva al menos dos respuestas`)
      if (item.antes !== undefined) {
        if (typeof item.antes.q !== "string" || !item.antes.q.trim()) problems.push(`[${bank}] «${item.q}»: «antes» lleva la pregunta anterior`)
        if (item.antes.donde !== undefined && !screens.has(item.antes.donde)) problems.push(`[${bank}] «${item.q}»: «antes.donde» no es una pantalla de la guía («${String(item.antes.donde)}»)`)
        if (item.repite !== undefined) problems.push(`[${bank}] «${item.q}»: una pregunta de seguimiento no «repite» otra`)
      }
    }
    // La misma pregunta dos veces en un banco: solo vale si es de otro producto o sigue a otra pregunta.
    const seen = new Set<string>()
    for (const item of items) {
      if (item.producto !== product) continue
      const key = `${normalizeForSearch(item.q)}|${item.antes ? normalizeForSearch(item.antes.q) : ""}`
      if (seen.has(key)) problems.push(`[${bank}] «${item.q}»: está dos veces en el banco`)
      seen.add(key)
    }
  }
  return problems
}

/**
 * Lo que acierta el buscador por palabras, por pantalla. Con `product`, solo las
 * preguntas etiquetadas con la guía de ese producto. Las de seguimiento (`antes`)
 * no entran: solas no se entienden, y este buscador no recibe la anterior.
 */
export function measureHelpBank(bank: readonly Asked[], topics: readonly HelpTopic[], product?: Asked["producto"]) {
  const out = { bien: 0, mal: 0, noSabe: 0, inventa: 0, aparte: 0 }
  for (const { q, expected, producto, antes } of bank) {
    if (antes || (product && producto !== product)) continue
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

/** Buscar en la guía de un producto: lo que no puede dejar de cumplir. */
export function describeHelpSearch(product: string, topics: readonly HelpTopic[]): void {
  describe(`buscar en la guía de ${product}`, () => {
    const first = (question: string) => matchHelpTopics(question, topics)[0]?.topic.id ?? null
    const all = (question: string) => matchHelpTopics(question, topics).map((match) => match.topic.id)

    it("lo que cita existe en las pantallas", () => {
      expect(missingQuotedNames(topics).join(" | ")).toBe("")
    })

    it("el banco por respuesta nombra lo que la guía tiene", () => {
      // Cambiar una pregunta frecuente o una pantalla cambia su etiqueta en `help-preguntas.json` en el mismo cambio.
      const label = BANK_LABEL[product]
      if (!label) throw new Error(`La guía de ${product} no tiene etiqueta en el banco`)
      expect(helpBankLabelProblems(label, topics).join("\n")).toBe("")
    })

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
        for (const name of [topic.title, ...(topic.menuLabel ? [topic.menuLabel] : [])])
          for (const question of [name, `¿Dónde está ${name}?`, `¿Dónde veo ${name}?`, `¿Qué es ${name}?`, `¿Para qué sirve ${name}?`]) {
            expect(first(question), question).toBe(topic.id)
          }
      }
    })

    it("una palabra dentro de otra no cuenta", () => {
      // «ia» en gracias y Francia, «bot» en botón, «pin» en pintar, «tema» en sistema.
      for (const question of ["gracias", "¿Cuál es la capital de Francia?", "¿Para qué sirve este botón?", "¿Puedo pintar el fondo?", "el sistema está lento"]) {
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

    /**
     * `ciego` se escribió sin ver la guía y no se usó para ajustar nada: es el
     * único número honesto, y mirar sus fallos para ajustar lo gasta (hay que
     * escribir otro). Cambiar el buscador o la guía no puede dejarlo por debajo
     * de estos pisos; si mejora, se suben.
     */
    it("a ciegas responde bien al menos 7 de cada 10", () => {
      const label = BANK_LABEL[product]
      const floor = label ? BLIND_FLOOR[label] : undefined
      if (!label || !floor) throw new Error(`La guía de ${product} no tiene piso a ciegas`)
      const result = measureHelpBank(helpBanks.ciego, topics, label)
      expect(result.bien / (result.bien + result.mal + result.noSabe)).toBeGreaterThanOrEqual(floor.bien)
      expect(result.mal).toBeLessThanOrEqual(floor.mal)
      expect(result.inventa).toBeLessThanOrEqual(floor.inventa)
    })
  })
}
