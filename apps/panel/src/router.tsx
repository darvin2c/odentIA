import { configureZodMessages } from "@odentia/clinical"
import { RouteErrorScreen, PagePending } from "@odentia/ui-patterns"
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

// Lo que dice una regla sin mensaje propio, en el español de la interfaz.
configureZodMessages()

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: RouteErrorScreen,
    scrollRestoration: true,
    // Si la pantalla tarda en llegar, su esqueleto en vez de la anterior sin ninguna señal.
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 150,
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
