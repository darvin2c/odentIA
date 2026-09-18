// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { common } from "../common.js"
import { TimeZoneSelect, type TimeZoneSelectProps } from "./index.js"

// Base UI Combobox y jsdom necesitan polyfills mínimos
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

/** Enero de 2026: desfases estables (sin horario de verano a mitad de temporada). */
const REFERENCE = new Date("2026-01-15T12:00:00Z")

function Harness({
  initialValue = null,
  ...props
}: Partial<TimeZoneSelectProps> & { initialValue?: string | null }) {
  const [value, setValue] = React.useState<string | null>(initialValue)
  return (
    <TimeZoneSelect
      referenceDate={REFERENCE}
      {...props}
      value={value}
      onChange={(next, meta) => {
        setValue(next)
        props.onChange?.(next, meta)
      }}
    />
  )
}

function renderSelect(props: Partial<TimeZoneSelectProps> & { initialValue?: string | null } = {}) {
  const onChange = vi.fn()
  const utils = render(<Harness {...props} onChange={onChange} />)
  return {
    ...utils,
    input: screen.getByLabelText(common.timeZone.label) as HTMLInputElement,
    onChange,
  }
}

function optionNames(): string[] {
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "")
}

describe("TimeZoneSelect", () => {
  it("muestra la zona guardada con su desfase", () => {
    const { input, onChange } = renderSelect({ initialValue: "America/Lima" })

    expect(input.value).toBe("Lima (GMT-5)")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("canoniza un alias guardado en lugar de esconderlo", () => {
    const { input } = renderSelect({ initialValue: "US/Pacific" })

    expect(input.value).toBe("Los Angeles (GMT-8)")
  })

  it("deja el campo vacío si el valor guardado no es una zona", () => {
    const { input } = renderSelect({ initialValue: "Lima" })

    expect(input.value).toBe("")
  })

  it("busca por ciudad", { timeout: 20_000 }, async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.click(input)
    expect(optionNames().length).toBeGreaterThan(100)

    await user.type(input, "bogota")
    expect(optionNames().join(" ")).toContain("Bogota")
  })

  it("busca por identificador", { timeout: 20_000 }, async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.type(input, "asia/tokyo")
    expect(optionNames().join(" ")).toContain("Asia/Tokyo")
  })

  it("busca por desfase", { timeout: 20_000 }, async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.type(input, "gmt+5:45")
    expect(optionNames().join(" ")).toContain("GMT+5:45")
  })

  it("monta solo las coincidencias", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.type(input, "lima")

    expect(optionNames().length).toBeLessThan(10)
  })

  it("al elegir emite el identificador IANA y su lectura", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input, onChange } = renderSelect()

    await user.type(input, "bogota")
    await user.click(screen.getByRole("option", { name: /Bogota/ }))

    expect(onChange).toHaveBeenLastCalledWith("America/Bogota", {
      timeZone: "America/Bogota",
      city: "Bogota",
      region: "America",
      offsetMinutes: -300,
      offsetLabel: "GMT-5",
      localTime: "07:00",
    })
    expect(input.value).toBe("Bogota (GMT-5)")
  })

  it("al buscar sobre una zona ya elegida, el tecleo reemplaza la etiqueta", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input, onChange } = renderSelect({ initialValue: "America/Lima" })

    await user.click(input)
    expect(input.value).toBe("")

    await user.type(input, "bogota")
    await user.click(screen.getByRole("option", { name: /Bogota/ }))

    expect(input.value).toBe("Bogota (GMT-5)")
    expect(onChange).toHaveBeenLastCalledWith(
      "America/Bogota",
      expect.objectContaining({ city: "Bogota" }),
    )
  })

  it("vuelve a mostrar la etiqueta al salir sin elegir nada", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input, onChange } = renderSelect({ initialValue: "America/Lima" })

    await user.click(input)
    await user.type(input, "bogota")
    await user.tab()

    expect(input.value).toBe("Lima (GMT-5)")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("se puede elegir con el teclado", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input, onChange } = renderSelect()

    await user.type(input, "tokyo")
    await user.keyboard("{ArrowDown}{Enter}")

    expect(onChange).toHaveBeenLastCalledWith(
      "Asia/Tokyo",
      expect.objectContaining({ offsetLabel: "GMT+9" }),
    )
  })

  it("encabeza la lista con las zonas sugeridas", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect({ suggested: ["America/Lima", "America/Bogota"] })

    await user.click(input)

    const names = optionNames()
    expect(names[0]).toContain("Lima")
    expect(names[1]).toContain("Bogota")
  })

  it("no repite en la lista una zona sugerida", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect({ suggested: ["America/Lima"] })

    await user.click(input)

    expect(optionNames().filter((name) => name.includes("America/Lima")).length).toBe(1)
  })

  it("avisa cuando no hay coincidencias", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.type(input, "zzzz")

    expect(screen.getByText(common.timeZone.empty)).toBeDefined()
    expect(optionNames()).toHaveLength(0)
  })

  it("marca el error y respeta el campo deshabilitado", () => {
    const { input, unmount } = renderSelect({ invalid: true, disabled: true })

    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(input.disabled).toBe(true)

    unmount()
    expect(renderSelect().input.getAttribute("aria-invalid")).toBeNull()
  })

  it("la lista abre con el campo", async () => {
    const user = userEvent.setup({ delay: 15 })
    const { input } = renderSelect()

    await user.click(input)

    expect(within(document.body).queryAllByRole("option").length).toBeGreaterThan(0)
  })
})
