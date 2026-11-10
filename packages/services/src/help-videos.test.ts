import { describe, expect, it } from "vitest"
import { helpAnswerHash, helpVideoTagList, helpVideoTargets, parseHelpVideoTags } from "./help-videos.js"
import { helpTopicsFor } from "./products.js"

/** Lo de los videos que no necesita base: leer etiquetas, la huella y a qué se pueden unir. */
describe("las etiquetas de un video", () => {
  it("se leen de su descripción, con el segundo donde empieza", () => {
    expect(
      parseHelpVideoTags("Cómo se crea una tarea.\n#ayuda:tareas-crear #ayuda:tareas-asignar@90\n#Ayuda:tema:tareas@1m30s #odontología"),
    ).toEqual([
      { target: "tareas-crear", startSeconds: null },
      { target: "tareas-asignar", startSeconds: 90 },
      { target: "tema:tareas", startSeconds: 90 },
    ])
  })

  it("la primera de cada respuesta manda, y sin etiquetas no hay nada", () => {
    expect(parseHelpVideoTags("#ayuda:tareas-crear@10 y otra vez #ayuda:tareas-crear@99")).toEqual([{ target: "tareas-crear", startSeconds: 10 }])
    expect(parseHelpVideoTags("Un video cualquiera #tareas ayuda:tareas-crear")).toEqual([])
  })
})

describe("la huella de una respuesta", () => {
  it("no cambia por una coma ni por una tilde; sí por lo que dice", () => {
    const text = "En Tareas, «Nueva tarea»: escribe qué hay que hacer."
    expect(helpAnswerHash("en tareas «nueva tarea» escribe que hay que hacer")).toBe(helpAnswerHash(text))
    expect(helpAnswerHash("En Tareas, «Nueva tarea»: escribe qué hay que hacer y a quién le toca.")).not.toBe(helpAnswerHash(text))
  })
})

describe("a qué se puede unir un video", () => {
  it("a cada respuesta y a cada pantalla de la guía de su producto, con una etiqueta que se lee igual", () => {
    for (const product of ["dental", "medical", "optical"] as const) {
      const targets = helpVideoTargets(helpTopicsFor(product))
      const tags = helpVideoTagList(product)
      expect(tags.length).toBe(targets.size)
      for (const { tag } of tags) {
        const [read] = parseHelpVideoTags(tag)
        expect(read && targets.has(read.target), tag).toBe(true)
      }
    }
    expect(helpVideoTargets(helpTopicsFor("optical")).has("tema:pedidos")).toBe(true)
    expect(helpVideoTargets(helpTopicsFor("dental")).has("tema:pedidos")).toBe(false)
  })
})
