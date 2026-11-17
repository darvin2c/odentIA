import { describe, expect, it } from "vitest"
import { editorSegments, hasMarks, lengthOf, textProblem, toggleList, wordDiff } from "./reply-text"

const join = (value: string) =>
  editorSegments(value)
    .map((segment) => segment.text)
    .join("")

describe("el editor de respuesta dibuja las marcas sin quitar nada", () => {
  it("*hola* es negrita con sus marcas a la vista, como en WhatsApp", () => {
    expect(editorSegments("Buen día, *doctora*.")).toEqual([
      { text: "Buen día, ", style: "plain" },
      { text: "*", style: "mark" },
      { text: "doctora", style: "bold" },
      { text: "*", style: "mark" },
      { text: ".", style: "plain" },
    ])
  })

  it("cursiva, tachado, **negrita** y enlaces", () => {
    const styles = editorSegments("_a_ ~b~ **c** [web](https://a.pe)").map((s) => s.style)
    expect(styles).toEqual([
      "mark",
      "italic",
      "mark",
      "plain",
      "mark",
      "strike",
      "mark",
      "plain",
      "mark",
      "bold",
      "mark",
      "plain",
      "mark",
      "link",
      "mark",
    ])
  })

  it("los trozos juntos son exactamente el texto, con listas y saltos", () => {
    const text = "- uno *dos*\n\n1. tres_cuatro 2 * 3\n~ suelto"
    expect(join(text)).toBe(text)
    expect(editorSegments("- uno")[0]).toEqual({ text: "- ", style: "list" })
  })

  it("no confunde un asterisco suelto ni un guion bajo dentro de una palabra", () => {
    expect(hasMarks("2 * 3 = 6 y mi_archivo.xlsx")).toBe(false)
    expect(hasMarks("es *importante*")).toBe(true)
  })
})

describe("el largo de cada canal", () => {
  it("cuenta caracteres, o bytes en Instagram", () => {
    expect(lengthOf("hola", { maxChars: 2000, maxBytes: null })).toMatchObject({ used: 4, over: 0 })
    expect(lengthOf("ñandú", { maxChars: null, maxBytes: 1000 })).toMatchObject({
      used: 7,
      unit: "bytes",
    })
    expect(textProblem("x".repeat(2001), { maxChars: 2000, maxBytes: null }, "Messenger")).toBe(
      "Es largo para Messenger: sobran 1 carácter.",
    )
    expect(textProblem("hola", { maxChars: 2000, maxBytes: null }, "Messenger")).toBeNull()
  })
})

describe("la lista con «- »", () => {
  it("la pone en las líneas seleccionadas y la quita si todas la tienen", () => {
    const on = toggleList("uno\ndos\ntres", 0, 7)
    expect(on.value).toBe("- uno\n- dos\ntres")
    expect(toggleList(on.value, 0, on.selectionEnd).value).toBe("uno\ndos\ntres")
  })

  it("en una línea vacía empieza la lista con el cursor listo para escribir", () => {
    const text = "Opciones:\n"
    expect(toggleList(text, text.length, text.length)).toEqual({
      value: "Opciones:\n- ",
      selectionStart: 12,
      selectionEnd: 12,
    })
  })
})

describe("la diferencia que muestra «Mejorar con Kairós»", () => {
  it("marca lo que sale y lo que entra, palabra por palabra", () => {
    expect(wordDiff("lo revisamos el jueves", "Lo revisaremos el jueves.")).toEqual([
      { kind: "del", text: "lo" },
      { kind: "ins", text: "Lo" },
      { kind: "same", text: " " },
      { kind: "del", text: "revisamos" },
      { kind: "ins", text: "revisaremos" },
      { kind: "same", text: " el " },
      { kind: "del", text: "jueves" },
      { kind: "ins", text: "jueves." },
    ])
  })

  it("sin cambios, todo queda igual", () => {
    expect(wordDiff("igual", "igual")).toEqual([{ kind: "same", text: "igual" }])
  })
})
