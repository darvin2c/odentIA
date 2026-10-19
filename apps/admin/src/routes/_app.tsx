import {
  AppShell,
  type AppShellNavEntry,
  Brand,
  type ShellLinkComponent,
  SideDockProvider,
  SideDockSlot,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, Outlet, useRouterState } from "@tanstack/react-router"
import {
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
import { api } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { panelUrl } from "../lib/host"
import { requireAdminSession } from "../lib/session"

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ adminSession: await requireAdminSession() }),
  component: AdminLayout,
})

const RouterLink: ShellLinkComponent = ({ to, search, ...props }) => (
  <Link to={to} search={search} {...props} />
)
const appRoute = getRouteApi("/_app")

function AdminLayout() {
  const { adminSession } = appRoute.useRouteContext()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const queryClient = useQueryClient()
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
  const items: AppShellNavEntry[] = [
    { label: "Inicio", to: "/", icon: Home },
    { label: "Lista de espera", to: "/waitlist", icon: ListChecks, badge: waitlist.data || undefined },
    { label: "Organizaciones", to: "/organizations", icon: Building2 },
    { label: "Usuarios", to: "/users", icon: Users },
    ...(adminSession.actor.role === "admin"
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
      badge: complaints.data?.pending || undefined,
    },
    ...(adminSession.actor.role === "admin"
      ? [{ label: "Equipo y actividad", to: "/team", icon: ShieldCheck }]
      : []),
  ]
  return (
    <AppShell
      items={items}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{
        name: adminSession.user.name,
        email: adminSession.user.email,
        avatarUrl: adminSession.user.image ?? undefined,
      }}
      userMenuItems={[
        { label: "Mi cuenta", icon: UserRound, href: panelUrl("/profile") },
        { label: "Seguridad de acceso", icon: ShieldCheck, to: "/security" },
      ]}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={
        <div className="px-2 py-1">
          <p className="text-sm font-semibold">Administración</p>
          <p className="text-xs text-muted-foreground">
            {adminSession.actor.role === "admin" ? "Personal administrador" : "Personal de soporte"}
          </p>
        </div>
      }
      sidebarFooter={
        <a
          href={panelUrl()}
          className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Mis organizaciones
        </a>
      }
      onSignOut={async () => {
        await authClient.signOut()
        queryClient.clear()
        window.location.assign(panelUrl("/login"))
      }}
    >
      <SideDockProvider draftGuard={DraftGuard}>
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
          <SideDockSlot />
        </div>
      </SideDockProvider>
    </AppShell>
  )
}
