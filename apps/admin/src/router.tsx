import { PagePending } from "@odentia/ui-patterns"
import { createRouter, type Router } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export type AdminRouter = Router<typeof routeTree>

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Si la pantalla tarda en llegar, su esqueleto en vez de la anterior sin ninguna señal.
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 150,
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AdminRouter
  }
}
