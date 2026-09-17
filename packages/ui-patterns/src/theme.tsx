import { Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { Monitor, Moon, Sun } from "lucide-react"
import * as React from "react"

export type ThemeMode = "light" | "dark" | "system"

export const THEME_STORAGE_KEY = "odentia-theme"

const DARK_QUERY = "(prefers-color-scheme: dark)"

function isValidMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system"
}

// Tema efectivo: en "system" manda el SO/navegador.
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light"
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light"
}

// Aplica el tema como clase `.dark` (variante `@custom-variant dark` de globals.css).
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return
  const dark = resolveTheme(mode) === "dark"
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

export function readStoredTheme(): ThemeMode {
  if (typeof localStorage === "undefined") return "system"
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isValidMode(stored)) return stored
  } catch {
    // localStorage no disponible (SSR, modo privado): tema del sistema.
  }
  return "system"
}

export function useTheme(options?: {
  value?: ThemeMode
  defaultValue?: ThemeMode
  onChange?: (mode: ThemeMode) => void
}): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const { value, defaultValue, onChange } = options ?? {}
  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<ThemeMode>(() => defaultValue ?? readStoredTheme())
  const mode = controlled ? value! : internal

  const setMode = React.useCallback(
    (next: ThemeMode) => {
      if (!controlled) {
        setInternal(next)
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next)
        } catch {
          // Sin persistencia: el tema igual aplica en memoria.
        }
      }
      onChange?.(next)
    },
    [controlled, onChange],
  )

  React.useEffect(() => {
    applyTheme(mode)
    if (mode !== "system" || typeof window === "undefined") return
    const query = window.matchMedia(DARK_QUERY)
    const onSystemChange = () => applyTheme("system")
    query.addEventListener("change", onSystemChange)
    return () => query.removeEventListener("change", onSystemChange)
  }, [mode])

  return { mode, setMode }
}

// Segmento Claro / Oscuro / Sistema para encajar en espacios estrechos
// (dropdown de usuario del AppShell). Iconos con etiqueta accesible.
export function ThemeTabs(props: {
  value: ThemeMode
  onValueChange: (mode: ThemeMode) => void
}): React.JSX.Element {
  return (
    <Tabs value={props.value} onValueChange={(next) => props.onValueChange(next as ThemeMode)}>
      <TabsList className="w-full">
        <TabsTrigger value="light" title="Claro" aria-label="Tema claro">
          <Sun />
        </TabsTrigger>
        <TabsTrigger value="dark" title="Oscuro" aria-label="Tema oscuro">
          <Moon />
        </TabsTrigger>
        <TabsTrigger value="system" title="Sistema" aria-label="Tema del sistema">
          <Monitor />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
