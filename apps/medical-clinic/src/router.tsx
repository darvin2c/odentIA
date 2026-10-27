import { declareProduct } from "@odentia/clinic-app/product/product-ui"
import { createRouter } from "@tanstack/react-router"
import { medicalUi } from "./product/medical"
import { routeTree } from "./routeTree.gen"

// Esta es la app de latidIA: lo común le pide sus partes al producto médico (ADR 0079).
declareProduct(medicalUi)

export function getRouter() {
  return createRouter({
    routeTree,
    // Al acercar el puntero (o el foco) a un enlace se baja el código de esa
    // pantalla y corre su `beforeLoad`: al hacer clic ya está lista.
    defaultPreload: "intent",
    // La agenda posiciona su timeline según el parámetro `date`: la
    // restauración (que conserva el scroll de contenedores persistentes
    // entre ubicaciones) pisaría ese salto en cada navegación.
    scrollRestoration: ({ location }) => location.pathname !== "/agenda",
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
