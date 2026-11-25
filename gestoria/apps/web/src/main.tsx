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
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { CatalogPage } from "./catalogo"
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  TwoFactorPage,
  VerifyEmailSentPage,
} from "./entrada"
import { SignedOut } from "./lib/api"
import { authFetch, hasSession, safeNext } from "./lib/cuenta"
import { PaymentsPage } from "./pagos"
import { OrdersPage } from "./pedidos"
import { PlanPage } from "./plan"
import { ProductPage } from "./producto"
import { ReportsPage } from "./reportes"
import { SofiPage } from "./sofi"
import { InvitationPage, NewStorePage, StoreLayout, StoresPage, TeamPage } from "./tiendas"

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
      retry: (count, error) => !(error instanceof SignedOut) && count < 1,
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
      <Toaster />
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

// La tienda y sus secciones: los pedidos, Sofi, el catálogo (su producto), pagos y entregas,
// Reportes y el equipo.
const storeRoute = createRoute({
  getParentRoute: () => signedIn,
  path: "/tiendas/$id",
  component: StoreLayout,
})
const storeChildren = [
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/",
    beforeLoad: ({ params }) => {
      throw redirect({ to: "/tiendas/$id/pedidos", params, replace: true })
    },
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/pedidos",
    // «?pedido=…» abre ese pedido (desde Argos o desde la conversación de prueba).
    validateSearch: (s: Record<string, unknown>): { pedido?: string } =>
      typeof s.pedido === "string" ? { pedido: s.pedido } : {},
    component: OrdersPage,
  }),
  createRoute({ getParentRoute: () => storeRoute, path: "/sofi", component: SofiPage }),
  createRoute({ getParentRoute: () => storeRoute, path: "/reportes", component: ReportsPage }),
  createRoute({ getParentRoute: () => storeRoute, path: "/catalogo", component: CatalogPage }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/catalogo/$productId",
    component: ProductPage,
  }),
  createRoute({
    getParentRoute: () => storeRoute,
    path: "/pagos-y-entregas",
    component: PaymentsPage,
  }),
  createRoute({ getParentRoute: () => storeRoute, path: "/equipo", component: TeamPage }),
  createRoute({ getParentRoute: () => storeRoute, path: "/plan", component: PlanPage }),
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
  ]),
])

const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteError,
})

// Si la sesión de la cuenta vence a mitad, cualquier pantalla manda a entrar.
queryClient.getQueryCache().subscribe((event) => {
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
