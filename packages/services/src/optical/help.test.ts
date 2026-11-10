import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { HELP_TOPICS, type HelpTopic, helpTopicForScreen, matchHelpTopics } from "../help-guide.js"
import { helpBankLabelProblems } from "../help-guide-suite.js"
import { OPTICAL_HELP_TOPICS } from "./help.js"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** Lo que una guía cita entre comillas, como lo lee `missingQuotedNames`. */
function quotedNames(topics: readonly HelpTopic[]): Set<string> {
  const out = new Set<string>()
  for (const topic of topics) {
    for (const text of [topic.purpose, ...(topic.faqs ?? []).flatMap((faq) => [faq.q, faq.a])]) {
      for (const match of text.matchAll(/«([^»]+)»/g)) {
        out.add((match[1] ?? "").replace(/[.,…:;?¿!¡]+$/g, "").replace(/^¿/, "").trim())
      }
    }
  }
  return out
}

/** Lo que escriben las pantallas de vistIA y los servicios, sin las guías, las pruebas ni los comentarios. */
function codeText(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__golden__") continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.(test|stories|spec|gen)\./.test(name) && !/^(help|help-guide.*)\.ts$/.test(name)) {
        out.push(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      }
    }
  }
  for (const dir of ["packages/clinic-app/src", "apps/optical-clinic/src", "packages/clinical/src", "packages/optical/src", "packages/services/src"]) {
    walk(resolve(ROOT, dir))
  }
  return out.join("\n").normalize("NFC").toLowerCase()
}

/**
 * Lo que solo la guía de vistIA cita. Lo demás ya lo cita la de odentIA, que
 * `help-guide.test.ts` compara con las pantallas.
 */
const OWN_QUOTED = [
  "Control anual de la vista",
  "En 1 año",
  "Preparar presupuesto",
  // El examen de la vista y la receta de lentes (entrega 3).
  "Examen de la vista",
  "Receta de lentes",
  "Recetas de lentes",
  "Emitir receta de anteojos",
  "Emitir receta de lentes de contacto",
  "Transcribir receta externa",
  "Sin verificar",
  "La revisé: verificar",
  "Anteriores",
  // El pedido de lentes (entrega 4).
  "Vender lentes",
  "Vender con esta receta",
  "Sin adelanto",
  "Atrasados",
  "Enviado al laboratorio",
  "Llegó del laboratorio",
  "Revisado: está listo",
  "Entregar",
  "Marcar listo",
  "Rehacer",
  "Cambiar rol",
  // «Tus lentes están listos» (entrega 5).
  "Tus lentes ya están listos para recoger",
  "Aviso de que está listo",
  "Enviar el aviso",
  "Enviarlo otra vez",
  "Tus pedidos",
  "Tu cuenta",
  "Emitir otra desde su examen",
]

/** La Ayuda de vistIA: las mismas pantallas, con lo que tiene una óptica. */
describe("la guía de vistIA", () => {
  // El nombre fijo de cada respuesta no lo lee nadie en la app: se hereda igual en todos los productos.
  const text = JSON.stringify(OPTICAL_HELP_TOPICS, (key, value) => (key === "id" ? undefined : value))

  it("no habla de lo que una óptica no tiene", () => {
    for (const word of [
      /odontograma/i,
      /odontólog/i,
      /odontolog/i,
      /odentIA/i,
      /\bpiezas?\b/i,
      /sillón|sillones/i,
      /unidad(es)? dental/i,
      /ortodoncia|endodoncia|periodoncia/i,
      /caries/i,
      /\b(coronas?|resinas?|muelas?|exodoncias?|dientes?)\b/i,
      /radiograf/i,
      /panorámica|cbct|dicom/i,
      /«Dictar»|«Reanudar»/,
      /descanso/i,
      /signos vitales|examen físico/i,
      /\bASA\b|anest/i,
    ]) {
      expect(text).not.toMatch(word)
    }
  })

  it("no inventa botones: lo que cita está en las pantallas", () => {
    const dental = quotedNames(HELP_TOPICS)
    const own = [...quotedNames(OPTICAL_HELP_TOPICS)].filter((name) => !dental.has(name))
    expect(own.sort()).toEqual([...OWN_QUOTED].sort())
    const code = codeText()
    expect(OWN_QUOTED.filter((name) => !code.includes(name.normalize("NFC").toLowerCase()))).toEqual([])
  })

  it("lleva las mismas pantallas y responde lo suyo", () => {
    // Las de siempre, en su orden, y al final las que solo tiene una óptica.
    expect(OPTICAL_HELP_TOPICS.slice(0, HELP_TOPICS.length).map((topic) => [topic.id, topic.path])).toEqual(
      HELP_TOPICS.map((topic) => [topic.id, topic.path]),
    )
    expect(OPTICAL_HELP_TOPICS.slice(HELP_TOPICS.length).map((topic) => [topic.id, topic.path])).toEqual([["pedidos", "/orders"]])
    expect(helpTopicForScreen("/orders", OPTICAL_HELP_TOPICS)?.id).toBe("pedidos")
    expect(helpTopicForScreen("/patients/123", OPTICAL_HELP_TOPICS)?.id).toBe("pacientes")
    const answer = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS)[0]?.faq?.a ?? ""
    expect(answer("¿Quién es Ariadna?")).toContain("guía virtual de vistIA")
    expect(answer("¿Cómo dicto una atención?")).toContain("Clío no dicta")
    expect(answer("¿Cómo enciendo a Clío?")).toContain("Clío no dicta")
    expect(answer("¿Cómo veo una OCT?")).toContain("no un estudio en cortes")
    expect(answer("¿Cómo dejo dicho cuándo vuelve?")).toContain("«En 1 año»")
    expect(answer("¿Cómo se arma y se envía el presupuesto?")).toContain("No hace falta")
    expect(answer("¿Qué son las sesiones habituales de un servicio?")).toContain("terapia visual")
    expect(answer("¿Dónde subo una retinografía o un campo visual?")).toContain("campo visual")
    expect(answer("¿Cómo elijo el diagnóstico de una atención?")).toContain("El ojo se escribe en la nota")
    expect(text).toMatch(/optómetra/)
  })

  it("la de odentIA no cambia", () => {
    expect(JSON.stringify(HELP_TOPICS)).toMatch(/odontograma/)
    expect(helpTopicForScreen("/patients/123")?.id).toBe("pacientes")
  })
})

/**
 * Lo mismo que `describeHelpSearch` le exige a la guía de cada producto, salvo
 * el piso a ciegas (abajo). «Lo que cita existe» va arriba, más estricto: la
 * lectura de pantallas de la suite incluye este archivo y lo daría por bueno.
 */
describe("buscar en la guía de vistIA", () => {
  const first = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS)[0]?.topic.id ?? null
  const all = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS).map((match) => match.topic.id)

  it("el banco por respuesta nombra lo que la guía tiene", () => {
    // Las preguntas de `help-preguntas.json` etiquetadas «vistia» (todavía ninguna).
    expect(helpBankLabelProblems("vistia", OPTICAL_HELP_TOPICS).join("\n")).toBe("")
  })

  it("toda pregunta frecuente se encuentra a sí misma", () => {
    for (const topic of OPTICAL_HELP_TOPICS) {
      for (const faq of topic.faqs ?? []) {
        expect(matchHelpTopics(faq.q, OPTICAL_HELP_TOPICS)[0]?.faq?.q, faq.q).toBe(faq.q)
        for (const form of faq.forms ?? []) expect(matchHelpTopics(form, OPTICAL_HELP_TOPICS)[0]?.faq?.q, form).toBe(faq.q)
      }
    }
  })

  it("nombrar una pantalla como el menú lleva a ella", () => {
    for (const topic of OPTICAL_HELP_TOPICS) {
      for (const name of [topic.title, ...(topic.menuLabel ? [topic.menuLabel] : [])])
        for (const question of [name, `¿Dónde está ${name}?`, `¿Dónde veo ${name}?`, `¿Qué es ${name}?`, `¿Para qué sirve ${name}?`]) {
          expect(first(question), question).toBe(topic.id)
        }
    }
  })

  it("una palabra dentro de otra no cuenta", () => {
    for (const question of ["gracias", "¿Cuál es la capital de Francia?", "¿Para qué sirve este botón?", "¿Puedo pintar el fondo?", "el sistema está lento"]) {
      expect(all(question), question).toEqual([])
    }
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
    expect(first("¿Cómo agrego una sala de examen?")).toBe("disponibilidad")
    expect(first("¿Cómo invito a un optómetra?")).toBe("equipo")
  })

  it("responde una sola pantalla", () => {
    expect(all("¿Cómo agendo una cita para un paciente?")).toEqual(["agenda"])
  })

  /**
   * `ciego` se escribió a ciegas para odentIA: sus preguntas del odontograma, del
   * sillón dental o de la endodoncia no son de una óptica (con ellas vistIA queda
   * en 81 de 120), y ajustar la guía de vistIA contra él lo gastaría. Hace falta
   * otro, escrito sin ver esta guía.
   */
  it.todo("a ciegas responde bien al menos 7 de cada 10, con un banco escrito para vistIA")
})
