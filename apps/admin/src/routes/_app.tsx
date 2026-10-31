import {
  AppShell,
  type AppShellNavEntry,
  PagePending,
  type ShellLinkComponent,
  SideDockProvider,
  SideDockSlot,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, Outlet, useMatches, useRouter, useRouterState } from "@tanstack/react-router"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@odentia/ui"
import type { ComponentType, ReactNode } from "react"
import {
  ArrowLeft,
  BookOpen,
  Building2,
  ListChecks,
  CircleHelp,
  Coins,
  CreditCard,
  Home,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react"
import { z } from "zod"
import { AdminBrand, AdminMark, ProductLogos } from "../components/admin-brand"
import { api } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { panelUrl } from "../lib/host"
import { type AdminSession, rememberSeenSession, requireAdminSession, useSeenSession } from "../lib/session"

export const Route = createFileRoute("/_app")({
  // Sin SSR: si el código hace falta lo decide la API con la cookie del equipo
  // y el país de quien mira (ADR 0090), y eso solo lo tiene su navegador.
  ssr: false,
  beforeLoad: async () => ({ adminSession: await requireAdminSession() }),
  pendingComponent: AdminPending,
  component: AdminLayout,
})

const RouterLink: ShellLinkComponent = ({ to, search, ...props }) => (
  <Link to={to} search={search} {...props} />
)
const appRoute = getRouteApi("/_app")

/**
 * Al recargar, mientras la API confirma la sesión: el esqueleto de la pantalla de
 * la dirección y, si este navegador ya vio a esta persona, su marco. Sin números
 * en el menú: esos sí se piden, y con la sesión confirmada.
 */
function AdminPending() {
  const router = useRouter()
  const leaf = useMatches({ select: (matches) => matches.at(-1)?.routeId })
  const own = leaf ? (router.routesById as unknown as Record<string, { options: { pendingComponent?: unknown } }>)[leaf]?.options.pendingComponent : undefined
  const Screen = (own ?? PagePending) as ComponentType
  const seen = useSeenSession()
  return seen ? (
    <AdminFrame session={seen}>
      <Screen />
    </AdminFrame>
  ) : (
    <Screen />
  )
}

function AdminLayout() {
  const { adminSession } = appRoute.useRouteContext()
  // Hojas sin responder: el número rojo del menú (decisión 6 del lienzo).
  const complaints = useQuery({
    queryKey: ["admin", "complaints-summary"],
    queryFn: async () =>
      z
        .object({ pending: z.number() })
        .parse(await api<unknown>("/api/admin/consumer-complaints/summary")),
    staleTime: 60_000,
  })
  // Solicitudes por revisar de la lista de espera (Fundadores, issue 165).
  const waitlist = useQuery({
    queryKey: ["admin", "overview", "nav"],
    queryFn: async () => api<{ items: { key: string; count: number }[] }>("/api/admin/overview"),
    select: (data) => data.items.find((item) => item.key === "waitlist")?.count ?? 0,
    staleTime: 60_000,
  })
  return (
    <AdminFrame session={adminSession} waitlist={waitlist.data} complaints={complaints.data?.pending}>
      <Outlet />
    </AdminFrame>
  )
}

function AdminFrame({ session, waitlist, complaints, children }: { session: AdminSession; waitlist?: number; complaints?: number; children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const queryClient = useQueryClient()
  const items: AppShellNavEntry[] = [
    { label: "Inicio", to: "/", icon: Home },
    { label: "Lista de espera", to: "/waitlist", icon: ListChecks, badge: waitlist || undefined },
    { label: "Organizaciones", to: "/organizations", icon: Building2 },
    { label: "Usuarios", to: "/users", icon: Users },
    ...(session.actor.role === "admin"
      ? [
          { label: "Cobros y planes", to: "/billing", icon: CreditCard },
          { label: "Comisiones", to: "/commissions", icon: Coins },
        ]
      : []),
    { label: "Soporte", to: "/support", icon: CircleHelp },
    {
      label: "Libro de Reclamaciones",
      to: "/complaints",
      icon: BookOpen,
      badge: complaints || undefined,
    },
    ...(session.actor.role === "admin"
      ? [{ label: "Equipo y actividad", to: "/team", icon: ShieldCheck }]
      : []),
  ]
  return (
    <AppShell
      items={items}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{
        name: session.user.name,
        email: session.user.email,
        avatarUrl: session.user.image ?? undefined,
      }}
      userMenuItems={[
        { label: "Mi cuenta", icon: UserRound, href: panelUrl("/profile") },
        { label: "Seguridad de acceso", icon: ShieldCheck, to: "/security" },
      ]}
      brand={<AdminBrand />}
      brandIcon={<AdminMark />}
      switcher={<ProductLogos className="px-2 pt-1 pb-2" />}
      sidebarFooter={
        // Un ítem del menú como los demás: con el menú en íconos queda la flecha y su globo, no el
        // texto partido. Lleva al panel, otra app, así que es un enlace normal y no del router.
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Mis organizaciones"
              className="h-10 text-muted-foreground [&>svg]:text-muted-foreground"
              render={<a href={panelUrl()} />}
            >
              <ArrowLeft />
              <span>Mis organizaciones</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      }
      onSignOut={async () => {
        await authClient.signOut()
        rememberSeenSession(null)
        queryClient.clear()
        window.location.assign(panelUrl("/login"))
      }}
    >
      <SideDockProvider draftGuard={DraftGuard}>
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <SideDockSlot />
        </div>
      </SideDockProvider>
    </AppShell>
  )
}
