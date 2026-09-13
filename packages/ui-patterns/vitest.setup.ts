export {};

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// RTL + React 19 en Vitest: sin este flag los updates en cascada
// (p. ej. el ajuste medido de FilterBar) no se vacían en `act`.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
