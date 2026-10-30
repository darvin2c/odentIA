import { ErrorState } from "@odentia/ui-patterns"
import { ApiError } from "./api"

/** Solo el estado HTTP decide la presentación; nunca mostramos mensajes internos. */
export function QueryErrorState({ error, onRetry, notFound = "El recurso solicitado ya no está disponible.", invalid }: {
  error: unknown
  onRetry: () => void
  notFound?: string
  invalid?: string
}) {
  if (error instanceof ApiError) {
    if (error.status === 403) return <ErrorState title="Sin acceso" message="No tienes permiso para consultar esta información. Solicita acceso a la administración de la clínica." />
    if (error.status === 401) return <ErrorState title="Sesión vencida" message="Vuelve a iniciar sesión para continuar." />
    if (error.status === 404) return <ErrorState title="No encontrado" message={notFound} />
    if ((error.status === 400 || error.status === 422) && invalid) return <ErrorState title="Revisa la consulta" message={invalid} />
  }
  return <ErrorState title="No pudimos cargar la información" message="Comprueba tu conexión y vuelve a consultar. Si el problema continúa, contacta con la administración de la clínica." onRetry={onRetry} />
}

/** Sin confirmación no sabemos si el servidor llegó a aplicar la operación. */
export function isAmbiguousMutationError(error: unknown): boolean {
  return error != null && (!(error instanceof ApiError) || error.status >= 500 || error.status === 408)
}
