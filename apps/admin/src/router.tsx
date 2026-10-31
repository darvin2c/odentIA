import { configureZodMessages } from "@odentia/clinical"
import { createRouter, type Router } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

// Lo que dice una regla sin mensaje propio, en el español de la interfaz.
configureZodMessages()

export type AdminRouter = Router<typeof routeTree>

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AdminRouter
  }
}
