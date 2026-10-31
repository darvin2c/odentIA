import { PagePending } from "@odentia/ui-patterns"
import { createRouter } from "@tanstack/react-router"
import { dentalUi } from "./product/dental"
import { declareProduct } from "@odentia/clinic-app/product/product-ui"
import { routeTree } from "./routeTree.gen"

// Esta es la app de odentIA: lo común le pide sus partes al producto dental (ADR 0079).
declareProduct(dentalUi)

export function getRouter() {
  return createRouter({
    routeTree,
    // Al acercar el puntero (o el foco) a un enlace se baja el código de esa
    // pantalla y corre su `beforeLoad`: al hacer clic ya está lista.
    defaultPreload: "intent",
    // Si la pantalla tarda en llegar, su esqueleto en vez de la anterior sin ninguna señal.
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 150,
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
