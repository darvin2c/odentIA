export {}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

// RTL + React 19 en Vitest: sin este flag los updates en cascada
// (p. ej. el ajuste medido de FilterBar) no se vacían en `act`.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom no implementa matchMedia; `useIsMobile` (Sidebar) lo necesita para
// decidir entre escritorio y drawer móvil. Desktop por defecto: jsdom no
// simula anchos reales y el sidebar de escritorio es la ruta bajo prueba.
// Este setup también corre en entorno node (tests sin directiva jsdom), de
// ahí la guarda `typeof window`.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
