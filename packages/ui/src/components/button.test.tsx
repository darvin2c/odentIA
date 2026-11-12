// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Button } from "./button"

/**
 * El botón con forma de enlace (`render={<a href>}` o el `Link` del router):
 * sigue siendo un enlace, con su rol, y Base UI no avisa en la consola que no
 * es un `<button>` (lo que pasaba en /security y en cada enlace así).
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Como el `Link` del router: recibe `to` y pinta un `<a href>`. */
function RouterLink({ to, ...props }: { to: string } & ComponentProps<"a">) {
  return <a href={to} {...props} />
}

let host: HTMLDivElement
let root: Root
let logged: string[]

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  logged = []
  const keep = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
  vi.spyOn(console, "error").mockImplementation(keep)
  vi.spyOn(console, "warn").mockImplementation(keep)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function show(node: ReactNode): HTMLElement {
  act(() => root.render(node))
  const element = host.firstElementChild
  if (!(element instanceof HTMLElement)) throw new Error("No se pintó nada")
  return element
}

describe("un enlace con forma de botón", () => {
  it("un <a href> sigue siendo un enlace, con las clases del botón y sin avisos de Base UI", () => {
    const link = show(
      <Button className="flex-1" render={<a href="https://example.test/app" target="_blank" rel="noreferrer" />}>
        Para iPhone
      </Button>,
    )
    // Lo que se veía en la consola de /security: «Base UI: A component that acts as a button expected a native <button>…».
    expect(logged.filter((line) => line.includes("Base UI"))).toEqual([])
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("https://example.test/app")
    expect(link.getAttribute("target")).toBe("_blank")
    // Su rol es el del enlace: ni role="button" ni type="button".
    expect(link.getAttribute("role")).toBeNull()
    expect(link.getAttribute("type")).toBeNull()
    expect(link.dataset.slot).toBe("button")
    expect(link.className).toContain("inline-flex")
    expect(link.className).toContain("bg-primary-fill")
    expect(link.className).toContain("flex-1")
    expect(link.textContent).toBe("Para iPhone")
  })

  it("el Link del router también, con su variante", () => {
    const onClick = vi.fn()
    const link = show(
      <Button variant="outline" size="sm" onClick={onClick} render={<RouterLink to="/organizations" />}>
        Ver gastos
      </Button>,
    )
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("/organizations")
    expect(link.getAttribute("role")).toBeNull()
    expect(link.getAttribute("type")).toBeNull()
    expect(link.className).toContain("bg-secondary")
    expect(link.className).toContain("h-8")
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(logged.filter((line) => line.includes("Base UI"))).toEqual([])
  })
})

describe("lo demás sigue como estaba", () => {
  it("un botón es un <button type=button>", () => {
    const button = show(<Button>Guardar</Button>)
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("type")).toBe("button")
    expect(button.dataset.slot).toBe("button")
  })

  it("quien elige nativeButton decide: un <div> recibe el rol de botón", () => {
    const div = show(
      <Button nativeButton={false} render={<div />}>
        Abrir
      </Button>,
    )
    expect(div.tagName).toBe("DIV")
    expect(div.getAttribute("role")).toBe("button")
    expect(logged.filter((line) => line.includes("Base UI"))).toEqual([])
  })
})
