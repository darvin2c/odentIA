/**
 * Media query en cliente, sin parpadeo: `useLayoutEffect` con respaldo a
 * `useEffect` en SSR, el mismo patrón que `useResolvedView` (data-table) y
 * master-detail. Solo para cuando la estructura cambia de verdad (la semana
 * pasa de 7 días a 1, el mes pasa a lista); el resto se resuelve con CSS.
 */

import * as React from "react"

const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const media = window.matchMedia(query)
    const apply = () => setMatches(media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [query])

  return matches
}

/** Por debajo de 640px el timeline se vuelve un stream vertical por día. */
export const SCHEDULE_SMALL_QUERY = "(max-width: 639px)"
