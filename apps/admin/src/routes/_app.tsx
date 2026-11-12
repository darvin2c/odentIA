import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@odentia/ui"
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
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Building2,
  ChartColumn,
  CircleHelp,
  Coins,
  Columns3,
  CreditCard,
  Home,
  Presentation,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { z } from "zod"
import { AdminBrand, AdminMark, ProductLogos } from "../components/admin-brand"
import { api } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { panelUrl } from "../lib/host"
import { rememberSeenSession, requireAdminSession, type SeenSession, useSeenSession } from "../lib/session"

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
 * Al recargar, mientras la API confirma la sesión: el marco y el esqueleto de la
 * pantalla de la dirección, si esta pestaña ya sabe quién trabaja en ella. Sin saberlo
 * (al hidratar, o en una pestaña nueva) la espera general: el esqueleto de una pantalla
 * depende del rol. Sin números en el menú: esos se piden con la sesión confirmada.
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
    <PagePending />
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
  // El número de «Soporte»: el mismo de «Casos de soporte por atender» en Hoy (lo cuenta el
  // servidor con la misma regla).
  const queues = useQuery({
    queryKey: ["admin", "overview", "nav"],
    queryFn: async () => api<{ items: { key: string; count: number }[] }>("/api/admin/overview"),
    select: (data) => ({
      support: data.items.find((item) => item.key === "support-open")?.count ?? 0,
    }),
    staleTime: 60_000,
  })
  // Lo que Kairós dejó y espera un sí, de lo que esta persona puede ver (Soporte no cuenta lo de
  // Administración). Decidir algo invalida `["admin", "kairos"]` y el número se pone al día.
  const kairos = useQuery({
    queryKey: ["admin", "kairos", "count"],
    queryFn: async () => z.object({ waiting: z.number().int().nonnegative() }).parse(await api<unknown>("/api/admin/kairos/count")),
    staleTime: 60_000,
  })
  return (
    <AdminFrame
      session={{ role: adminSession.actor.role, user: adminSession.user }}
      kairos={kairos.data?.waiting}
      support={queues.data?.support}
      complaints={complaints.data?.pending}
    >
      <Outlet />
    </AdminFrame>
  )
}

function AdminFrame({
  session,
  kairos,
  support,
  complaints,
  children,
}: {
  session: SeenSession
  kairos?: number
  support?: number
  complaints?: number
  children: ReactNode
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const queryClient = useQueryClient()
  // El ARM (ADR 0184): el cliente es el eje. La lista de espera y Organizaciones ya no van en el
  // menú: sus direcciones llevan a Clientes y a la ficha del cliente.
  const admin = session.role === "admin"
  const items: AppShellNavEntry[] = [
    { label: "Hoy", to: "/", icon: Home },
    { label: "Clientes", to: "/clients", icon: Building2 },
    { label: "Embudo", to: "/pipeline", icon: Columns3 },
    { label: "Kairós", to: "/kairos", icon: Bot, badge: kairos || undefined, badgeLabel: "esperan tu sí" },
    ...(admin ? [{ label: "Reportes", to: "/reports", icon: ChartColumn }] : []),
    { label: "Demos", to: "/demos", icon: Presentation },
    { label: "Usuarios", to: "/users", icon: Users },
    ...(admin
      ? [
          { label: "Cobros y planes", to: "/billing", icon: CreditCard },
          { label: "Comisiones", to: "/commissions", icon: Coins },
        ]
      : []),
    { label: "Soporte", to: "/support", icon: CircleHelp, badge: support || undefined },
    {
      label: "Libro de Reclamaciones",
      to: "/complaints",
      icon: BookOpen,
      badge: complaints || undefined,
    },
    ...(admin ? [{ label: "Equipo", to: "/team", icon: ShieldCheck }] : []),
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
