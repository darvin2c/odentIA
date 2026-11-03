import { useNavigate, useSearch } from "@tanstack/react-router"
import * as React from "react"

export interface ListSearchController {
  search: Record<string, unknown>
  get: (key: string) => string | undefined
  setParam: (key: string, value?: string, options?: { replace?: boolean }) => void
  setParams: (patch: Record<string, string | undefined>, options?: { replace?: boolean }) => void
  resetFilters: () => void
  /** Vive en memoria (`useScopedListSearch`): no hay historial al que volver. */
  scoped?: boolean
}

const ScopedListSearch = React.createContext<ListSearchController | null>(null)

/** Una lista abierta encima de otra pantalla: sus filtros no son los de la dirección de debajo. */
export const ListSearchScope = ScopedListSearch.Provider

/** La búsqueda de una lista que no vive en la dirección, para `ListSearchScope`. */
export function useScopedListSearch(initial: Record<string, string | undefined>): ListSearchController {
  const [search, setSearch] = React.useState(initial)
  return React.useMemo(() => {
    const setParams: ListSearchController["setParams"] = (patch) => setSearch((previous) => ({ ...previous, ...patch }))
    return {
      search,
      scoped: true,
      get: (key) => search[key] || undefined,
      setParams,
      setParam: (key, value) => setParams({ [key]: value }),
      resetFilters: () => setSearch({}),
    }
  }, [search])
}

/** Puente único entre los controles de listas y la URL plana (o su `ListSearchScope`). */
export function useListSearch(): ListSearchController {
  const scoped = React.useContext(ScopedListSearch)
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()

  const get = React.useCallback(
    (key: string) => {
      const value = search[key]
      return typeof value === "string" || typeof value === "number" ? String(value) : undefined
    },
    [search],
  )

  const setParams = React.useCallback(
    (patch: Record<string, string | undefined>, options?: { replace?: boolean }) => {
      const resetsCursor = Object.keys(patch).some((key) => key !== "cursor")
      void navigate({
        to: ".",
        replace: options?.replace ?? false,
        search: (previous: Record<string, unknown>) => {
          const next = { ...(previous as Record<string, unknown>) }
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === "") delete next[key]
            else next[key] = value
          }
          if (resetsCursor) delete next.cursor
          return next
        },
      })
    },
    [navigate],
  )

  const setParam = React.useCallback(
    (key: string, value?: string, options?: { replace?: boolean }) => {
      setParams({ [key]: value }, options)
    },
    [setParams],
  )

  const resetFilters = React.useCallback(() => {
    // Las apps consumidoras aumentan los tipos del router (Register); esta
    // librería navega con search plano, de ahí el cast a los options crudos.
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => {
        const sort = (previous as Record<string, unknown>).sort
        return typeof sort === "string" ? { sort } : {}
      },
    } as Parameters<typeof navigate>[0])
  }, [navigate])

  return scoped ?? { search, get, setParam, setParams, resetFilters }
}
