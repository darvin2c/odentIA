/**
 * Punto de entrada del Email Worker de Sallca (ADR 0185 y 0186). Solo exporta el manejador:
 * el runtime de Cloudflare toma cada exportación de este módulo como un punto de entrada y no
 * arranca si alguna no lo es, y entonces Email Routing marca cada correo como «Error» sin
 * llegar a llamar al Worker. Lo demás vive en `message.ts`, `flow.ts`, `route.ts` y `auth.ts`.
 */
import { emailWorker } from "./message.ts"

export default emailWorker
