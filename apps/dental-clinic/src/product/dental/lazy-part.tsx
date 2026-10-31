import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { type ComponentType, lazy, type ReactNode, Suspense } from "react"

function PartFailed() {
  return <ErrorState title="No se pudo abrir esta parte" message="Guarda lo que estés haciendo y recarga la página." retryLabel="Recargar" onRetry={() => window.location.reload()} />
}

/**
 * Una parte pesada del producto: `router.tsx` declara el producto al arrancar y
 * lo que se importa de aquí llegaría a todas las pantallas, también al portal.
 * Así, su código baja solo cuando alguien la abre. `fallback`: su esqueleto propio,
 * si lo tiene. Si su código no baja (red, o una pestaña abierta antes de un
 * despliegue), lo dice en su sitio: la página y lo que se está escribiendo siguen ahí.
 */
export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = <LoadingState />,
): (props: P) => React.JSX.Element {
  const Part = lazy(async () => ({ default: await load().catch(() => PartFailed as ComponentType<P>) })) as unknown as ComponentType<P>
  return function LazyPart(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Part {...props} />
      </Suspense>
    )
  }
}
