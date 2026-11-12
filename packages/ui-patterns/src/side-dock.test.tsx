// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SideColumn, useSideColumnWidth } from "./side-dock.js"

function setViewport(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width })
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const bounds = { initial: 512, min: 416 }

function column(width: number, onResize = vi.fn()) {
  render(
    <SideColumn width={width} onResize={onResize} bounds={bounds} pageMinWidth={512} resizeLabel="Redimensionar panel">
      <div>formulario</div>
    </SideColumn>,
  )
  return { onResize, handle: screen.getByRole("separator", { name: "Redimensionar panel" }) }
}

describe("SideColumn", () => {
  it("se ensancha hasta donde la página conserva su mínimo, sin otro tope", () => {
    setViewport(1920)
    const { onResize, handle } = column(512)
    // 1920 de ventana − 512 que se quedan para la página (sin menú lateral).
    expect(handle.getAttribute("aria-valuemax")).toBe("1408")
    fireEvent.keyDown(handle, { key: "End" })
    expect(onResize).toHaveBeenLastCalledWith(1408)
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(onResize).toHaveBeenLastCalledWith(528)
  })

  it("al achicar la ventana, el tope y el ancho que se anuncia son los que caben", () => {
    setViewport(1920)
    const { onResize, handle } = column(1100)
    expect(handle.getAttribute("aria-valuenow")).toBe("1100")
    setViewport(1200)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(handle.getAttribute("aria-valuemax")).toBe("688")
    expect(handle.getAttribute("aria-valuenow")).toBe("688")
    expect(handle.getAttribute("aria-valuetext")).toBe("688 píxeles de ancho")
    // Se pinta con la misma medida que se anuncia y que usan las flechas.
    expect(screen.getByRole("complementary").style.width).toBe("688px")
    // La flecha parte del ancho que se ve, no del guardado que ya no cabe.
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(onResize).toHaveBeenLastCalledWith(672)
  })

  it("el doble clic guarda el ancho de siempre aunque hoy no quepa entero", () => {
    setViewport(800)
    const { onResize, handle } = column(700)
    fireEvent.doubleClick(handle)
    expect(onResize).toHaveBeenLastCalledWith(512)
  })

  it("el borde lleva un asa a la vista", () => {
    setViewport(1440)
    const { handle } = column(512)
    expect(handle.querySelector("span[aria-hidden]")).not.toBeNull()
  })
})

describe("useSideColumnWidth", () => {
  it("recuerda un ancho grande elegido otro día, solo con el mínimo como límite", () => {
    window.localStorage.setItem("odentia.side-panel.prueba", "1100")
    const { result } = renderHook(() => useSideColumnWidth("odentia.side-panel.prueba", bounds))
    expect(result.current[0]).toBe(1100)
    act(() => result.current[1](200))
    expect(result.current[0]).toBe(416)
    expect(window.localStorage.getItem("odentia.side-panel.prueba")).toBe("416")
  })
})
