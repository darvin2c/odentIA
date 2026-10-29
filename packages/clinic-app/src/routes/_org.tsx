import { canAccess, canAccessAny, platformPathPermission, seesBilling } from "@odentia/auth/permissions"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui"
import {
  AccessLinkPasswordGate,
  type ClinicAgreementStatus,
  LegalGate,
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
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import {
  ArrowLeftRight,
  BarChart3,
  Bot,
  CalendarDays,
  ChevronsUpDown,
  CreditCard,
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
  Wallet,
} from "lucide-react"
import { useEffect } from "react"
import {
  AGENT_PANEL_EVENTS,
  AgentPanelButton,
  AgentPanelMenuItem,
  AgentPanelProvider,
  invalidateAgentPanelQueries,
  useAgentPanelSummary,
} from "../components/agent-panel"
import { GlobalSearchButton, GlobalSearchProvider, type GlobalSearchScreen } from "../components/global-search"
import { ArgosPanel } from "../components/argos/argos-panel"
import { ScheduleHost } from "../components/agenda/schedule-host"
import { HelpButton } from "../components/help-panel"
import { TwoFactorRequiredPage } from "../components/two-factor-required"
import { HeaderHelpMenuItem } from "../components/header-more-menu"
import { NoticesPanel, WorkspaceNotifications } from "../components/workspace-notifications"
import { ClinicNoticeStrip, RaiseCapProvider, useClinicNotices } from "../components/clinic-notices"
import { invalidateAppointmentQueries } from "../lib/agenda"
import { authClient, authFetch } from "../lib/auth-client"
import { requireTermsAccepted, requireVerifiedSession, type SessionInfo, ssrFetchOptions } from "../lib/guards"
import { ApiError, apiFetch } from "../lib/api"
import { adminRedirectFor, legalLinks, orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "../lib/host"
import { notifyOrgLocale, setOrgLocale } from "../lib/locale"
import { fetchOrgProfile, useOrgProfile } from "../lib/org"
import { productUi } from "../product/product-ui"
import { appRoleLabel } from "../lib/product-words"
import { useOrgEvents } from "../lib/org-events"
import { PageDraftGuard } from "../lib/page-draft-guard"
import { RouterLink } from "../lib/router-link"
import { PLAN_PATH } from "../lib/billing"

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
  country: string | undefined
  /** El producto de la clínica: si no es el de esta app, se abre en su dominio. */
  product?: string | undefined
  /** La clínica pide verificación en dos pasos (ADR 0107): activarla, o el código de esta sesión. */
  twoFactorRequired?: "activar" | "codigo"
}
let orgRegionLoaded: OrgRegion | null = null
async function loadOrgRegion(): Promise<OrgRegion> {
  if (typeof window !== "undefined" && orgRegionLoaded) return orgRegionLoaded
  try {
    const profile = await fetchOrgProfile()
    const region = {
      locale: profile?.locale?.trim() || undefined,
      timeZone: profile?.timezone?.trim() || undefined,
      country: profile?.countryCode?.trim() || undefined,
      product: profile?.product,
    }
    if (typeof window !== "undefined") {
      orgRegionLoaded = region
      setOrgLocale(region.locale, region.timeZone, region.country)
    }
    return region
  } catch (error) {
    // La API no deja operar en esta clínica sin verificación en dos pasos: se dice, no se cachea.
    if (error instanceof ApiError && (error.shape.code === "TWO_FACTOR_REQUIRED" || error.shape.code === "TWO_FACTOR_CODE_REQUIRED")) {
      const twoFactorRequired = error.shape.code === "TWO_FACTOR_REQUIRED" ? "activar" : "codigo"
      return { locale: undefined, timeZone: undefined, country: undefined, twoFactorRequired }
    }
    return { locale: undefined, timeZone: undefined, country: undefined }
  }
}

function readOrganization(slug: string, fetchOptions: ReturnType<typeof ssrFetchOptions>) {
  return authClient.organization.getFullOrganization({ query: { organizationSlug: slug }, fetchOptions })
}
type FullOrganization = NonNullable<Awaited<ReturnType<typeof readOrganization>>["data"]>
interface OrgAccess {
  slug: string
  at: number
  session: SessionInfo
  org: FullOrganization
}

/**
 * Cuánto vale en el navegador lo comprobado al entrar. `beforeLoad` corre en cada
 * navegación, también cuando solo cambia la búsqueda (el día de la Agenda, la
 * conversación abierta, un filtro): sin esto, cada clic esperaba tres viajes a la
 * API antes de cambiar la pantalla. La API autoriza cada pedido igual; esto solo
 * decide qué pantalla mostrar, y un cambio de rol o del equipo se ve a los 2 minutos.
 */
const ORG_ACCESS_FRESH_MS = 120_000
let orgAccessChecked: OrgAccess | null = null

/** Sesión verificada, términos aceptados y la clínica del host, o el redirect que toque. */
async function checkOrgAccess(location: { href: string }): Promise<{ session: SessionInfo; org: FullOrganization }> {
  const slug = orgSlugFromHostname(requestHostname())
  const cached = orgAccessChecked
  if (typeof window !== "undefined" && cached && cached.slug === slug && Date.now() - cached.at < ORG_ACCESS_FRESH_MS) {
    return cached
  }
  const fetchOptions = ssrFetchOptions()
  // Las tres a la vez; se revisan en el orden de siempre: sesión, términos y clínica.
  const sessionCheck = requireVerifiedSession(location)
  const termsCheck = requireTermsAccepted(location)
  const orgRead = slug ? readOrganization(slug, fetchOptions) : null
  // Si falla una antes, las otras no quedan como rechazo sin atender.
  termsCheck.catch(() => undefined)
  orgRead?.catch(() => undefined)
  const session = await sessionCheck
  await termsCheck
  if (!slug || !orgRead) {
    throw redirect({ href: panelUrl("/") })
  }
  const { data } = await orgRead
  if (!data) {
    const { data: orgs } = await authClient.organization.list({ fetchOptions })
    throw redirect({ href: panelUrl(orgs && orgs.length > 0 ? "/?cambiar=1" : "/onboarding") })
  }
  if (typeof window !== "undefined") orgAccessChecked = { slug, at: Date.now(), session, org: data }
  return { session, org: data }
}

export const Route = createFileRoute("/_org")({
  beforeLoad: async ({ location }) => {
    const toAdmin = adminRedirectFor(requestHostname())
    if (toAdmin) throw redirect({ href: toAdmin })
    // El formato regional se pide junto con lo demás; si falla, queda el del navegador.
    const regionLoad = loadOrgRegion()
    const { session, org: data } = await checkOrgAccess(location)
    const role = data.members.find((member) => member.userId === session.userId)?.role ?? "member"
    const permissions = platformPathPermission(location.pathname)
    if (permissions && !canAccessAny(role, permissions)) throw redirect({ to: "/home" })
    const region = await regionLoad
    // Una clínica de otro producto se abre en su dominio, con su app (decisión 9 del
    // issue 229). Sin ese dominio configurado el destino es este mismo: no se redirige.
    const elsewhere =
      region.product && region.product !== productUi().product ? tenantUrl(data.slug, location.href, region.product) : null
    if (elsewhere && new URL(elsewhere).hostname !== requestHostname()) throw redirect({ href: elsewhere })
    return { session, org: data, region }
  },
  component: OrgGate,
})

/** Sin la verificación que pide la clínica, su pantalla en vez de la aplicación. */
function OrgGate() {
  const { org, region } = orgRouteApi.useRouteContext()
  if (region.twoFactorRequired) return <TwoFactorRequiredPage org={org} need={region.twoFactorRequired} />
  return <OrgLayout />
}

/** El contrato de encargo de la clínica: lo pide la ventana a quien la administra. */
const clinicAgreement = {
  load: async () => (await apiFetch<{ data: ClinicAgreementStatus }>("/api/legal/clinic")).data,
  accept: async (version: string) => {
    await apiFetch("/api/legal/clinic/accept", { method: "POST", body: JSON.stringify({ version }) })
  },
}

/** `unlessPermission`: la entrada sobra para quien ya llega a lo mismo por otra pantalla. */
type NavChild = AppShellNavItem & { permission?: string; permissionsAny?: string[]; unlessPermission?: string }
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
      // Una sola entrada para todas las personas (ADR 0029): pacientes, por registrar y responsables.
      { label: "Pacientes", to: "/people", icon: Smile, permission: "patients.read" },
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
      // Con precios o sin ellos (recepción, ADR 0067): la misma regla que la ruta.
      { label: "Inventario", to: "/inventory", icon: Package, permissionsAny: ["inventory.read", "inventory.stock"] },
      { label: "Reportes", to: "/reports", icon: BarChart3, permission: "reports.read" },
    ],
  },
]

const orgRouteApi = getRouteApi("/_org")

function OrgSwitcher() {
  const { org, session } = orgRouteApi.useRouteContext()
  const navigate = useNavigate()
  const role = org.members.find((member) => member.userId === session.userId)?.role ?? "member"
  const billing = seesBilling(role)
  // Las clínicas de la cuenta, con su producto: cada una abre en su dominio.
  const { data: orgs } = useQuery({
    queryKey: ["account", "organizations"],
    queryFn: async () =>
      (await apiFetch<{ data: Array<{ organizationId: string; organizationName: string; slug: string; product: string }> }>(
        "/api/account/organizations",
      )).data,
  })
  // Lo de cobro que pide actuar marca el nombre de la clínica (ADR 0065).
  const notices = useClinicNotices()
  const billingNotice = billing
    ? notices.data?.find((notice) => (notice.topic === "cobro" || notice.topic === "tope") && notice.tone !== "aviso")
    : undefined
  const others = (orgs ?? []).filter((item) => item.organizationId !== org.id)
  const initial = org.name.trim().charAt(0).toUpperCase() || "C"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${org.name}${billingNotice ? `, ${billingNotice.short}` : ""}. Menú de la clínica`}
        className="elevated flex min-h-14 w-full items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative shrink-0">
          <Avatar className="size-9 rounded-[10px]">
            {org.logo ? <AvatarImage src={org.logo} alt="" className="rounded-[10px]" /> : null}
            <AvatarFallback className="rounded-[10px] bg-primary-soft font-semibold text-primary">{initial}</AvatarFallback>
          </Avatar>
          {billingNotice ? (
            <span
              aria-hidden
              className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card ${billingNotice.tone === "limite" ? "bg-destructive" : "bg-warning-strong"}`}
            />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate text-sm font-semibold">{org.name}</span>
          <span className="truncate text-xs text-muted-foreground">{appRoleLabel(role, "Miembro")}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
        {billing ? (
          <DropdownMenuItem onClick={() => void navigate({ to: PLAN_PATH })}>
            <CreditCard aria-hidden />
            <span className="flex-1">Plan y pagos</span>
            {billingNotice ? (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${billingNotice.tone === "limite" ? "bg-destructive text-destructive-foreground" : "bg-warning-strong text-warning-strong-foreground"}`}
              >
                {billingNotice.short}
              </span>
            ) : null}
          </DropdownMenuItem>
        ) : null}
        {others.length > 0 ? (
          <>
            {billing ? <DropdownMenuSeparator /> : null}
            {others.map((item) => (
              <DropdownMenuItem
                key={item.organizationId}
                onClick={() => window.location.assign(tenantUrl(item.slug, "/home", item.product))}
              >
                {item.organizationName}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {billing || others.length > 0 ? <DropdownMenuSeparator /> : null}
        {/* Vuelve al selector sin autoentrar (issue 114). */}
        <DropdownMenuItem onClick={() => window.location.assign(panelUrl("/?cambiar=1"))}>
          <ArrowLeftRight aria-hidden />
          Cambiar de clínica
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
  const activeCountry = profile.data === undefined ? region.country : profile.data?.countryCode
  setOrgLocale(activeLocale, activeTimeZone, activeCountry)
  useEffect(() => {
    notifyOrgLocale()
  }, [activeLocale, activeTimeZone, activeCountry])
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const role = org.members.find((member) => member.userId === session?.userId)?.role ?? "member"
  const queryClient = useQueryClient()
  // Una sola suscripción SSE para el layout: agenda y panel del agente.
  useOrgEvents(["appointment.updated", "saas.subscription.updated", ...AGENT_PANEL_EVENTS], (kind) => {
    if (kind === "appointment.updated" || kind === "stream.reconnected") {
      void invalidateAppointmentQueries(queryClient)
    }
    // Un pago, un tope o un acceso de soporte cambian la franja de avisos sin recargar.
    if (kind === "saas.subscription.updated" || kind === "stream.reconnected") {
      void queryClient.invalidateQueries({ queryKey: ["saas", org.id] })
      if (kind === "saas.subscription.updated") return
    }
    if (kind !== "appointment.updated") invalidateAgentPanelQueries(queryClient)
  })
  // Contador ligero para el badge del agente; la misma consulta alimenta el panel.
  const agentSummary = useAgentPanelSummary(canAccessAny(role, ["agent.read", "agent.decide"]))
  // El único contador de los casos del agente: lo que nadie tomó más lo tuyo
  // (lo cuenta el servidor para quien mira). Panel, pestañas y Resumen no lo repiten.
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
          (!child.permissionsAny || canAccessAny(role, child.permissionsAny)) &&
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

  // El buscador rápido ofrece como «Ir a» las mismas pantallas del menú de esta persona.
  const searchScreens: GlobalSearchScreen[] = [...navItems, ...footerItems].flatMap((entry) =>
    "children" in entry && entry.children
      ? entry.children.map((child) => ({ label: child.label, to: child.to }))
      : "to" in entry && entry.to
        ? [{ label: entry.label, to: entry.to }]
        : [],
  )

  if (!session) {
    return <LoadingState className="m-8" />
  }

  return (
    <RaiseCapProvider>
    <AppShell
      notice={<ClinicNoticeStrip userId={session.userId} />}
      items={navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{ name: session.name, email: session.email, avatarUrl: session.image }}
      // El perfil vive en el panel de la cuenta (otro origen): se llega con un enlace normal.
      userMenuItems={[
        // `clinica` deja en el panel el enlace para volver a esta clínica.
        { label: "Mi perfil", icon: UserRound, href: panelUrl(`/profile?clinica=${encodeURIComponent(org.slug)}`) },
        { label: "Cambiar contraseña", icon: KeyRound, href: panelUrl(`/profile?edit=password&clinica=${encodeURIComponent(org.slug)}`) },
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
        <AgentPanelProvider notices={(frame) => <NoticesPanel {...frame} />}>
          <GlobalSearchProvider orgId={org.id} screens={searchScreens}>
          <HeaderUtilitiesProvider
            value={{
              utilities: (
                <>
                  <GlobalSearchButton />
                  <HelpButton />
                  <WorkspaceNotifications />
                  <AgentPanelButton />
                </>
              ),
              menuItems: (
                <>
                  <HeaderHelpMenuItem />
                  <AgentPanelMenuItem />
                </>
              ),
            }}
          >
            <Outlet />
          </HeaderUtilitiesProvider>
          {/* Argos no tiene botón: lo abren el buscador y Reportes. Una sola vez aquí, no en la cabecera de cada
              página: la conversación sigue al navegar (D4). */}
          <ArgosPanel />
          {/* La cita y «Nueva cita» desde cualquier pantalla: Argos, listas e Inicio las abren al lado. */}
          <ScheduleHost />
          </GlobalSearchProvider>
        </AgentPanelProvider>
      </SideDockProvider>
      {/* Después de entrar con el enlace de acceso: pide la nueva contraseña. */}
      <AccessLinkPasswordGate request={authFetch} />
      {/* Términos nuevos de cada persona y, para quien administra, el contrato de encargo de la clínica. */}
      <LegalGate request={authFetch} clinic={clinicAgreement} links={legalLinks} />
    </AppShell>
    </RaiseCapProvider>
  )
}
