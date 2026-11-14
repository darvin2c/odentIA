// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setFormatRegion } from "../locale.js"
import { BirthDateInput, type BirthDateInputProps } from "./birth-date-input.js"

const TODAY = "2026-10-16"

afterEach(() => {
  cleanup()
  setFormatRegion({ locale: "es-PE", timeZone: "America/Lima" })
})

function Harness(props: Partial<BirthDateInputProps> & { initial?: string }) {
  const [value, setValue] = React.useState(props.initial ?? "")
  return (
    <>
      <label htmlFor="nacimiento">Fecha de nacimiento</label>
      <BirthDateInput
        id="nacimiento"
        today={TODAY}
        {...props}
        value={value}
        onChange={(next, reading) => {
          setValue(next)
          props.onChange?.(next, reading)
        }}
      />
    </>
  )
}

function field(): HTMLInputElement {
  return screen.getByLabelText("Fecha de nacimiento") as HTMLInputElement
}

describe("BirthDateInput", () => {
  it("se escribe de corrido en el orden de la clínica, guarda ISO y dice la edad", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), "30071995")
    expect(field().value).toBe("30/07/1995")
    expect(onChange).toHaveBeenLastCalledWith("1995-07-30", expect.objectContaining({ iso: "1995-07-30" }))
    expect(screen.getByText("31 años")).toBeTruthy()
  })

  it("muestra lo guardado en el orden de otro formato regional", () => {
    setFormatRegion({ locale: "en-US", timeZone: "America/New_York" })
    render(<Harness initial="1995-07-30" />)
    expect(field().value).toBe("07/30/1995")
    expect(field().placeholder).toBe("mm/dd/aaaa")
  })

  it("no acepta una fecha futura: lo dice y no la entrega como fecha", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), "17102026")
    expect(screen.getByText("Es una fecha que aún no llega: escribe una que ya pasó")).toBeTruthy()
    expect(field().getAttribute("aria-invalid")).toBe("true")
    // Lo escrito viaja tal cual: el formulario o el servidor lo rechazan, no se guarda vacío.
    expect(onChange).toHaveBeenLastCalledWith("17/10/2026", expect.objectContaining({ iso: null }))
  })

  it("a medias solo avisa al salir del campo", async () => {
    render(<Harness />)
    await userEvent.type(field(), "3007")
    expect(screen.queryByText(/Escribe día, mes y año/)).toBeNull()
    fireEvent.blur(field())
    expect(screen.getByText("Escribe día, mes y año: dd/mm/aaaa")).toBeTruthy()
  })

  it("una fecha ISO pegada pasa al orden de la clínica", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(field())
    await userEvent.paste("1990-04-11")
    expect(field().value).toBe("11/04/1990")
    expect(onChange).toHaveBeenLastCalledWith("1990-04-11", expect.anything())
  })

  // Mesa de formularios del 13 nov (F15): «3/4/1990», como se dice, quedaba «34/19/90».
  it("escrita con barras y sin ceros se entiende: 3/4/1990 es el 3 de abril", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), "3/4/1990")
    expect(field().value).toBe("03/04/1990")
    expect(onChange).toHaveBeenLastCalledWith("1990-04-03", expect.objectContaining({ iso: "1990-04-03" }))
  })

  /** Lo que queda en un campo recién abierto al teclear o pegar eso. */
  async function written(text: string, how: "type" | "paste" = "type"): Promise<string> {
    const { unmount } = render(<Harness />)
    if (how === "type") await userEvent.type(field(), text)
    else {
      await userEvent.click(field())
      await userEvent.paste(text)
    }
    const value = field().value
    unmount()
    return value
  }

  it("con guiones o puntos también, y pegada entera", async () => {
    expect(await written("3-4-1990")).toBe("03/04/1990")
    expect(await written("3.12.1990")).toBe("03/12/1990")
    expect(await written("3/4/1990", "paste")).toBe("03/04/1990")
    expect(await written("3 4 1990", "paste")).toBe("03/04/1990")
  })

  // En el teclado numérico del celular a veces no hay barra, pero sí coma, punto o espacio.
  it("tecleada con comas o con espacios también se entiende", async () => {
    expect(await written("3,4,1990")).toBe("03/04/1990")
    expect(await written("3 4 1990")).toBe("03/04/1990")
    expect(await written("3, 4, 1990")).toBe("03/04/1990")
    expect(await written("3,4,1990", "paste")).toBe("03/04/1990")
    // Y sin ningún separador, los ocho números de siempre.
    expect(await written("03041990")).toBe("03/04/1990")
  })

  it("un separador de más o antes de tiempo no rompe lo escrito", async () => {
    // Con el día ya completo, la barra es la que el campo iba a poner.
    expect(await written("30/07/1995")).toBe("30/07/1995")
    // Sin ningún dígito no hay nada que completar.
    expect(await written("/3/4/1990")).toBe("03/04/1990")
    // Dos barras seguidas: la segunda no inventa una parte.
    expect(await written("3//4/1990")).toBe("03/04/1990")
  })

  it("en el orden de otro país completa igual el mes y el día", async () => {
    setFormatRegion({ locale: "en-US", timeZone: "America/New_York" })
    render(<Harness />)
    await userEvent.type(field(), "4/3/1990")
    expect(field().value).toBe("04/03/1990")
  })

  it("sin la edad sirve para las demás fechas pasadas", async () => {
    render(<Harness showAge={false} />)
    await userEvent.type(field(), "01032020")
    expect(field().value).toBe("01/03/2020")
    expect(screen.queryByText(/años/)).toBeNull()
  })

  // QA de la entrega 3 (14 nov): «1990-04-03» tecleado quedaba «19/90/0403».
  it("tecleada con el año primero, como en ISO, se entiende y pasa al orden de la clínica", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), "1990-04-03")
    expect(field().value).toBe("03/04/1990")
    expect(onChange).toHaveBeenLastCalledWith("1990-04-03", expect.objectContaining({ iso: "1990-04-03" }))
  })

  it("con el año primero y mes o día de un número, también", async () => {
    render(<Harness />)
    await userEvent.type(field(), "1990-4-3")
    fireEvent.blur(field())
    expect(field().value).toBe("03/04/1990")
  })

  it("quien escribe la barra después del mes no empieza por el año", async () => {
    expect(await written("12/10/1990")).toBe("12/10/1990")
    expect(await written("20-01-2005")).toBe("20/01/2005")
  })

  // QA de la entrega 3 (14 nov): «3/4/90» decía «Escribe día, mes y año», y sí los había escrito.
  it("con el año en dos números no lo adivina: pide sus cuatro números, al salir", async () => {
    render(<Harness />)
    await userEvent.type(field(), "3/4/90")
    expect(screen.queryByText(/cuatro números/)).toBeNull()
    fireEvent.blur(field())
    expect(screen.getByText("Escribe el año con sus cuatro números, por ejemplo 1990")).toBeTruthy()
  })

  it("si la pantalla ya dice el problema, el campo no lo repite", async () => {
    render(<Harness problemOutside invalid />)
    await userEvent.type(field(), "31021990")
    expect(screen.queryByText(/Ese mes tiene 28 días/)).toBeNull()
    expect(field().getAttribute("aria-invalid")).toBe("true")
  })
})
