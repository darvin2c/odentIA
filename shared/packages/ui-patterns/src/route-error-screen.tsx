import { ErrorState } from "./error-state.js"

/**
 * Lo que se ve cuando una pantalla no llega a cargar (por ejemplo, un corte con la
 * API). Sin esto, el enrutador muestra su propio aviso en inglés con el error técnico.
 * Reintentar recarga la página: el fallo puede venir del servidor, y ahí el enrutador
 * no tiene nada que repetir.
 */
export function RouteErrorScreen() {
  return (
    <main className="mx-auto w-full max-w-md p-6">
      <ErrorState
        title="No se pudo abrir esta página"
        message="Puede ser un corte momentáneo. Vuelve a intentarlo en unos segundos."
        onRetry={() => window.location.reload()}
      />
    </main>
  )
}
