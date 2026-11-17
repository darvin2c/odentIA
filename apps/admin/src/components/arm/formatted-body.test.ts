import { describe, expect, it } from "vitest"
import { insertLink, wrapSelection } from "./formatted-body"
import { replyFilesProblem } from "./reply-files"

describe("botones de formato", () => {
  it("negrita envuelve lo seleccionado y, si ya lo estaba, lo quita", () => {
    const on = wrapSelection("hola Rosa", 5, 9, "**")
    expect(on).toEqual({ value: "hola **Rosa**", selectionStart: 7, selectionEnd: 11 })
    expect(wrapSelection(on.value, on.selectionStart, on.selectionEnd, "**").value).toBe(
      "hola Rosa",
    )
  })

  it("sin selección deja las marcas con el cursor en medio", () => {
    expect(wrapSelection("hola ", 5, 5, "*")).toEqual({
      value: "hola **",
      selectionStart: 6,
      selectionEnd: 6,
    })
  })

  it("enlace: con texto deja «https://» seleccionado; con una dirección, la usa", () => {
    const link = insertLink("ver precios", 4, 11)
    expect(link.value).toBe("ver [precios](https://)")
    expect(link.value.slice(link.selectionStart, link.selectionEnd)).toBe("https://")
    expect(insertLink("https://odentia32.com", 0, 21).value).toBe(
      "[https://odentia32.com](https://odentia32.com)",
    )
  })
})

describe("adjuntos de una respuesta", () => {
  it("hasta 5 y 10 MB juntos", () => {
    expect(replyFilesProblem([{ sizeBytes: 9 * 1024 * 1024 }])).toBeNull()
    expect(
      replyFilesProblem([{ sizeBytes: 6 * 1024 * 1024 }, { sizeBytes: 5 * 1024 * 1024 }]),
    ).toMatch(/10 MB/)
    expect(replyFilesProblem(Array.from({ length: 6 }, () => ({ sizeBytes: 1 })))).toMatch(/5/)
  })

  it("los espacios de la selección quedan fuera de las marcas (doble clic en Windows)", () => {
    // «doctora » con su espacio: la negrita queda en «*doctora* gracias», no en «*doctora *gracias».
    const text = "Buen día, doctora gracias"
    const edit = wrapSelection(text, 10, 18, "*")
    expect(edit.value).toBe("Buen día, *doctora* gracias")
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe("doctora")
  })
})
