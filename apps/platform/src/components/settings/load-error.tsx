import { Alert, AlertDescription, Button } from "@odentia/ui"
import { ErrorState } from "@odentia/ui-patterns"

/**
 * Cuando un apartado de Configuración no carga, todos dicen lo mismo:
 * «No pudimos cargar…» con «Reintentar».
 *
 * `stale` es el fallo al actualizar algo que ya estaba en pantalla: el aviso
 * acompaña a lo cargado, no lo reemplaza. La pantalla lo decide con
 * `query.isError` y si `query.data` existe.
 */
export function SettingsLoadError({
  what,
  onRetry,
  stale = false,
}: {
  /** Lo que no cargó, con su artículo: «las especialidades», «el portal del paciente». */
  what: string
  onRetry: () => void
  stale?: boolean
}) {
  if (!stale) {
    return (
      <ErrorState
        title={`No pudimos cargar ${what}`}
        message="Comprueba tu conexión y vuelve a intentarlo."
        onRetry={onRetry}
      />
    )
  }
  return (
    <Alert variant="destructive" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <AlertDescription className="min-w-0 flex-1 basis-64">
        No pudimos actualizar {what}. Lo que ves es lo último que cargó.
      </AlertDescription>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onRetry}>
        Reintentar
      </Button>
    </Alert>
  )
}
