// @vitest-environment jsdom

import { Field, FieldError, FieldLabel } from "@odentia/ui"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"
import { common } from "../common.js"
import { PhoneInput, type PhoneInputProps } from "./phone-input.js"
import { phonePlaceholder } from "./phone-mask.js"

// Base UI Select y jsdom necesitan polyfills mínimos
beforeAll(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

/** Último E.164 emitido; `undefined` si nunca se llamó. */
function lastValue(onChange: Mock): string | null | undefined {
  const calls = onChange.mock.calls as Array<[string | null, unknown]>
  return calls.length ? calls[calls.length - 1][0] : undefined
}

/**
 * Envoltura con estado, como la usa una pantalla: el valor que vuelve del
 * formulario entra otra vez por `value`, que es donde el componente sincroniza.
 */
function Harness({
  initialValue = null,
  ...props
}: Partial<PhoneInputProps> & { initialValue?: string | null }) {
  const [value, setValue] = React.useState<string | null>(initialValue)
  return (
    <PhoneInput
      id="telefono"
      {...props}
      value={value}
      onChange={(next, meta) => {
        setValue(next)
        props.onChange?.(next, meta)
      }}
    />
  )
}

function renderField(props: Partial<PhoneInputProps> & { initialValue?: string | null } = {}) {
  const onChange = vi.fn()
  const utils = render(
    <Field>
      <FieldLabel htmlFor="telefono">Teléfono</FieldLabel>
      <Harness {...props} onChange={onChange} />
      <FieldError>Teléfono inválido</FieldError>
    </Field>,
  )
  return { ...utils, input: screen.getByLabelText("Teléfono") as HTMLInputElement, onChange }
}

describe("PhoneInput", () => {
  it("enmascara como nacional y emite E.164", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()

    await user.type(input, "987654321")

    expect(input.value).toBe("987 654 321")
    expect(onChange).toHaveBeenLastCalledWith(
      "+51987654321",
      expect.objectContaining({ country: "PE", digits: "987654321", isValid: true }),
    )
  })

  it("muestra la plantilla de la máscara del país y la cambia con el selector", async () => {
    const user = userEvent.setup()
    const { input } = renderField({ countries: ["PE", "CL"] })

    expect(input.placeholder).toBe(phonePlaceholder("PE"))

    await user.click(screen.getByLabelText(common.phone.country))
    await user.click(await screen.findByRole("option", { name: "Chile (+56)" }))

    expect(input.placeholder).toBe(phonePlaceholder("CL"))
  })

  it("deja el prefijo en el selector, no en el campo", async () => {
    const user = userEvent.setup()
    const { input } = renderField()

    expect(screen.getByLabelText(common.phone.country).textContent).toBe("PE +51")

    await user.type(input, "987654321")
    expect(input.value).toBe("987 654 321")

    // Teclear el prefijo tampoco lo mete en el campo: pertenece al selector.
    await user.type(input, "+51987654")
    expect(input.value).not.toContain("+")
  })

  it("al pegar el prefijo del mismo país lo descarta", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()

    await user.click(input)
    await user.paste("+51 987-654-321")

    expect(input.value).toBe("987 654 321")
    expect(lastValue(onChange)).toBe("+51987654321")
  })

  it("al pegar un número de otro país mueve el selector y deja el número nacional", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()

    await user.click(input)
    await user.paste("+54 9 11 2345 6789")

    expect(screen.getByLabelText(common.phone.country).textContent).toBe("AR +54")
    expect(input.value).toBe("011 15 2345 6789")
    expect(onChange).toHaveBeenLastCalledWith(
      "+5491123456789",
      expect.objectContaining({ country: "AR", isValid: true }),
    )
  })

  it("no emite teléfono mientras el número está incompleto", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()

    await user.type(input, "987")

    expect(input.value).toBe("987")
    expect(onChange).toHaveBeenCalled()
    expect((onChange.mock.calls as Array<[unknown]>).every(([value]) => value === null)).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ isPossible: false, isValid: false }),
    )
  })

  it("no deja teclear dígitos que no caben en el país", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()

    await user.type(input, "9876543210")

    expect(input.value).toBe("987 654 321")
    expect(lastValue(onChange)).toBe("+51987654321")
  })

  it("cambiar de país reescribe el número y emite el E.164 nuevo", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ countries: ["PE", "CL"] })

    await user.type(input, "987654321")
    expect(lastValue(onChange)).toBe("+51987654321")

    await user.click(screen.getByLabelText(common.phone.country))
    await user.click(await screen.findByRole("option", { name: "Chile (+56)" }))

    expect(input.value).toBe("9 8765 4321")
    expect(onChange).toHaveBeenLastCalledWith(
      "+56987654321",
      expect.objectContaining({ country: "CL" }),
    )
  })

  it("refleja el valor guardado y lo limpia cuando el formulario lo borra", () => {
    const onChange = vi.fn()
    const field = (value: string | null) => (
      <Field>
        <FieldLabel htmlFor="telefono">Teléfono</FieldLabel>
        <PhoneInput id="telefono" value={value} onChange={onChange} />
      </Field>
    )
    const { rerender } = render(field("+51987654321"))
    const input = screen.getByLabelText("Teléfono") as HTMLInputElement

    expect(input.value).toBe("987 654 321")

    rerender(field("+51999888777"))
    expect(input.value).toBe("999 888 777")

    rerender(field(null))
    expect(input.value).toBe("")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("arranca en el país del número guardado", () => {
    renderField({ initialValue: "+5491123456789" })

    expect(screen.getByLabelText(common.phone.country).textContent).toBe("AR +54")
  })

  it("sin selector de país pinta el prefijo dentro del campo", async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ showCountrySelect: false })

    expect(screen.queryByLabelText(common.phone.country)).toBeNull()
    expect(screen.getByText("+51")).toBeDefined()

    await user.type(input, "987654321")
    expect(input.value).toBe("987 654 321")
    expect(lastValue(onChange)).toBe("+51987654321")
  })

  it("se marca inválido al salir si el teléfono queda a medias", async () => {
    const user = userEvent.setup()
    const { input } = renderField()

    await user.type(input, "987")
    expect(input.getAttribute("aria-invalid")).toBeNull()

    await user.tab()
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  it("no se marca inválido con un teléfono completo ni con el campo vacío", async () => {
    const user = userEvent.setup()
    const { input } = renderField()

    // Un solo retroceso: jsdom no borra bien un valor con separadores, pero
    // vaciar el campo es lo que aquí importa (el borrado real se probó en el navegador).
    await user.type(input, "9")
    await user.type(input, "{backspace}")
    await user.tab()
    expect(input.value).toBe("")
    expect(input.getAttribute("aria-invalid")).toBeNull()

    await user.type(input, "987654321")
    await user.tab()
    expect(input.getAttribute("aria-invalid")).toBeNull()
  })

  it("expone el estado inválido y toma la forma del campo de teléfono", () => {
    const { input, unmount } = renderField({ invalid: true })

    expect(input.type).toBe("tel")
    expect(input.getAttribute("aria-invalid")).toBe("true")

    unmount()
    expect(renderField().input.getAttribute("aria-invalid")).toBeNull()
  })
})
