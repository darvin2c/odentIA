import "./styles.css"
import { Toaster } from "@odentia/ui"
import { AccessLinkPasswordGate, ErrorState } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
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
import { authClient, authFetch, safeNext } from "./lib/cuenta"
import { PaymentsPage } from "./pagos"
import { OrdersPage } from "./pedidos"
import { ProductPage } from "./producto"
import { InvitationPage, NewStorePage, StoreLayout, StoresPage, TeamPage } from "./tiendas"

// El tema sigue al del equipo de la persona.
const dark = window.matchMedia("(prefers-color-scheme: dark)")
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches)
applyTheme()
dark.addEventListener("change", applyTheme)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Sin sesión no se reintenta: se manda a entrar.
      retry: (count, error) => !(error instanceof SignedOut) && count < 1,
    },
  },
})

/** Con sesión de la cuenta sigue; sin ella, a entrar, volviendo después aquí. */
async function requireSession({ location }: { location: { href: string } }) {
  const { data } = await authClient.getSession().catch(() => ({ data: null }))
  if (!data?.session) throw redirect({ to: "/login", search: { next: location.href } })
}

/** Quien ya entró no ve las pantallas de entrar. */
async function skipIfSignedIn({ search }: { search: Record<string, unknown> }) {
  const { data } = await authClient.getSession().catch(() => ({ data: null }))
  if (data?.session) {
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

// La tienda y sus secciones: los pedidos, el catálogo (su producto), pagos y entregas, y el equipo.
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
  createRoute({ getParentRoute: () => storeRoute, path: "/pedidos", component: OrdersPage }),
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
]

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
  defaultErrorComponent: ({ error, reset }) => (
    <div className="mx-auto max-w-md p-6">
      <ErrorState
        error={error instanceof Error ? error : "No se pudo abrir esta página"}
        onRetry={reset}
      />
    </div>
  ),
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
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
