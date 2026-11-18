// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NoticeStrip, sortNotices, type StripNotice } from "./notice-strip.js"

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty("--notice-strip-h")
})

const vence: StripNotice = {
  id: "cargo:1:alarma",
  tone: "alarma",
  message: "Tu cargo de octubre (USD 32.76) vence pasado mañana, viernes 30 de octubre.",
  short: "Tu cargo vence el vie 30 oct",
  action: { label: "Registrar pago", shortLabel: "Pagar", to: "/settings/plan" },
  onDismiss: () => undefined,
}
const tope: StripNotice = {
  id: "tope:limite:2026-10-01",
  tone: "limite",
  message: "Llegaste a tu tope de gasto: Sofi pasa los casos nuevos a tu equipo.",
  short: "Llegaste a tu tope de gasto",
  action: { label: "Subir tope", onSelect: () => undefined },
}
const soporte: StripNotice = {
  id: "soporte:1",
  tone: "aviso",
  message: "Diste acceso a soporte de odentIA hasta las 15:40. Solo ve la configuración, no pacientes.",
  short: "Soporte tiene acceso hasta las 15:40",
  onDismiss: () => undefined,
}

/** La fila de escritorio de una franja (la del teléfono está oculta por CSS, también en el DOM). */
function desktopRows(): HTMLElement[] {
  return screen.getAllByText((_, element) => element?.getAttribute("data-slot") === "notice-strip-item") as HTMLElement[]
}

describe("NoticeStrip", () => {
  it("ordena del más grave al más leve, conservando el orden dentro del nivel", () => {
    expect(sortNotices([soporte, vence, tope]).map((notice) => notice.id)).toEqual([tope.id, vence.id, soporte.id])
  })

  it("muestra solo el más grave y abre los demás con «y N avisos más»", () => {
    render(<NoticeStrip notices={[soporte, vence, tope]} />)
    expect(desktopRows()).toHaveLength(1)
    expect(desktopRows()[0]?.getAttribute("data-tone")).toBe("limite")
    const more = screen.getAllByRole("button", { name: "y 2 avisos más" })[0]!
    expect(more.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(more)
    expect(desktopRows().map((row) => row.getAttribute("data-tone"))).toEqual(["limite", "alarma", "aviso"])
    expect(screen.getAllByRole("button", { name: "Ver menos" })[0]?.getAttribute("aria-expanded")).toBe("true")
  })

  it("el rojo no se cierra; el resto sí, con su propia X", () => {
    const onDismiss = vi.fn()
    render(<NoticeStrip notices={[{ ...tope, onDismiss }]} />)
    expect(screen.queryByRole("button", { name: "Cerrar aviso" })).toBeNull()
    cleanup()
    render(<NoticeStrip notices={[{ ...vence, onDismiss }]} />)
    fireEvent.click(screen.getAllByRole("button", { name: "Cerrar aviso" })[0]!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("dice el nivel en palabras y ofrece la acción con su nombre", () => {
    const onSelect = vi.fn()
    render(<NoticeStrip notices={[{ ...tope, action: { label: "Subir tope", onSelect } }]} />)
    const row = desktopRows()[0]!
    expect(row.getAttribute("role")).toBe("alert")
    expect(row.textContent).toContain("Límite:")
    fireEvent.click(within(row).getAllByRole("button", { name: /Subir/ })[0]!)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("en el teléfono el texto corto abre el mensaje completo", () => {
    render(<NoticeStrip notices={[vence]} />)
    const short = screen.getByRole("button", { name: /Tu cargo vence el vie 30 oct/ })
    const id = short.getAttribute("aria-controls") ?? ""
    expect(document.getElementById(id)).toBeNull()
    fireEvent.click(short)
    expect(short.getAttribute("aria-expanded")).toBe("true")
    expect(document.getElementById(id)?.textContent).toBe(vence.message)
  })

  it("sin avisos no pinta nada y deja la ventana sin correr", () => {
    const { container } = render(<NoticeStrip notices={[]} />)
    expect(container.firstChild).toBeNull()
    expect(document.documentElement.style.getPropertyValue("--notice-strip-h")).toBe("0px")
  })
})
