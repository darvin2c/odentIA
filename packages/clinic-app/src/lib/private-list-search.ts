import { type ListSearchController, useListSearch } from "@odentia/ui-patterns"
import { useCallback, useEffect, useMemo, useState } from "react"

/**
 * Lo que se escribe en el buscador de una lista de personas (un nombre, un teléfono, un
 * documento) no va en la dirección: quedaba en el historial del navegador y en los registros de
 * quien atiende las peticiones (repaso final de la ficha del 10 nov, M4). Vive en memoria y en el
 * estado de esa entrada del historial (`history.state`), así «Atrás» desde la ficha vuelve a la
 * lista con la misma búsqueda. Los demás filtros (vista, atajo) siguen en la dirección.
 *
 * Se usa con `ListSearchScope` alrededor de la lista: el buscador y los filtros leen este
 * controlador en vez del de la dirección.
 */
const STATE_KEY = "odentiaListQuery"

function readStateQuery(): string | undefined {
  if (typeof window === "undefined") return undefined
  try {
    const value = (window.history.state as Record<string, unknown> | null)?.[STATE_KEY]
    return typeof value === "string" && value ? value : undefined
  } catch {
    return undefined
  }
}

function writeStateQuery(query: string | undefined): void {
  if (typeof window === "undefined") return
  try {
    const state = (window.history.state as Record<string, unknown> | null) ?? {}
    if ((state[STATE_KEY] ?? undefined) === query) return
    const next = { ...state }
    if (query) next[STATE_KEY] = query
    else delete next[STATE_KEY]
    window.history.replaceState(next, "", window.location.href)
  } catch {
    // Sin acceso al historial, la búsqueda sigue en memoria: solo no vuelve con «Atrás».
  }
}

export function usePrivateListSearch(): ListSearchController {
  const url = useListSearch()
  const fromUrl = url.get("q")
  const [query, setQuery] = useState<string | undefined>(() => fromUrl ?? readStateQuery())
  const {
    get: getUrl,
    setParam: setUrlParam,
    setParams: setUrlParams,
    resetFilters: resetUrlFilters,
    search: urlSearch,
  } = url

  // Un enlace guardado o viejo que trae `?q=`: la búsqueda pasa a memoria y sale de la dirección.
  useEffect(() => {
    if (fromUrl === undefined) return
    setQuery(fromUrl)
    setUrlParam("q", undefined, { replace: true })
  }, [fromUrl, setUrlParam])

  // Cada navegación de la lista (otra vista, un atajo) reescribe la entrada del historial: se
  // vuelve a guardar la búsqueda en ella para que «Atrás» la encuentre.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `urlSearch` cambia con cada navegación
  useEffect(() => writeStateQuery(query), [query, urlSearch])

  const setParams = useCallback<ListSearchController["setParams"]>(
    (patch, options) => {
      const { q, ...rest } = patch
      if ("q" in patch) setQuery(q?.trim() ? q : undefined)
      if (Object.keys(rest).length > 0) setUrlParams(rest, options)
    },
    [setUrlParams],
  )

  return useMemo<ListSearchController>(
    () => ({
      search: { ...urlSearch, ...(query ? { q: query } : {}) },
      get: (key) => (key === "q" ? query : getUrl(key)),
      setParams,
      setParam: (key, value, options) => setParams({ [key]: value }, options),
      resetFilters: () => {
        setQuery(undefined)
        resetUrlFilters()
      },
    }),
    [query, urlSearch, getUrl, setParams, resetUrlFilters],
  )
}
