import { createRouter, type Router } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export type AdminRouter = Router<typeof routeTree>

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AdminRouter
  }
}
