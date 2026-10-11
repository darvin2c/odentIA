/**
 * Finanzas (legado en retirada): solo conserva el mensaje de error canónico,
 * usado por la UI nueva. El cliente vigente vive en `finance-collect.ts`
 * (contrato CobrosCaja/Configuración/Presupuestos). Los endpoints viejos
 * (turnos, proveedores en finanzas, cuotas, resumen) se retiran en backend;
 * no agregar aquí llamadas nuevas.
 */
import { ApiError } from "./api"

/** Mensaje de error en español para mutaciones de caja y finanzas. */
export function financeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

export { financeErrorMessage as collectErrorMessage }
