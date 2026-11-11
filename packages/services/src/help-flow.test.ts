import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import type { AdminAnswer } from "./admin-request.js"
import {
  HELP_AREA_QUESTION,
  HELP_GENERAL_AREA,
  HELP_JOIN_QUESTION,
  HELP_SELECT_MAX_OPTIONS,
  HELP_SELECT_QUESTION,
  helpAreaOf,
  helpAreaQuestion,
  helpAreas,
  helpOptionBatches,
  helpOptions,
  helpOptionsIn,
  helpParts,
  helpPartsState,
  helpQuestion,
  helpState,
  helpWrittenProblem,
  readHelpAreas,
  readHelpJoin,
} from "./help-decision.js"
import type { HelpTopic } from "./help-guide.js"
import { agentTextsFor, helpTopicsFor } from "./products.js"

/**
 * `help.v2` (ADR 0178) sin proveedor: las probabilidades las escribe la prueba.
 * Con una guía de muestra, para que completar la guía de verdad no la mueva; lo
 * que la guía de cada producto tiene que cumplir para caber, al final.
 */
const GUIDE: HelpTopic[] = [
  {
    id: "tareas",
    path: "/tasks",
    title: "Tareas",
    parent: null,
    purpose: "Los pendientes del equipo.",
    terms: [],
    faqs: [
      { id: "tareas-crear", q: "¿Cómo creo una tarea?", a: "En Tareas, «Nueva tarea»: escribe qué hay que hacer y pulsa «Guardar»." },
      { id: "tareas-asignar", q: "¿Cómo le paso una tarea a otra persona?", a: "Abre la tarea y elige a quién en «Responsable». Solo dentro de tu área." },
      { id: "manual", q: "¿Hay un manual?", a: "El manual soy yo.", general: true },
    ],
  },
  {
    id: "pacientes",
    path: "/people",
    title: "Pacientes",
    parent: "Personas",
    purpose: "La lista de personas y la página de cada una.",
    terms: [],
    areas: [
      { id: "ficha", label: "sus datos", about: "Los datos de la persona, sus citas y sus cobros." },
      { id: "plan", label: "plan y presupuesto", about: "Lo que se le va a hacer y lo que cuesta." },
    ],
    faqs: [
      { id: "pacientes-tareas", q: "¿Una persona tiene sus propias tareas?", a: "Sí: en su Resumen, «Pendientes» las lista y «Nueva tarea» crea una." },
      { id: "pacientes-presupuesto", q: "¿Cómo envío un presupuesto?", a: "En su Plan, «Revisar y enviar».", area: "plan" },
    ],
  },
]
const TEXTS = agentTextsFor("dental")
const OPTIONS = helpOptions(GUIDE)
const AREAS = helpAreas(GUIDE)
const option = (id: string) => OPTIONS.find((item) => item.kind === "faq" && item.faq.id === id)!

const areaValues = (() => {
  const question = helpAreaQuestion(AREAS, TEXTS)
  return question.kind === "choice" ? question.options.map((item) => item.value) : []
})()
const areaResult = (probabilities: Record<string, number>): { answers: AdminAnswer[] } => ({
  answers: [
    {
      id: HELP_AREA_QUESTION,
      kind: "choice",
      choice: "x",
      confidence: null,
      probabilities: Object.fromEntries(
        Object.entries(probabilities).map(([key, p]) => [key === "none" || key === "data" ? key : areaValues[AREAS.findIndex((area) => area.id === key)]!, p]),
      ),
    },
  ],
})

describe("las categorías de la guía", () => {
  it("son los temas, las partes de un tema grande y lo general", () => {
    expect(AREAS.map((area) => area.id)).toEqual(["tareas", "ficha", "plan", HELP_GENERAL_AREA])
    expect(AREAS.find((area) => area.id === "plan")?.label).toBe("Personas › Pacientes · plan y presupuesto")
    expect(areaValues).toEqual(["c1", "c2", "c3", "c4", "data", "none"])
  })

  it("cada respuesta está en una sola: la suya, la primera de su tema o lo general", () => {
    expect(helpAreaOf(option("tareas-crear"))).toBe("tareas")
    expect(helpAreaOf(option("manual"))).toBe(HELP_GENERAL_AREA)
    expect(helpAreaOf(option("pacientes-tareas"))).toBe("ficha")
    expect(helpAreaOf(option("pacientes-presupuesto"))).toBe("plan")
    // El párrafo de la pantalla va con la primera parte de su tema.
    expect(helpAreaOf(OPTIONS.find((item) => item.kind === "tema" && item.topic.id === "pacientes")!)).toBe("ficha")
  })

  it("Jev lee de cada una su párrafo y lo que se pregunta en ella", () => {
    expect(AREAS.find((area) => area.id === "tareas")?.about).toContain("¿Cómo creo una tarea?")
    expect(AREAS.find((area) => area.id === "tareas")?.about).not.toContain("manual")
    expect(AREAS.find((area) => area.id === HELP_GENERAL_AREA)?.about).toContain("¿Hay un manual?")
  })
})

describe("el primer paso", () => {
  it("una categoría segura se busca sola", () => {
    const read = readHelpAreas(areaResult({ tareas: 0.95, ficha: 0.03, none: 0.02 }), AREAS)
    expect(read).toMatchObject({ verdict: "areas", sure: true })
    expect(read.areas.map((area) => area.id)).toEqual(["tareas"])
  })

  it("una pregunta de dos partes de la app toma las dos", () => {
    const read = readHelpAreas(areaResult({ tareas: 0.5, ficha: 0.42, plan: 0.05, none: 0.03 }), AREAS)
    expect(read.sure).toBe(true)
    expect(read.areas.map((area) => area.id)).toEqual(["tareas", "ficha"])
  })

  it("si las más probables no suman la certeza, no es segura: se busca en toda la guía", () => {
    const read = readHelpAreas(areaResult({ tareas: 0.3, ficha: 0.2, plan: 0.1, general: 0.1, none: 0.3 }), AREAS)
    expect(read).toMatchObject({ verdict: "areas", sure: false })
  })

  it("«ninguna» y «datos» piden su certeza, solas o sumadas", () => {
    expect(readHelpAreas(areaResult({ none: 0.95, tareas: 0.05 }), AREAS).verdict).toBe("ninguna")
    expect(readHelpAreas(areaResult({ data: 0.93, tareas: 0.07 }), AREAS).verdict).toBe("datos")
    expect(readHelpAreas(areaResult({ none: 0.5, data: 0.45, tareas: 0.05 }), AREAS).verdict).toBe("ninguna")
    expect(readHelpAreas(areaResult({ none: 0.6, tareas: 0.4 }), AREAS)).toMatchObject({ verdict: "areas", sure: false })
  })

  it("sin probabilidades no hay categoría segura", () => {
    expect(readHelpAreas({ answers: [{ id: HELP_AREA_QUESTION, kind: "choice", choice: "c1", confidence: null }] }, AREAS)).toMatchObject({
      verdict: "areas",
      areas: [],
      sure: false,
      top: null,
    })
  })
})

describe("el segundo paso", () => {
  it("busca solo en las categorías elegidas, o en toda la guía por tandas", () => {
    expect(helpOptionsIn(OPTIONS, new Set(["plan"])).map((item) => (item.kind === "faq" ? item.faq.id : item.topic.id))).toEqual(["pacientes-presupuesto"])
    expect(helpOptionBatches(OPTIONS)).toHaveLength(1)
    expect(helpOptionBatches(OPTIONS)[0]).toHaveLength(OPTIONS.length)
    // Lo que ya se buscó no se vuelve a preguntar.
    const rest = helpOptionBatches(OPTIONS, new Set(["tareas", "ficha"])).flat()
    expect(rest.map((item) => helpAreaOf(item)).sort()).toEqual([HELP_GENERAL_AREA, "plan"])
  })

  it("una guía que no cabe en una pregunta se reparte sin partir una categoría", () => {
    const big: HelpTopic[] = ["a", "b", "c"].map((id) => ({
      id,
      path: `/${id}`,
      title: id,
      parent: null,
      purpose: id,
      terms: [],
      faqs: Array.from({ length: 150 }, (_, index) => ({ id: `${id}-${index}`, q: `${id} ${index}`, a: "x" })),
    }))
    const batches = helpOptionBatches(helpOptions(big))
    expect(batches.map((batch) => batch.length)).toEqual([151, 151, 151])
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(HELP_SELECT_MAX_OPTIONS)
      expect(new Set(batch.map(helpAreaOf)).size).toBe(1)
    }
  })

  const values = (() => {
    const question = helpQuestion(OPTIONS, TEXTS)
    return question.kind === "choice" ? question.options.map((item) => item.value) : []
  })()
  const pick = (probabilities: Record<string, number>): { answers: AdminAnswer[] } => ({
    answers: [
      {
        id: HELP_SELECT_QUESTION,
        kind: "choice",
        choice: "x",
        confidence: null,
        probabilities: Object.fromEntries(
          Object.entries(probabilities).map(([key, p]) => [key === "none" ? key : values[OPTIONS.indexOf(option(key))]!, p]),
        ),
      },
    ],
  })

  it("hay partes para redactar cuando dos o tres respuestas suman la certeza", () => {
    expect(helpParts(pick({ "tareas-crear": 0.55, "tareas-asignar": 0.38, none: 0.07 }), OPTIONS).map((item) => (item.kind === "faq" ? item.faq.id : ""))).toEqual([
      "tareas-crear",
      "tareas-asignar",
    ])
  })

  it("si lo que falta está en «ninguna», no hay partes: eso es no saber", () => {
    expect(helpParts(pick({ "tareas-crear": 0.4, "tareas-asignar": 0.2, none: 0.4 }), OPTIONS)).toEqual([])
    // Una sola respuesta probable no es una respuesta repartida.
    expect(helpParts(pick({ "tareas-crear": 0.8, "tareas-asignar": 0.1, none: 0.1 }), OPTIONS)).toEqual([])
  })

  it("el sí o no de si las partes se completan se lee como probabilidad", () => {
    expect(readHelpJoin({ answers: [{ id: HELP_JOIN_QUESTION, kind: "yesno", probability: 0.86 }] })).toBe(0.86)
    expect(readHelpJoin({ answers: [] })).toBe(0)
  })
})

describe("lo redactado", () => {
  const parts = [option("tareas-crear"), option("tareas-asignar")]

  it("a quien redacta le llegan la pregunta y los textos, nada más", () => {
    const state = helpPartsState("¿cómo creo una tarea y se la paso a Ana?", parts)
    expect(state).toContain("Pregunta: ¿cómo creo una tarea y se la paso a Ana?")
    expect(state).toContain("Texto 1 (Tareas) · ¿Cómo creo una tarea?")
    expect(state).toContain("«Nueva tarea»")
  })

  it("se muestra si solo dice lo que dicen sus textos", () => {
    expect(helpWrittenProblem("En Tareas pulsa «Nueva tarea» y «Guardar»; después ábrela y elige a quién en «Responsable».", parts)).toBeNull()
  })

  it("no se muestra si nombra un botón que no está, trae una cifra nueva, no cita nada, tiene formato o se rinde", () => {
    expect(helpWrittenProblem("Pulsa «Crear tarea» y «Guardar».", parts)).toBe("nombre")
    expect(helpWrittenProblem("Pulsa «Nueva tarea»; tienes 24 horas para asignarla.", parts)).toBe("cifra")
    expect(helpWrittenProblem("Crea la tarea y pásasela a quien quieras.", parts)).toBe("sin_nombres")
    expect(helpWrittenProblem("- Pulsa «Nueva tarea»\n- Pulsa «Guardar»", parts)).toBe("formato")
    expect(helpWrittenProblem("**Pulsa** «Nueva tarea».", parts)).toBe("formato")
    expect(helpWrittenProblem("NO_SE", parts)).toBe("no_sabe")
    expect(helpWrittenProblem("", parts)).toBe("no_sabe")
    expect(helpWrittenProblem(`Pulsa «Nueva tarea». ${"Y sigue. ".repeat(120)}`, parts)).toBe("largo")
  })
})

describe("la pregunta de seguimiento", () => {
  it("viaja con la anterior y la pantalla de su respuesta", () => {
    expect(helpState("¿y cómo la creo?", "Inicio", { question: "¿hay tareas por paciente?", where: "Tareas" })).toBe(
      "Antes preguntó: ¿hay tareas por paciente? (se le respondió sobre Tareas)\nPantalla: Inicio\nPregunta: ¿y cómo la creo?",
    )
    expect(helpState("¿Cómo agendo?", null)).toBe("Pregunta: ¿Cómo agendo?")
  })
})

describe.each(CLINICAL_PRODUCTS)("la guía de %s cabe en los dos pasos", (product) => {
  const topics = helpTopicsFor(product)
  const options = helpOptions(topics)

  it("las categorías caben en una pregunta, con «datos» y «ninguna»", () => {
    expect(helpAreas(topics).length).toBeLessThanOrEqual(HELP_SELECT_MAX_OPTIONS)
  })

  it("ninguna categoría pasa del tope: Jev la ve entera", () => {
    const sizes = new Map<string, number>()
    for (const item of options) sizes.set(helpAreaOf(item), (sizes.get(helpAreaOf(item)) ?? 0) + 1)
    expect([...sizes].filter(([, size]) => size > HELP_SELECT_MAX_OPTIONS)).toEqual([])
  })

  it("la categoría de cada respuesta es una de las de su tema", () => {
    const stray = topics.flatMap((topic) =>
      (topic.faqs ?? []).filter((faq) => faq.area && !(topic.areas ?? []).some((area) => area.id === faq.area)).map((faq) => `${topic.id}: ${faq.id} → ${faq.area}`),
    )
    expect(stray).toEqual([])
    // Las categorías de un tema no repiten el nombre de otro tema ni «general».
    const ids = helpAreas(topics).map((area) => area.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })
})
