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
  KeyRound,
  ListTodo,
  Package,
  Percent,
  Settings,
  Smile,
  Tags,
  UserRound,
  Users,
  Wallet,
} from "lucide-react"
import { useEffect } from "react"
import {
  AGENT_PANEL_EVENTS,
  AgentPanelButton,
  AgentPanelProvider,
  invalidateAgentPanelQueries,
  useAgentPanelSummary,
} from "../components/agent-panel"
import { HelpButton } from "../components/help-panel"
import { WorkspaceNotifications } from "../components/workspace-notifications"
import { SaasStatusBanner } from "../components/saas-status-banner"
import { SupportGrantBanner } from "../components/support-grant-banner"
import { invalidateAppointmentQueries } from "../lib/agenda"
import { authClient } from "../lib/auth-client"
import { requireVerifiedSession, ssrFetchOptions } from "../lib/guards"
import { orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "../lib/host"
import { notifyOrgLocale, setOrgLocale } from "../lib/locale"
import { fetchOrgProfile, useOrgProfile } from "../lib/org"
import { useOrgEvents } from "../lib/org-events"
import { PageDraftGuard } from "../lib/page-draft-guard"
import { RouterLink } from "../lib/router-link"

/**
 * Formato regional de la clínica, conocido antes del primer render para que
 * ninguna fecha se pinte con otro formato. En el navegador se pide una vez por
 * sesión de pantalla (el host es de una sola clínica); después lo mantiene al
 * día la consulta del perfil que observa el layout. Sin perfil: `undefined`,
 * el formato del navegador.
 */
interface OrgRegion {
  locale: string | undefined
  timeZone: string | undefined
}
let orgRegionLoaded: OrgRegion | null = null
async function loadOrgRegion(): Promise<OrgRegion> {
  if (typeof window !== "undefined" && orgRegionLoaded) return orgRegionLoaded
  try {
    const profile = await fetchOrgProfile()
    const region = {
      locale: profile?.locale?.trim() || undefined,
      timeZone: profile?.timezone?.trim() || undefined,
    }
    if (typeof window !== "undefined") {
      orgRegionLoaded = region
      setOrgLocale(region.locale, region.timeZone)
    }
    return region
  } catch {
    return { locale: undefined, timeZone: undefined }
  }
}

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
    return { session, org: data, region: await loadOrgRegion() }
  },
  component: OrgLayout,
})

/** `unlessPermission`: la entrada sobra para quien ya llega a lo mismo por otra pantalla. */
type NavChild = AppShellNavItem & { permission?: string; unlessPermission?: string }
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
  // El agente es una sola entrada, junto al trabajo diario; sus secciones
  // (pendientes, aprender, conocimiento) son pestañas de página. El destino se
  // resuelve por permiso: quien solo decide entra directo a Pendientes.
  { label: "Agente", to: "/agent", icon: Bot, permissionsAny: ["agent.read", "agent.decide"] },
  {
    label: "Personas",
    children: [
      { label: "Pacientes", to: "/patients", icon: Smile, permission: "patients.read" },
      { label: "Contactos", to: "/contacts", icon: Users, permission: "crm.read" },
      { label: "Oportunidades", to: "/pipeline", icon: Kanban, permission: "crm.read" },
    ],
  },
  {
    label: "Gestión",
    children: [
      { label: "Finanzas", to: "/finance", icon: Wallet, permission: "finance.read" },
      { label: "Servicios y precios", to: "/services", icon: Tags, permission: "catalog.read" },
      // Para quien ve Finanzas, Comisiones es una pestaña de allí; la entrada queda
      // para quien solo consulta las suyas.
      { label: "Comisiones", to: "/commissions", icon: Percent, permission: "commissions.read", unlessPermission: "finance.read" },
      { label: "Inventario", to: "/inventory", icon: Package, permission: "inventory.read" },
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
  const { org, session, region } = orgRouteApi.useRouteContext()
  // El formato de la clínica queda fijado antes de pintar las pantallas hijas
  // (también en SSR e hidratación); si el perfil cambia, se avisa a quien lo usa.
  const profile = useOrgProfile()
  const activeLocale = profile.data === undefined ? region.locale : profile.data?.locale
  const activeTimeZone = profile.data === undefined ? region.timeZone : profile.data?.timezone
  setOrgLocale(activeLocale, activeTimeZone)
  useEffect(() => {
    notifyOrgLocale()
  }, [activeLocale, activeTimeZone])
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
  // Lo que espera al equipo: los casos que el agente pasó y siguen sin resolver.
  const pendingCases = agentSummary.data?.data.openHandoffs ?? 0
  // El agente lleva su contador y, para quien solo decide, entra por Pendientes.
  const withAgentState = <T extends AppShellNavItem>(item: T): T => {
    if (item.to !== "/agent") return item
    const target = canAccess(role, "agent.read") ? item : { ...item, to: "/agent/pendientes" }
    return pendingCases > 0 ? { ...target, badge: pendingCases } : target
  }
  // Filtra entradas y subentradas por permiso: cada grupo muestra solo las hijas autorizadas.
  const navItems = navDefinitions.flatMap((item): AppShellNavEntry[] => {
    const selfVisible =
      (!item.permission || canAccess(role, item.permission)) &&
      (!item.permissionsAny || canAccessAny(role, item.permissionsAny))
    if (!item.children) return selfVisible ? [withAgentState(item)] : []
    const children = item.children
      .filter(
        (child) =>
          (!child.permission || canAccess(role, child.permission)) &&
          !(child.unlessPermission && canAccess(role, child.unlessPermission)),
      )
      .map(withAgentState)
    if (children.length === 0) return []
    if (!selfVisible) return []
    return [{ ...item, children }]
  })
  // Recepción no configura la clínica, pero sí define etapas de venta y campos
  // de contacto: entra a Configuración por el primero de esos apartados.
  const footerItems = canAccess(role, "settings.read")
    ? [{ label: "Configuración", to: "/settings", icon: Settings }]
    : canAccess(role, "crm.write")
      ? [{ label: "Configuración", to: "/settings/pipelines", icon: Settings }]
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
      // El perfil vive en el panel de la cuenta (otro origen): se llega con un enlace normal.
      userMenuItems={[
        { label: "Mi perfil", icon: UserRound, href: panelUrl("/profile") },
        { label: "Cambiar contraseña", icon: KeyRound, href: panelUrl("/profile?edit=password") },
      ]}
      footerItems={footerItems}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={<OrgSwitcher />}
      onSignOut={async () => {
        await authClient.signOut()
        queryClient.clear()
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
            <SaasStatusBanner organizationId={org.id} role={role} />
            <SupportGrantBanner canRevoke={role === "owner" || role === "admin"} />
            <Outlet />
          </HeaderUtilitiesProvider>
        </AgentPanelProvider>
      </SideDockProvider>
    </AppShell>
  )
}
