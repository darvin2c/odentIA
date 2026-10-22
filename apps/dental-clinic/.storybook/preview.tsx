import { Toaster } from "@odentia/ui"
import type { Preview } from "@storybook/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { type ReactNode, useMemo, useRef } from "react"
import "./storybook.css"

/**
 * Entorno de las maquetas: tokens reales del design system, React Query (los
 * componentes reales consultan de verdad, contra el transporte falso) y un
 * router en memoria.
 *
 * La historia se monta COMO RUTA del router (`component`), no como hermano del
 * `RouterProvider`: los paneles reales usan `Link` (p. ej. el tarifario en
 * `ServicePicker`) y sin el contexto del router fallan al renderizar.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

function Providers({ children }: { children: ReactNode }) {
  // La historia cambia de una a otra sin recrear el router: la ruta lee siempre
  // el valor vigente del ref.
  const story = useRef(children)
  story.current = children

  const router = useMemo(() => {
    // La raíz necesita pintar el `Outlet`: sin él la ruta hija (la historia) no aparece.
    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const routes = ["/", "/services", "/patients"].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: path === "/" ? () => <>{story.current}</> : () => null,
      }),
    )
    return createRouter({
      routeTree: rootRoute.addChildren(routes),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <Providers>
        <Story />
        <Toaster position="top-center" richColors />
      </Providers>
    ),
  ],
}

export default preview
