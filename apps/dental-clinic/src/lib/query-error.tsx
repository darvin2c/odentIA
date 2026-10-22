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

export function mutationErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (isAmbiguousMutationError(error)) return "No pudimos confirmar el resultado. Conservamos los campos; consulta el estado actual antes de iniciar otra operación para evitar duplicados."
  if (error instanceof ApiError) {
    if (error.status === 403) return "No tienes permiso para guardar estos cambios. Solicita acceso a la administración; los campos se conservan."
    if (error.status === 401) return "Tu sesión venció. Conserva los datos e inicia sesión antes de continuar."
    if (error.status === 404) return "El registro ya no está disponible. Consulta la lista actual antes de continuar; los campos se conservan."
    if (error.status === 409) return "Los datos entran en conflicto con el estado actual. Consulta el registro y revisa los campos antes de guardar."
    if (error.status === 429) return "Hay demasiadas solicitudes. Espera un momento antes de volver a guardar; los campos se conservan."
  }
  return "No se guardaron los cambios. Revisa los campos y las selecciones antes de volver a guardar."
}
