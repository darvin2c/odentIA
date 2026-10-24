/**
 * Lo médico de los servicios (ADR 0079), para lo que es de latidIA: la
 * medición de Clío médica y sus pruebas. Lo común no lo importa.
 */
// Primero los productos: `dictation.ts` llega a `products.ts` por `encounters.ts`, y
// `products.ts` carga `hooks.ts`, que lee `MEDICAL_DICTATION`. Si se entra por aquí
// sin esta línea, `hooks.ts` la lee antes de que exista (la medición de Clío médica
// no arrancaba).
import "../products.js"

export { examSystemsText, MEDICAL_DICTATION } from "./dictation.js"
