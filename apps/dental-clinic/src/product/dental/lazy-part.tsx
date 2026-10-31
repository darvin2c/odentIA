import { LoadingState } from "@odentia/ui-patterns"
import { type ComponentType, lazy, type ReactNode, Suspense } from "react"

/**
 * Una parte pesada del producto: `router.tsx` declara el producto al arrancar y
 * lo que se importa de aquí llegaría a todas las pantallas, también al portal.
 * Así, su código baja solo cuando alguien la abre. `fallback`: su esqueleto propio,
 * si lo tiene.
 */
export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = <LoadingState />,
): (props: P) => React.JSX.Element {
  const Part = lazy(async () => ({ default: await load() })) as unknown as ComponentType<P>
  return function LazyPart(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Part {...props} />
      </Suspense>
    )
  }
}
