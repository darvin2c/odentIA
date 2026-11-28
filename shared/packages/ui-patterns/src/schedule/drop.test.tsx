// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TaskCard } from "../task-card.js"
import { ScheduleDayStrip } from "./day-strip.js"
import {
  type ScheduleDropTarget,
  ScheduleDropProvider,
  ScheduleStepArrow,
  useScheduleDraggable,
  useScheduleDropTarget,
} from "./drop.js"
import { setupScheduleDom } from "./test-utils.js"

setupScheduleDom()

const THURSDAY = "2026-11-26"
const FRIDAY = "2026-11-27"
const SATURDAY = "2026-11-28"

/** jsdom no hace layout: sin esto ningún destino «se ve» y el teclado no tendría adónde ir. */
const originalRects = Element.prototype.getClientRects
const originalFromPoint = document.elementFromPoint
beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
})
afterEach(() => {
  Element.prototype.getClientRects = originalRects
  document.elementFromPoint = originalFromPoint
  vi.useRealTimers()
})

/** Lo que hay bajo el dedo: el navegador lo mide; aquí se dice. */
function pointAt(element: Element | null) {
  document.elementFromPoint = (() => element) as typeof document.elementFromPoint
}

function Card({ onOpen }: { onOpen: () => void }) {
  const drag = useScheduleDraggable({
    id: "0164",
    title: "Carla Mendoza",
    from: { date: THURSDAY, slot: "tarde" },
    ghost: () => <span>Carla · Por salir</span>,
  })
  return (
    <TaskCard
      {...drag}
      title="Carla Mendoza"
      reference="0164"
      task="Empácalo y dáselo a Jhon."
      actionLabel="Empacar"
      onOpen={onOpen}
    />
  )
}

function Slot({ target, label }: { target: ScheduleDropTarget; label: string }) {
  const drop = useScheduleDropTarget(target)
  return (
    <div {...drop.props} data-testid={label} data-over={drop.over ? "si" : "no"}>
      {label}
    </div>
  )
}

function Screen({ onDrop, onOpen = () => {}, onStep = () => {} }: { onDrop: (id: string, t: ScheduleDropTarget) => void; onOpen?: () => void; onStep?: () => void }) {
  return (
    <ScheduleDropProvider
      onDrop={onDrop}
      describe={(t) => [t.date, t.slot].filter(Boolean).join(", ")}
      hint="Suéltala en un día, una franja o un repartidor."
    >
      <ScheduleStepArrow direction={1} label="Semana siguiente" onStep={onStep} />
      <ScheduleDayStrip dates={[THURSDAY, FRIDAY, SATURDAY]} value={THURSDAY} onChange={() => {}} loadDisplay="count" />
      <Slot target={{ date: THURSDAY, slot: "tarde" }} label="Jueves, tarde" />
      <Slot target={{ date: THURSDAY, slot: "manana" }} label="Jueves, mañana" />
      <ul>
        <Card onOpen={onOpen} />
      </ul>
    </ScheduleDropProvider>
  )
}

const card = () => screen.getByRole("listitem")
const day = (name: RegExp) => screen.getByRole("button", { name })

/** Con el mouse: apretar, mover más de 4 px (levanta) y seguir moviendo sobre el destino. */
function mouseDragTo(element: Element | null) {
  fireEvent.pointerDown(screen.getByText("Carla Mendoza"), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 300 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 300 })
  pointAt(element)
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 320 })
}

describe("mantener y arrastrar a un destino", () => {
  it("con el mouse, soltar sobre otro día avisa el destino y no mueve nada por su cuenta", () => {
    const onDrop = vi.fn()
    const onOpen = vi.fn()
    render(<Screen onDrop={onDrop} onOpen={onOpen} />)
    mouseDragTo(day(/27 de noviembre/))
    expect(card().getAttribute("data-dragging")).toBe("true")
    expect(day(/27 de noviembre/).getAttribute("data-drop-over")).toBe("true")
    // Lo que sigue al puntero es la versión corta de la tarjeta.
    expect(document.querySelector("[data-drop-ghost]")?.textContent).toBe("Carla · Por salir")
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).toHaveBeenCalledWith("0164", { date: FRIDAY })
    expect(card().getAttribute("data-dragging")).toBeNull()
    // El clic con que termina el gesto no abre la tarjeta.
    fireEvent.click(screen.getByRole("button", { name: /^Abrir:/ }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("soltar donde ya estaba, o en lo que no dice otra cosa, no avisa nada", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    mouseDragTo(screen.getByTestId("Jueves, tarde"))
    fireEvent.pointerUp(window, { pointerId: 1 })
    mouseDragTo(day(/26 de noviembre/))
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toBe("No se movió nada.")
  })

  it("salir de los destinos antes de soltar no deja el último elegido", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    mouseDragTo(day(/27 de noviembre/))
    pointAt(document.body)
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 90, clientY: 500 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("otra franja del mismo día sí es otro destino", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    mouseDragTo(screen.getByTestId("Jueves, mañana"))
    expect(screen.getByTestId("Jueves, mañana").dataset.over).toBe("si")
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).toHaveBeenCalledWith("0164", { date: THURSDAY, slot: "manana" })
  })

  it("con el dedo hay que mantener: antes se achica un punto, a los 400 ms se levanta", () => {
    vi.useFakeTimers()
    render(<Screen onDrop={() => {}} />)
    fireEvent.pointerDown(screen.getByText("Carla Mendoza"), { button: 0, pointerId: 2, pointerType: "touch", clientX: 10, clientY: 300 })
    expect(card().getAttribute("data-lifting")).toBe("true")
    expect(card().getAttribute("data-dragging")).toBeNull()
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(card().getAttribute("data-dragging")).toBe("true")
    expect(card().getAttribute("data-lifting")).toBeNull()
    expect(screen.getByRole("status").textContent).toContain("Suéltala en un día, una franja o un repartidor.")
    fireEvent.pointerCancel(window, { pointerId: 2 })
    expect(card().getAttribute("data-dragging")).toBeNull()
  })

  it("con el dedo, moverse antes de tiempo es desplazar la página: no se levanta", () => {
    vi.useFakeTimers()
    render(<Screen onDrop={() => {}} />)
    fireEvent.pointerDown(screen.getByText("Carla Mendoza"), { button: 0, pointerId: 3, pointerType: "touch", clientX: 10, clientY: 300 })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 10, clientY: 340 })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(card().getAttribute("data-dragging")).toBeNull()
    expect(card().getAttribute("data-lifting")).toBeNull()
  })

  it("quedarse sobre la flecha pasa de semana; soltar ahí no avisa nada", () => {
    vi.useFakeTimers()
    const onDrop = vi.fn()
    const onStep = vi.fn()
    render(<Screen onDrop={onDrop} onStep={onStep} />)
    mouseDragTo(screen.getByRole("button", { name: "Semana siguiente" }))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(onStep).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("con el teclado: Alt+Intro levanta, las flechas eligen el destino e Intro suelta", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    const open = screen.getByRole("button", { name: /^Abrir:/ })
    open.focus()
    fireEvent.keyDown(open, { key: "Enter", altKey: true })
    expect(screen.getByRole("status").textContent).toContain("Flechas para elegir dónde")
    // Los días van primero en la pantalla; la flecha de la semana no es un destino del teclado.
    fireEvent.keyDown(open, { key: "ArrowRight" })
    expect(day(/26 de noviembre/).getAttribute("data-drop-over")).toBe("true")
    fireEvent.keyDown(open, { key: "ArrowRight" })
    expect(screen.getByRole("status").textContent).toBe(`Sobre ${FRIDAY}`)
    fireEvent.keyDown(open, { key: "Enter" })
    expect(onDrop).toHaveBeenCalledWith("0164", { date: FRIDAY })
  })

  it("Escape cancela sin avisar", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    const open = screen.getByRole("button", { name: /^Abrir:/ })
    fireEvent.keyDown(open, { key: "Enter", altKey: true })
    fireEvent.keyDown(open, { key: "ArrowRight" })
    fireEvent.keyDown(open, { key: "Escape" })
    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toBe("No se movió nada.")
  })

  it("con el mouse, Escape deja todo como estaba y soltar después no avisa nada", () => {
    const onDrop = vi.fn()
    render(<Screen onDrop={onDrop} />)
    mouseDragTo(day(/27 de noviembre/))
    fireEvent.keyDown(window, { key: "Escape" })
    expect(card().getAttribute("data-dragging")).toBeNull()
    expect(document.querySelector("[data-drop-ghost]")).toBeNull()
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toBe("No se movió nada.")
  })

  it("levantada con el teclado, si el foco se va queda donde estaba; Espacio no la abre", () => {
    const onDrop = vi.fn()
    const onOpen = vi.fn()
    render(<Screen onDrop={onDrop} onOpen={onOpen} />)
    const open = screen.getByRole("button", { name: /^Abrir:/ })
    fireEvent.keyDown(open, { key: "Enter", altKey: true })
    fireEvent.keyDown(open, { key: " " })
    fireEvent.click(open)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.blur(open, { relatedTarget: document.body })
    expect(card().getAttribute("data-dragging")).toBeNull()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("sin franja ni recurso en `from`, soltar en «ninguno» no es moverlo", () => {
    const onDrop = vi.fn()
    function Sin() {
      const drag = useScheduleDraggable({ id: "0170", title: "Kiara", from: { date: THURSDAY } })
      const none = useScheduleDropTarget({ date: THURSDAY, resourceId: null })
      return (
        <>
          <div {...none.props} data-testid="sin">
            Sin repartidor
          </div>
          <ul>
            <TaskCard {...drag} title="Kiara" task="Asignar" onOpen={() => {}} />
          </ul>
        </>
      )
    }
    render(
      <ScheduleDropProvider onDrop={onDrop} describe={() => ""}>
        <Sin />
      </ScheduleDropProvider>,
    )
    fireEvent.pointerDown(screen.getByText("Kiara"), { button: 0, pointerId: 4, pointerType: "mouse", clientX: 10, clientY: 300 })
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 30, clientY: 300 })
    pointAt(screen.getByTestId("sin"))
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 60, clientY: 320 })
    fireEvent.pointerUp(window, { pointerId: 4 })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("con el proveedor apagado nada se levanta", () => {
    function Apagado() {
      const drag = useScheduleDraggable({ id: "0164", title: "Carla" })
      return <TaskCard {...drag} title="Carla" task="Empacar" onOpen={() => {}} />
    }
    render(
      <ScheduleDropProvider onDrop={() => {}} describe={() => ""} disabled>
        <ul>
          <Apagado />
        </ul>
      </ScheduleDropProvider>,
    )
    fireEvent.keyDown(screen.getByRole("button", { name: /^Abrir:/ }), { key: "Enter", altKey: true })
    expect(card().getAttribute("data-dragging")).toBeNull()
  })

  it("fuera de un ScheduleDropProvider no hay nada que arrastrar ni destinos", () => {
    render(
      <ScheduleDayStrip dates={[THURSDAY, FRIDAY]} value={THURSDAY} onChange={() => {}} onNext={() => {}} />,
    )
    expect(document.querySelector("[data-drop-target]")).toBeNull()
  })
})
