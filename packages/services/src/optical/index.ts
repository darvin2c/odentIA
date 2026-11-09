/**
 * Lo óptico de los servicios, para lo que es de vistIA (ADR 0168 y 0169). Lo
 * común no lo importa: se conecta solo por `products.ts`; las rutas de vistIA lo
 * piden con `@odentia/services/optical`.
 */
// Primero los productos, como en `medical/index.ts`: `products.ts` carga `hooks.ts`.
import "../products.js"

export { OPTICAL_AGENT_TEXTS } from "./agent-texts.js"
export { opticalHooks } from "./hooks.js"
export { renderLensPrescriptionPdf } from "./lens-prescription-pdf.js"
export {
  currentLensPrescriptions,
  issueLensPrescription,
  type LensPrescriptionView,
  listLensPrescriptions,
  transcribeLensPrescription,
  verifyLensPrescription,
  voidLensPrescription,
} from "./lens-prescriptions.js"
