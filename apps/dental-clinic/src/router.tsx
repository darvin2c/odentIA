import { createRouter } from "@tanstack/react-router"
import { dentalUi } from "./product/dental"
import { declareProduct } from "./product/product-ui"
import { routeTree } from "./routeTree.gen"

// Esta es la app de odentIA: lo común le pide sus partes al producto dental (ADR 0079).
declareProduct(dentalUi)

export function getRouter() {
  return createRouter({
    routeTree,
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
