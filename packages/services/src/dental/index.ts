/**
 * Lo dental de los servicios (ADR 0079), para lo que es de odentIA: las rutas
 * dentales de la API, Clío y la semilla de demostración. Lo común no lo importa.
 */
// Primero los productos: `dictation.ts` llega a `products.ts` y este carga `hooks.ts`,
// que lee `DENTAL_DICTATION`; sin esta línea, entrar por aquí lo lee antes de que exista
// (la medición de Clío no arrancaba). Lo mismo en `../medical/index.ts`.
import "../products.js"

export * from "./dictation.js"
export * from "./odontogram.js"
export * from "./periodontal.js"
export * from "./tooth-history.js"
export * from "./tooth-panel.js"
export * from "./treated-findings.js"
