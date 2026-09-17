// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  useTheme,
  type ThemeMode,
} from "./theme.js"

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.documentElement.style.colorScheme = ""
})

// matchMedia bajo control: permite simular cambios del SO.
function stubMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  window.matchMedia = () =>
    ({
      get matches() {
        return matches
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: () => void) => {
        listeners.add(cb)
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb)
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
  return {
    setMatches(next: boolean) {
      matches = next
      listeners.forEach((cb) => cb())
    },
    listenerCount() {
      return listeners.size
    },
  }
}

function Probe({
  value,
  defaultValue,
  onChange,
  next = "dark",
}: {
  value?: ThemeMode
  defaultValue?: ThemeMode
  onChange?: (mode: ThemeMode) => void
  next?: ThemeMode
}) {
  const { mode, setMode } = useTheme({ value, defaultValue, onChange })
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <button type="button" onClick={() => setMode(next)}>
        cambia
      </button>
    </>
  )
}

describe("resolveTheme", () => {
  it("devuelve light/dark tal cual", () => {
    expect(resolveTheme("light")).toBe("light")
    expect(resolveTheme("dark")).toBe("dark")
  })

  it("en system manda prefers-color-scheme", () => {
    stubMatchMedia(true)
    expect(resolveTheme("system")).toBe("dark")
    stubMatchMedia(false)
    expect(resolveTheme("system")).toBe("light")
  })
})

describe("applyTheme", () => {
  it("alterna la clase .dark y color-scheme", () => {
    applyTheme("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe("dark")
    applyTheme("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe("light")
  })
})

describe("readStoredTheme", () => {
  it("por defecto es system e ignora valores inválidos", () => {
    expect(readStoredTheme()).toBe("system")
    localStorage.setItem(THEME_STORAGE_KEY, "rosa")
    expect(readStoredTheme()).toBe("system")
    localStorage.setItem(THEME_STORAGE_KEY, "dark")
    expect(readStoredTheme()).toBe("dark")
  })
})

describe("useTheme", () => {
  it("aplica el tema guardado al montar", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark")
    render(<Probe />)
    expect(screen.getByTestId("mode").textContent).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("persiste y aplica al cambiar", () => {
    render(<Probe />)
    fireEvent.click(screen.getByRole("button", { name: "cambia" }))
    expect(screen.getByTestId("mode").textContent).toBe("dark")
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("en system sigue los cambios del SO sin re-render", () => {
    const media = stubMatchMedia(true)
    render(<Probe defaultValue="system" />)
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(media.listenerCount()).toBe(1)
    media.setMatches(false)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("controlado: avisa onChange sin persistir ni aplicar por su cuenta", () => {
    const onChange = vi.fn()
    render(<Probe value="light" onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "cambia" }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith("dark")
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(screen.getByTestId("mode").textContent).toBe("light")
  })
})
