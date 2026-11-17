// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SideColumn, SideDockProvider, useDockedColumnHandle, useSideColumnWidth, useStaysBeside } from "./side-dock.js"

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
    onResize.mockClear()
    // Enter es lo mismo con el teclado.
    fireEvent.keyDown(handle, { key: "Enter" })
    expect(onResize).toHaveBeenLastCalledWith(512)
  })

  it("Esc en el borde no se queda en él: sigue hasta quien cierra el panel", () => {
    setViewport(1440)
    const { handle } = column(512)
    handle.focus()
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    handle.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
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

describe("useStaysBeside (regla 5)", () => {
  function Page(props: { open: boolean; fits: boolean; dirty?: boolean; onClose: () => void }) {
    const { beside, confirmDialog } = useStaysBeside({
      open: props.open,
      fits: props.fits,
      dirty: props.dirty ?? false,
      lost: "No se registró el hallazgo de la 36.",
      onClose: props.onClose,
    })
    return (
      <>
        <p>{props.open ? (beside ? "al lado" : "en cajón") : "cerrada"}</p>
        {confirmDialog}
      </>
    )
  }

  it("al lado y sin nada escrito: al perder el ancho se cierra, sin pasar por ventana", () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits onClose={onClose} />)
    expect(screen.getByText("al lado")).toBeTruthy()
    rerender(<Page open fits={false} onClose={onClose} />)
    // Hasta que la página la cierra, sigue al lado: nunca un cuadro como cajón.
    expect(screen.getByText("al lado")).toBeTruthy()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("con algo escrito pregunta antes; «Seguir aquí» la deja al lado aunque no quepa", async () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits dirty onClose={onClose} />)
    rerender(<Page open fits={false} dirty onClose={onClose} />)
    expect(await screen.findByText("No se registró el hallazgo de la 36.")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Seguir aquí" }))
    expect(screen.getByText("al lado")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  // QA del 16 nov, Q13: «Seguir aquí» dejaba abierto lo que le quitó el ancho (Antecedentes) y el
  // arco quedaba en 137 px hasta cerrar algo a mano.
  function Docked(props: { onClose?: () => void; dirty?: boolean }) {
    useDockedColumnHandle(props.onClose, props.dirty ?? false)
    return null
  }

  it("«Seguir aquí» cierra lo que se abrió en la columna y le quitó el ancho", async () => {
    const onClose = vi.fn()
    const closeColumn = vi.fn()
    const page = (fits: boolean, column: boolean) => (
      <SideDockProvider>
        <Page open fits={fits} dirty onClose={onClose} />
        {column ? <Docked onClose={closeColumn} /> : null}
      </SideDockProvider>
    )
    const { rerender } = render(page(true, false))
    // Se abre Antecedentes en la columna: la pieza pierde el ancho y pregunta.
    rerender(page(false, true))
    fireEvent.click(await screen.findByRole("button", { name: "Seguir aquí" }))
    expect(closeColumn).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText("al lado")).toBeTruthy()
  })

  it("lo que tiene algo escrito en la columna no se cierra por «Seguir aquí»", async () => {
    const closeColumn = vi.fn()
    const page = (fits: boolean, column: boolean) => (
      <SideDockProvider>
        <Page open fits={fits} dirty onClose={() => {}} />
        {column ? <Docked onClose={closeColumn} dirty /> : null}
      </SideDockProvider>
    )
    const { rerender } = render(page(true, false))
    rerender(page(false, true))
    fireEvent.click(await screen.findByRole("button", { name: "Seguir aquí" }))
    expect(closeColumn).not.toHaveBeenCalled()
    expect(screen.getByText("al lado")).toBeTruthy()
  })

  it("retenida y sin sitio, al guardarse lo escrito se cierra: no queda aplastada", async () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits dirty onClose={onClose} />)
    rerender(<Page open fits={false} dirty onClose={onClose} />)
    fireEvent.click(await screen.findByRole("button", { name: "Seguir aquí" }))
    expect(onClose).not.toHaveBeenCalled()
    // Registró el hallazgo: ya no hay nada que perder, y sigue sin caber.
    rerender(<Page open fits={false} onClose={onClose} />)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("retenida, cuando vuelve el ancho deja de estarlo: si lo pierde otra vez, vuelve a preguntar", async () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits dirty onClose={onClose} />)
    rerender(<Page open fits={false} dirty onClose={onClose} />)
    fireEvent.click(await screen.findByRole("button", { name: "Seguir aquí" }))
    rerender(<Page open fits dirty onClose={onClose} />)
    expect(screen.queryByRole("button", { name: "Seguir aquí" })).toBeNull()
    rerender(<Page open fits={false} dirty onClose={onClose} />)
    expect(await screen.findByRole("button", { name: "Seguir aquí" })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("con algo escrito, «Descartar y salir» la cierra", async () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits dirty onClose={onClose} />)
    rerender(<Page open fits={false} dirty onClose={onClose} />)
    fireEvent.click(await screen.findByRole("button", { name: "Descartar y salir" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("abierta sin sitio va en cajón, y pasa al lado cuando lo hay", () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page open fits={false} onClose={onClose} />)
    expect(screen.getByText("en cajón")).toBeTruthy()
    rerender(<Page open fits onClose={onClose} />)
    expect(screen.getByText("al lado")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
