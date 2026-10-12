import { canAccess, canAccessAny, platformPathPermission } from "@odentia/auth/permissions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import {
  AppShell,
  Brand,
  type AppShellNavEntry,
  type AppShellNavGroup,
  type AppShellNavItem,
  HeaderUtilitiesProvider,
  LoadingState,
  SideDockProvider,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  getRouteApi,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router"
import {
  BarChart3,
  Bot,
  Building2,
  CalendarDays,
  ChevronsUpDown,
  Home,
  Inbox,
  Kanban,
  ListTodo,
  Package,
  Settings,
  Smile,
  Users,
  Wallet,
  Workflow,
} from "lucide-react"
import {
  AGENT_PANEL_EVENTS,
  AgentPanelButton,
  AgentPanelProvider,
  invalidateAgentPanelQueries,
  useAgentPanelSummary,
} from "../components/agent-panel"
import { HelpButton } from "../components/help-panel"
import { WorkspaceNotifications } from "../components/workspace-notifications"
import { invalidateAppointmentQueries } from "../lib/agenda"
import { authClient } from "../lib/auth-client"
import { requireVerifiedSession, ssrFetchOptions } from "../lib/guards"
import { orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "../lib/host"
import { useOrgEvents } from "../lib/org-events"
import { PageDraftGuard } from "../lib/page-draft-guard"
import { RouterLink } from "../lib/router-link"

export const Route = createFileRoute("/_org")({
  beforeLoad: async ({ location }) => {
    const session = await requireVerifiedSession(location)
    const slug = orgSlugFromHostname(requestHostname())
    if (!slug) {
      throw redirect({ href: panelUrl("/") })
    }
    const fetchOptions = ssrFetchOptions()
    const { data } = await authClient.organization.getFullOrganization({
      query: { organizationSlug: slug },
      fetchOptions,
    })
    if (!data) {
      const { data: orgs } = await authClient.organization.list({ fetchOptions })
      throw redirect({ href: panelUrl(orgs && orgs.length > 0 ? "/" : "/onboarding") })
    }
    const role = data.members.find((member) => member.userId === session.userId)?.role ?? "member"
    const permissions = platformPathPermission(location.pathname)
    if (permissions && !canAccessAny(role, permissions)) throw redirect({ to: "/home" })
    return { session, org: data }
  },
  component: OrgLayout,
})

type NavChild = AppShellNavItem & { permission?: string }
type NavDefinition =
  | (AppShellNavItem & { permission?: string; permissionsAny?: string[]; children?: undefined })
  | (Omit<AppShellNavGroup, "children"> & {
      permission?: string
      permissionsAny?: string[]
      children: NavChild[]
    })

const navDefinitions: NavDefinition[] = [
  { label: "Inicio", to: "/home", icon: Home },
  { label: "Bandeja", to: "/inbox", icon: Inbox, permission: "conversations.read" },
  { label: "Agenda", to: "/agenda", icon: CalendarDays, permission: "appointments.read" },
  { label: "Tareas", to: "/tasks", icon: ListTodo, permission: "tasks.read" },
  {
    label: "Personas",
    children: [
      { label: "Pacientes", to: "/patients", icon: Smile, permission: "patients.read" },
      { label: "Contactos", to: "/contacts", icon: Users, permission: "crm.read" },
      { label: "Oportunidades", to: "/pipeline", icon: Kanban, permission: "crm.read" },
    ],
  },
  // El agente es una sola entrada; sus secciones (aprobaciones, actividad,
  // conocimiento) son pestañas de página. El destino se resuelve por permiso:
  // quien solo decide entra directo a Aprobaciones.
  {
    label: "Agente",
    permissionsAny: ["agent.read", "agent.decide"],
    children: [{ label: "Agente", to: "/agent", icon: Bot }],
  },
  {
    label: "Gestión",
    children: [
      { label: "Finanzas", to: "/finance", icon: Wallet, permission: "finance.read" },
      { label: "Inventario", to: "/inventory", icon: Package, permission: "inventory.read" },
      { label: "Automatizaciones", to: "/automations", icon: Workflow, permission: "crm.read" },
      { label: "Reportes", to: "/reports", icon: BarChart3, permission: "reports.read" },
    ],
  },
]

const orgRouteApi = getRouteApi("/_org")

function OrgSwitcher() {
  const { org } = orgRouteApi.useRouteContext()
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  })

  const card = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
        <Building2 className="size-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
        <span className="truncate text-sm font-semibold">{org.name}</span>
        <span className="truncate text-xs text-muted-foreground">Organización</span>
      </span>
    </>
  )
  const cardClass =
    "elevated flex min-h-14 w-full items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2"

  if (!orgs || orgs.length <= 1) {
    return <div className={cardClass}>{card}</div>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Organización ${org.name}. Cambiar`}
        className={`${cardClass} transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring`}
      >
        {card}
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
        {orgs.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onClick={() => window.location.assign(tenantUrl(item.slug, "/home"))}
          >
            {item.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => window.location.assign(panelUrl("/"))}>
          Todas las organizaciones
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OrgLayout() {
  const { org, session } = orgRouteApi.useRouteContext()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const role = org.members.find((member) => member.userId === session?.userId)?.role ?? "member"
  const queryClient = useQueryClient()
  // Una sola suscripción SSE para el layout: agenda y panel del agente.
  useOrgEvents(["appointment.updated", ...AGENT_PANEL_EVENTS], (kind) => {
    if (kind === "appointment.updated" || kind === "stream.reconnected") {
      void invalidateAppointmentQueries(queryClient)
    }
    if (kind !== "appointment.updated") invalidateAgentPanelQueries(queryClient)
  })
  // Contador ligero para el badge del agente; la misma consulta alimenta el panel.
  const agentSummary = useAgentPanelSummary(canAccessAny(role, ["agent.read", "agent.decide"]))
  const pendingDecisions = agentSummary.data?.data.pendingProposals ?? 0
  // Filtra entradas y subentradas por permiso: el grupo IA muestra solo las
  // hijas autorizadas (Aprobaciones para quien decide, sin configuración).
  const navItems = navDefinitions.flatMap((item): AppShellNavEntry[] => {
    const selfVisible =
      (!item.permission || canAccess(role, item.permission)) &&
      (!item.permissionsAny || canAccessAny(role, item.permissionsAny))
    if (!item.children) return selfVisible ? [item] : []
    const children = item.children
      .filter((child) => !child.permission || canAccess(role, child.permission))
      .map((child) => {
        if (child.to !== "/agent") return child
        const target = canAccess(role, "agent.read") ? child : { ...child, to: "/agent/approvals" }
        return pendingDecisions > 0 ? { ...target, badge: pendingDecisions } : target
      })
    if (children.length === 0) return []
    if (!selfVisible) return []
    return [{ ...item, children }]
  })
  const footerItems = canAccess(role, "settings.read")
    ? [{ label: "Configuración", to: "/settings", icon: Settings }]
    : []

  if (!session) {
    return <LoadingState className="m-8" />
  }

  return (
    <AppShell
      items={navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{ name: session.name, email: session.email }}
      footerItems={footerItems}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={<OrgSwitcher />}
      onSignOut={async () => {
        await authClient.signOut()
        window.location.assign(panelUrl("/login"))
      }}
    >
      <SideDockProvider draftGuard={PageDraftGuard}>
        <AgentPanelProvider>
          <HeaderUtilitiesProvider
            value={
              <>
                <HelpButton />
                <WorkspaceNotifications />
                <AgentPanelButton />
              </>
            }
          >
            <Outlet />
          </HeaderUtilitiesProvider>
        </AgentPanelProvider>
      </SideDockProvider>
    </AppShell>
  )
}
