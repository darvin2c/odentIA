import { canAccess, canAccessAny, platformPathPermission } from "@odentia/auth/permissions"
import {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import {
  AppShell,
  type AppShellNavEntry,
  HeaderUtilitiesProvider,
  LoadingState,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
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
  CalendarDays,
  ChevronDown,
  Contact,
  Home,
  Inbox,
  Kanban,
  ListTodo,
  Settings,
  Smile,
  Package,
  Wallet,
  Users,
  Workflow,
} from "lucide-react"
import { WorkspaceNotifications } from "../components/workspace-notifications"
import { authClient } from "../lib/auth-client"
import { requireVerifiedSession, ssrFetchOptions } from "../lib/guards"
import { orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "../lib/host"
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
    const role = data.members.find(member => member.userId === session.userId)?.role ?? "member"
    const permissions = platformPathPermission(location.pathname)
    if (permissions && !canAccessAny(role, permissions)) throw redirect({ to: "/home" })
    return { session, org: data }
  },
  component: OrgLayout,
})

const navDefinitions: Array<AppShellNavEntry & { permission?: string }> = [
  { label: "Inicio", to: "/home", icon: Home },
  { label: "Agenda", to: "/agenda", icon: CalendarDays, permission: "appointments.read" },
  { label: "Accesos de pacientes", to: "/patient-access", icon: Users, permission: "patients.write" },
  { label: "Bandeja", to: "/inbox", icon: Inbox, permission: "conversations.read" },
  { label: "Pacientes", to: "/patients", icon: Smile, permission: "patients.read" },
  { label: "CRM", icon: Contact, children: [
    { label: "Contactos", to: "/contacts", icon: Contact },
    { label: "Oportunidades", to: "/pipeline", icon: Kanban },
  ], permission: "crm.read" },
  { label: "Tareas", to: "/tasks", icon: ListTodo, permission: "tasks.read" },
  { label: "Finanzas", to: "/finance", icon: Wallet, permission: "finance.read" },
  { label: "Inventario", to: "/inventory", icon: Package, permission: "inventory.read" },
  { label: "Automatizaciones", to: "/automations", icon: Workflow, permission: "crm.read" },
  { label: "IA", icon: Bot, permission: "agent.read", children: [
    { label: "Supervisión", to: "/agent", icon: Bot },
    { label: "Conocimiento", to: "/agent/knowledge", icon: ListTodo },
    { label: "Aprobaciones", to: "/agent/approvals", icon: Inbox },
  ] },
  { label: "Reportes", to: "/reports", icon: BarChart3, permission: "reports.read" },
]

const orgRouteApi = getRouteApi("/_org")

function OrgSwitcher() {
  const { org } = orgRouteApi.useRouteContext()
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  })

  const chip = (
    <>
      <Avatar className="size-5">
        <AvatarFallback>{org.name.trim().charAt(0).toUpperCase() || "O"}</AvatarFallback>
      </Avatar>
      <span className="max-w-40 truncate hidden md:inline">{org.name}</span>
    </>
  )

  if (!orgs || orgs.length <= 1) {
    return (
      <span className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-sm font-medium">
        {chip}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-sm font-medium hover:bg-muted/70">
        {chip}
        <ChevronDown className="size-3.5 text-muted-foreground hidden md:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
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
  const role = org.members.find(member => member.userId === session?.userId)?.role ?? "member"
  const navItems = navDefinitions.filter(item => !item.permission || canAccess(role, item.permission))
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
      brand={<span className="text-base font-semibold">odentIA</span>}
      brandIcon={
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          o
        </span>
      }
      onSignOut={async () => {
        await authClient.signOut()
        window.location.assign(panelUrl("/login"))
      }}
    >
      <HeaderUtilitiesProvider
        value={
          <>
            <WorkspaceNotifications />
            <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border" />
            <OrgSwitcher />
          </>
        }
      >
        <Outlet />
      </HeaderUtilitiesProvider>
    </AppShell>
  )
}
