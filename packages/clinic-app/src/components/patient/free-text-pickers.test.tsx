// @vitest-environment jsdom

/**
 * Lo escrito que no está en la lista (20 nov): en «Nueva alergia», escribir una sustancia que no
 * está y dar Enter enviaba el formulario con la sustancia vacía y decía «Escribe la sustancia y
 * elígela de la lista». Enter sin nada resaltado deja lo escrito, como salir del campo, y no envía.
 * La medicación habitual tenía lo mismo.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { type AllergenChoice, AllergenPicker } from "./allergen-picker"
import { MedicationPicker } from "./medication-picker"

declareProduct(bareProduct("dental"))

afterEach(cleanup)

function AllergyForm({ onSubmit, allowText = true }: { onSubmit: (value: AllergenChoice | null) => void; allowText?: boolean }) {
  const [value, setValue] = useState<AllergenChoice | null>(null)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      <AllergenPicker id="sustancia" value={value} onChange={setValue} allowText={allowText} />
      <output data-testid="elegida">{value ? (value.kind === "entry" ? `lista:${value.entry.label}` : `texto:${value.text}`) : ""}</output>
    </form>
  )
}

function MedicationForm({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("")
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      <MedicationPicker id="medicamento" value={value} onChange={setValue} />
      <output data-testid="elegido">{value}</output>
    </form>
  )
}

// Como al teclear (`insertText`): así la lista se abre con lo que encontró y nada resaltado.
const type = (input: HTMLElement, text: string) => {
  fireEvent.focus(input)
  fireEvent.input(input, { target: { value: text }, inputType: "insertText" })
}

describe("la sustancia de una alergia que no está en la lista", () => {
  it("con Enter queda como texto y no envía el formulario", () => {
    const submit = vi.fn()
    render(<AllergyForm onSubmit={submit} />)
    const input = screen.getByRole("combobox")
    type(input, "Polen de olivo silvestre")
    expect(input.getAttribute("aria-expanded")).toBe("true")
    // `false`: el Enter no sigue hasta enviar el formulario.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false)
    expect(screen.getByTestId("elegida").textContent).toBe("texto:Polen de olivo silvestre")
    expect(submit).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe("Polen de olivo silvestre")
  })

  it("escrita igual que una de la lista, con Enter queda la de la lista", () => {
    render(<AllergyForm onSubmit={vi.fn()} />)
    const input = screen.getByRole("combobox")
    type(input, "látex")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("elegida").textContent).toMatch(/^lista:/)
  })

  // Que la lista elija la resaltada lo hace el Combobox y en jsdom no se ve: se comprobó en el
  // navegador. Aquí, que Enter con una resaltada no la tapa con lo escrito.
  it("con una de la lista resaltada, Enter no guarda lo escrito", () => {
    render(<AllergyForm onSubmit={vi.fn()} />)
    const input = screen.getByRole("combobox")
    type(input, "penic")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("elegida").textContent).not.toBe("texto:penic")
  })

  it("al salir del campo sin elegir también queda lo escrito", () => {
    render(<AllergyForm onSubmit={vi.fn()} />)
    const input = screen.getByRole("combobox")
    type(input, "Tinte de cabello")
    fireEvent.blur(input)
    expect(screen.getByTestId("elegida").textContent).toBe("texto:Tinte de cabello")
  })

  it("en «Elegir de la lista», lo que no está no se guarda como texto ni envía", () => {
    render(<AllergyForm onSubmit={vi.fn()} allowText={false} />)
    const input = screen.getByRole("combobox")
    type(input, "Polen de olivo silvestre")
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false)
    expect(screen.getByTestId("elegida").textContent).toBe("")
    expect(input.getAttribute("aria-expanded")).toBe("true")
  })

  it("el Enter que confirma un teclado de ideogramas no guarda nada", () => {
    render(<AllergyForm onSubmit={vi.fn()} />)
    const input = screen.getByRole("combobox")
    type(input, "花粉")
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(screen.getByTestId("elegida").textContent).toBe("")
  })
})

describe("la medicación habitual que no está en la lista", () => {
  it("con Enter queda tal cual y no envía el formulario; el siguiente Enter ya envía", () => {
    const submit = vi.fn()
    render(<MedicationForm onSubmit={submit} />)
    const input = screen.getByRole("combobox")
    type(input, "Extracto de uña de gato")
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false)
    expect(screen.getByTestId("elegido").textContent).toBe("Extracto de uña de gato")
    expect(submit).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true)
  })
})
