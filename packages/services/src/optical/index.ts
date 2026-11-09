/**
 * Lo óptico de los servicios, para lo que es de vistIA. Lo común no lo importa:
 * se conecta solo por `products.ts`.
 */
// Primero los productos, como en `medical/index.ts`: `products.ts` carga `hooks.ts`.
import "../products.js"

export { OPTICAL_AGENT_TEXTS } from "./agent-texts.js"
export { opticalHooks } from "./hooks.js"
