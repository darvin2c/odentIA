import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type HelpTopic, matchHelpTopics } from "./help-guide.js"

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
      else if (/\.tsx?$/.test(name) && !/\.(test|stories|spec|gen)\./.test(name) && !/^seed|^help-guide/.test(name) && !/medical[\\/]help\.ts$/.test(path)) {
        // Sin comentarios: un botón que se fue no puede seguir valiendo porque alguien lo nombra en uno.
        out.push(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      }
    }
  }
  for (const dir of ["packages/clinic-app/src", "packages/ui-patterns/src", "apps/dental-clinic/src", "apps/medical-clinic/src", "packages/services/src", "packages/clinical/src", "packages/dental/src", "packages/auth/src", "apps/api/src"]) {
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
  "Enviárselo ahora",
  "Aceptó 2 de 3",
  "Necesita consentimiento · Preparar",
  "Debe: 100 · A favor: 100 · Saldo: 0",
  "sí, ahí estaré",
  "y en agosto",
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

interface Asked {
  q: string
  expected: string[]
}

export const helpBanks = JSON.parse(readFileSync(new URL("./help-preguntas.json", import.meta.url), "utf8")) as Record<"desarrollo" | "control" | "final" | "ciego", Asked[]>

export function measureHelpBank(bank: readonly Asked[], topics: readonly HelpTopic[]) {
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

/** Buscar en la guía de un producto: lo que no puede dejar de cumplir. */
export function describeHelpSearch(product: string, topics: readonly HelpTopic[]): void {
  describe(`buscar en la guía de ${product}`, () => {
    const first = (question: string) => matchHelpTopics(question, topics)[0]?.topic.id ?? null
    const all = (question: string) => matchHelpTopics(question, topics).map((match) => match.topic.id)

    it("lo que cita existe en las pantallas", () => {
      expect(missingQuotedNames(topics).join(" | ")).toBe("")
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

    /**
     * `ciego` se escribió sin ver la guía y no se usó para ajustar nada: es el
     * único número honesto, y mirar sus fallos para ajustar lo gasta (hay que
     * escribir otro). Cambiar el buscador o la guía no puede dejarlo por debajo
     * de estos pisos; si mejora, se suben.
     */
    it("a ciegas responde bien al menos 7 de cada 10", () => {
      const result = measureHelpBank(helpBanks.ciego, topics)
      expect(result.bien / (result.bien + result.mal + result.noSabe)).toBeGreaterThanOrEqual(0.7)
      expect(result.mal).toBeLessThanOrEqual(25)
      expect(result.inventa).toBeLessThanOrEqual(4)
    })
  })
}
