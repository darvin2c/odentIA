import "./styles.css"
import { BrandProvider, Toaster } from "@odentia/ui"
import {
  AccessLinkPasswordGate,
  applyTheme,
  ErrorState,
  readStoredTheme,
} from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
  useRouter,
} from "@tanstack/react-router"
import { type ComponentType, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DeviceNoticesPage } from "./avisos"
import { CashPage } from "./caja"
import { CatalogPage } from "./catalogo"
import { CustomerPage, CustomersIndex, CustomersLayout } from "./clientes"
import { ConfigFrame, ConfigHomePage, StoreDataPage } from "./configuracion"
import { AccountSupportRoute, PROFILE_PATH, ProfilePage, SUPPORT_PATH } from "./cuenta"
import { DispatchPage } from "./despachos"
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  TwoFactorPage,
  VerifyEmailSentPage,
} from "./entrada"
import { TeamPage } from "./equipo"
import { HomePage } from "./inicio"
import { ApiError, SignedOut } from "./lib/api"
import { startInstalledApp } from "./lib/avisos"
import { authFetch, hasSession, safeNext } from "./lib/cuenta"
import { FILTERS, type OrderFilter } from "./lib/pedidos"
import { BrandPage } from "./marca"
import { DeliveriesPage, PaymentMethodsPage } from "./pagos"
import { OrdersPage } from "./pedidos"
import { PlanPage } from "./plan"
import { ProductPage } from "./producto"
import { ReportsPage } from "./reportes"
import { SofiPage } from "./sofi"
import { InvitationPage, NewStorePage, StoreLayout, StoresPage } from "./tiendas"

// El tema que eligió la persona en «Apariencia» (el mismo de las clínicas), o el de su equipo.
// Dentro de la tienda lo lleva el menú de la persona; aquí vale también para la entrada.
applyTheme(readStoredTheme())
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => applyTheme(readStoredTheme()))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Sin sesión no se reintenta: se manda a entrar.
      // Un rechazo de permisos (403) no cambia al reintentarlo.
      retry: (count, error) =>
        !(error instanceof SignedOut) &&
        !(error instanceof ApiError && error.status === 403) &&
        count < 1,
    },
  },
})

/**
 * Con sesión de la cuenta sigue; sin ella, a entrar, volviendo después aquí. Si la cuenta no
 * responde, la pantalla lo dice y deja reintentar: no manda a entrar a quien ya entró.
 */
async function requireSession({ location }: { location: { href: string } }) {
  if (!(await hasSession())) throw redirect({ to: "/login", search: { next: location.href } })
}

/** Quien ya entró no ve las pantallas de entrar. Si la cuenta no responde, se queda aquí. */
async function skipIfSignedIn({ search }: { search: Record<string, unknown> }) {
  const signedIn = await hasSession().catch(() => false)
  if (signedIn) {
    const next = safeNext(typeof search.next === "string" ? search.next : null) ?? "/"
    throw redirect({ href: next })
  }
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      {/* Arriba, como en las clínicas: abajo taparía los botones de los cajones. */}
      <Toaster position="top-center" richColors />
    </>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-md p-6">
      <ErrorState title="Página no encontrada" message="Esta dirección no es de gestorIA." />
      <a className="mt-4 inline-block underline" href="/">
        Ir al inicio
      </a>
    </div>
  ),
})

const search = (s: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(s)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => [k, String(v)]),
  )

const signedIn = createRoute({
  getParentRoute: () => rootRoute,
  id: "con-sesion",
  beforeLoad: requireSession,
  component: () => (
    <>
      {/* Tras entrar con el enlace de «¿Olvidaste tu contraseña?», pide la nueva aquí mismo. */}
      <AccessLinkPasswordGate request={authFetch} />
      <Outlet />
    </>
  ),
})

// La tienda y sus secciones: el menú del día (Inicio, Despachos, los pedidos, las clientas, el
// catálogo y su producto, Caja, Reportes), y al pie Configuración y la Ayuda.
const storeRoute = createRoute({
  getParentRoute: () => signedIn,
  path: "/tiendas/$id",
  component: StoreLayout,
})

/** Un apartado de Configuración, dentro de su armazón (los grupos a la izquierda). */
const inConfig = (Page: ComponentType) => () => (
  <ConfigFrame>
    <Page />
  </ConfigFrame>
)

/** Lo que estaba en el menú del día y se mudó a Configuración: la dirección de antes lleva ahí. */
const moved = (from: string, to: string) =>
  createRoute({
    getParentRoute: () => storeRoute,
    path: from,
    beforeLoad: ({ params }) => {
      throw redirect({ href: `/tiendas/${(params as { id: string }).id}${to}`, replace: true })
    },
  })

// Clientes (entrega 4): la lista y, al lado, la ficha abierta. «?q=…» es lo que se busca.
const customersRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "/clientes",
  validateSearch: (s: Record<string, unknown>): { q?: string } =>
    typeof s.q === "string" && s.q ? { q: s.q } : {},
  component: CustomersLayout,
})
const storeChildren = [
  // Inicio (tableros 5 y 16): lo que le toca a cada rol y los primeros pasos de una tienda nueva.
  createRoute({ getParentRoute: () => storeRoute, path: "/", component: HomePage }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/pedidos",
    // «?pedido=…» abre ese pedido (desde Inicio, Despachos o la conversación de prueba);
    // «?filtro=…» abre en ese filtro.
    validateSearch: (s: Record<string, unknown>): { pedido?: string; filtro?: OrderFilter } => ({
      ...(typeof s.pedido === "string" ? { pedido: s.pedido } : {}),
      ...(FILTERS.some((f) => f.value === s.filtro) ? { filtro: s.filtro as OrderFilter } : {}),
    }),
    component: OrdersPage,
  }),
  // Despachos y Caja (entrega 3): qué sale, cuándo y quién lo lleva, y el efectivo del día.
  createRoute({ getParentRoute: () => storeRoute, path: "/despachos", component: DispatchPage }),
  createRoute({ getParentRoute: () => storeRoute, path: "/caja", component: CashPage }),
  customersRoute.addChildren([
    createRoute({ getParentRoute: () => customersRoute, path: "/", component: CustomersIndex }),
    createRoute({
      getParentRoute: () => customersRoute,
      path: "/$customerId",
      component: CustomerPage,
    }),
  ]),
  createRoute({ getParentRoute: () => storeRoute, path: "/reportes", component: ReportsPage }),
  createRoute({ getParentRoute: () => storeRoute, path: "/catalogo", component: CatalogPage }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/catalogo/$productId",
    component: ProductPage,
  }),
  // Configuración (tablero 10): cada apartado con su dirección, en el orden de su menú. Abre con
  // «Lo que falta» (lienzo «gestorIA · Configuración, de nuevo», tablero 3).
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion",
    component: inConfig(ConfigHomePage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/datos",
    component: inConfig(StoreDataPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/marca",
    component: inConfig(BrandPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/equipo",
    component: inConfig(TeamPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/sofi",
    component: inConfig(SofiPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/medios-de-pago",
    component: inConfig(PaymentMethodsPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/entregas",
    component: inConfig(DeliveriesPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/avisos",
    component: inConfig(DeviceNoticesPage),
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/configuracion/plan",
    component: inConfig(PlanPage),
  }),
  moved("/sofi", "/configuracion/sofi"),
  moved("/pagos-y-entregas", "/configuracion/medios-de-pago"),
  moved("/equipo", "/configuracion/equipo"),
  moved("/plan", "/configuracion/plan"),
]

/**
 * Una página que no se pudo abrir (también si la cuenta no respondió al entrar). Reintentar
 * vuelve a comprobar la sesión: `reset` solo limpia el error, `invalidate` vuelve a cargar.
 */
function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter()
  return (
    <div className="mx-auto max-w-md p-6">
      <ErrorState
        error={error instanceof Error ? error : "No se pudo abrir esta página"}
        onRetry={() => {
          reset()
          void router.invalidate()
        }}
      />
    </div>
  )
}

const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    validateSearch: search,
    beforeLoad: skipIfSignedIn,
    component: LoginPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/register",
    validateSearch: search,
    beforeLoad: skipIfSignedIn,
    component: RegisterPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/verify-email-sent",
    validateSearch: search,
    component: VerifyEmailSentPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/forgot-password",
    validateSearch: search,
    component: ForgotPasswordPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/two-factor",
    validateSearch: search,
    component: TwoFactorPage,
  }),
  signedIn.addChildren([
    createRoute({ getParentRoute: () => signedIn, path: "/", component: StoresPage }),
    createRoute({
      getParentRoute: () => signedIn,
      path: "/tiendas/nueva",
      component: NewStorePage,
    }),
    storeRoute.addChildren(storeChildren),
    createRoute({
      getParentRoute: () => signedIn,
      path: "/invitacion/$id",
      component: InvitationPage,
    }),
    // La cuenta de la persona, la misma de todas sus apps (ADR 0218): `?edit=` abre su cajón,
    // `?tienda=` deja volver a la tienda desde la que se llegó y `?caso=` abre un caso de soporte.
    createRoute({
      getParentRoute: () => signedIn,
      path: PROFILE_PATH,
      validateSearch: search,
      component: ProfilePage,
    }),
    createRoute({
      getParentRoute: () => signedIn,
      path: SUPPORT_PATH,
      validateSearch: search,
      component: AccountSupportRoute,
    }),
  ]),
])

const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteError,
})

// La app instalable (tablero 15): el service worker muestra los avisos y, con la app abierta, al
// tocar uno le pasa la pantalla al router, que respeta lo que se está escribiendo.
startInstalledApp((href) => void router.navigate({ href }))

// Si la sesión de la cuenta vence a mitad, cualquier pantalla manda a entrar. Si a soporte se le
// terminó el acceso (o la tienda todavía no responde), la tienda se vuelve a mirar: deja de salir
// en su lista y la pantalla dice por qué (ADR 0219).
queryClient.getQueryCache().subscribe((event) => {
  const error =
    event.type === "updated" && event.action.type === "error" ? event.action.error : null
  if (
    error instanceof ApiError &&
    error.code.startsWith("SUPPORT_") &&
    event.query.queryKey[0] !== "yo" &&
    event.query.queryKey[0] !== "soporte-mio"
  )
    void queryClient.invalidateQueries({ queryKey: ["yo"] })
  if (event.type === "updated" && event.query.state.error instanceof SignedOut) {
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    )
  }
})

const container = document.getElementById("app")
if (container)
  createRoot(container).render(
    <StrictMode>
      <BrandProvider brand="gestoria">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </BrandProvider>
    </StrictMode>,
  )
