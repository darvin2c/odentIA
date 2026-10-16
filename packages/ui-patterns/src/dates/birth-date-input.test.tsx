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

  it("sin la edad sirve para las demás fechas pasadas", async () => {
    render(<Harness showAge={false} />)
    await userEvent.type(field(), "01032020")
    expect(field().value).toBe("01/03/2020")
    expect(screen.queryByText(/años/)).toBeNull()
  })
})
