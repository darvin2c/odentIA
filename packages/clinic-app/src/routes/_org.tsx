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
  NoticeStrip,
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
  PackageCheck,
  Percent,
  Settings,
  Smile,
  Tags,
  UserRound,
  Wallet,
} from "lucide-react"
import { useEffect, useLayoutEffect } from "react"
import { NoticesColumnProvider } from "../components/notices-column"
import { noAccessSection } from "../lib/no-access"
import { AGENT_WORK_EVENTS, invalidateAgentWork, useAgentSummary } from "../lib/agent-work"
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
import { type FullOrganization, type OrgRegion, orgChecks, readOrganization, rememberServerChecks } from "../lib/org-access"
import { endSupportSession, loadSupportSession, type SupportMode } from "../lib/support-mode"
import { productUi } from "../product/product-ui"
import { appRoleLabel } from "../lib/product-words"
import { isReceiptOnly, useOrgEvents } from "../lib/org-events"
import { forgetDevicePushOnSignOut, registerAppWorker, syncThemeColor } from "../lib/pwa"
import { setActiveBranchOwner } from "../lib/active-branch"
import { CANVAS_DARK, CANVAS_LIGHT } from "../lib/web-manifest"
import { NavigationProgress } from "../components/navigation-progress"
import { PageDraftGuard } from "../lib/page-draft-guard"
import { RouterLink } from "../lib/router-link"
import { PLAN_PATH } from "../lib/billing"

/**
 * En el navegador el formato regional se pide una vez por sesión de pantalla
 * (el host es de una sola clínica); después lo mantiene al día la consulta del
 * perfil que observa el layout.
 */
async function loadOrgRegion(): Promise<OrgRegion> {
  if (typeof window !== "undefined" && orgChecks.region) return orgChecks.region
  try {
    const profile = await fetchOrgProfile()
    const region = {
      locale: profile?.locale?.trim() || undefined,
      timeZone: profile?.timezone?.trim() || undefined,
      country: profile?.countryCode?.trim() || undefined,
      product: profile?.product,
    }
    if (typeof window !== "undefined") {
      orgChecks.region = region
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

/**
 * Cuánto vale en el navegador lo comprobado al entrar. `beforeLoad` corre en cada
 * navegación, también cuando solo cambia la búsqueda (el día de la Agenda, la
 * conversación abierta, un filtro): sin esto, cada clic esperaba tres viajes a la
 * API antes de cambiar la pantalla. La API autoriza cada pedido igual; esto solo
 * decide qué pantalla mostrar, y un cambio de rol o del equipo se ve a los 2 minutos.
 */
const ORG_ACCESS_FRESH_MS = 120_000

/** Sesión verificada, términos aceptados y la clínica del host, o el redirect que toque. */
async function checkOrgAccess(
  location: { href: string },
): Promise<{ session: SessionInfo; org: FullOrganization; support: SupportMode | null }> {
  const slug = orgSlugFromHostname(requestHostname())
  const cached = orgChecks.access
  if (typeof window !== "undefined" && cached && cached.slug === slug && Date.now() - cached.at < ORG_ACCESS_FRESH_MS) {
    return cached
  }
  const fetchOptions = ssrFetchOptions()
  // Soporte de odentIA con el permiso de la clínica: entra sin sesión de la clínica, en solo
  // lectura. En el servidor solo se pregunta si llega su cookie; en el navegador (la cookie no
  // se lee) se pregunta a la vez que lo demás, sin sumar un viaje.
  const ssrCookie = (fetchOptions as { headers?: { cookie?: string } }).headers?.cookie
  const mayBeSupport = typeof window !== "undefined" || (ssrCookie?.includes("odentia_soporte=") ?? false)
  const supportCheck = slug && mayBeSupport ? loadSupportSession(slug, fetchOptions) : Promise.resolve(null)
  // Las tres a la vez; se revisan en el orden de siempre: sesión, términos y clínica.
  const sessionCheck = requireVerifiedSession(location)
  const termsCheck = requireTermsAccepted(location)
  const orgRead = slug ? readOrganization(slug, fetchOptions) : null
  const support = await supportCheck
  if (support) {
    // Lo de la sesión de la clínica no aplica: sus rechazos no quedan sin atender.
    sessionCheck.catch(() => undefined)
    termsCheck.catch(() => undefined)
    orgRead?.catch(() => undefined)
    if (typeof window !== "undefined") orgChecks.access = { slug: support.org.slug, at: Date.now(), ...support }
    return support
  }
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
  if (typeof window !== "undefined") orgChecks.access = { slug, at: Date.now(), session, org: data, support: null }
  return { session, org: data, support: null }
}

export const Route = createFileRoute("/_org")({
  beforeLoad: async ({ location }) => {
    const toAdmin = adminRedirectFor(requestHostname())
    if (toAdmin) throw redirect({ href: toAdmin })
    // El formato regional se pide junto con lo demás; si falla, queda el del navegador.
    const regionLoad = loadOrgRegion()
    const { session, org: data, support } = await checkOrgAccess(location)
    const role = data.members.find((member) => member.userId === session.userId)?.role ?? "member"
    // La sede recordada es de esta persona: en un mostrador compartido no se hereda.
    if (typeof window !== "undefined") setActiveBranchOwner(session.userId)
    const permissions = platformPathPermission(location.pathname)
    // A Inicio, diciendo por qué: sin el aviso parecía un error de la app.
    if (permissions && !canAccessAny(role, permissions))
      throw redirect({ to: "/home", search: { sinAcceso: noAccessSection(location.pathname) } })
    const region = await regionLoad
    // Una clínica de otro producto se abre en su dominio, con su app (decisión 9 del
    // issue 229). Sin ese dominio configurado el destino es este mismo: no se redirige.
    const elsewhere =
      region.product && region.product !== productUi().product ? tenantUrl(data.slug, location.href, region.product) : null
    if (elsewhere && new URL(elsewhere).hostname !== requestHostname()) throw redirect({ href: elsewhere })
    return { session, org: data, region, checkedAt: Date.now(), support }
  },
  // Instalable solo con sesión: el portal, el registro y el chat del paciente comparten este origen.
  head: () => ({
    links: [{ rel: "manifest", href: "/app.webmanifest" }],
    // Las barras del teléfono del color del fondo desde el primer pintado; después las sigue `syncThemeColor`.
    meta: [
      { name: "theme-color", content: CANVAS_LIGHT, media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: CANVAS_DARK, media: "(prefers-color-scheme: dark)" },
    ],
  }),
  component: OrgGate,
})

/** Sin la verificación que pide la clínica, su pantalla en vez de la aplicación. */
function OrgGate() {
  const { org, region, session, checkedAt, support } = orgRouteApi.useRouteContext()
  rememberServerChecks({ org, region, session, checkedAt, support })
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
/**
 * `shown`: la entrada es de una parte del producto (`productUi()`), que se pregunta al
 * dibujar el menú: al cargar este módulo la app todavía no declaró su producto.
 */
type NavDefinition =
  | (AppShellNavItem & { permission?: string; permissionsAny?: string[]; shown?: () => boolean; children?: undefined })
  | (Omit<AppShellNavGroup, "children"> & {
      permission?: string
      permissionsAny?: string[]
      children: NavChild[]
    })

/** Lo que cambia cuántas personas esperan sin pasar por el agente: alguien escribe o se le responde. */
const WAITING_EVENTS = ["message.created", "message.updated", "conversation.updated"]

const navDefinitions: NavDefinition[] = [
  { label: "Inicio", to: "/home", icon: Home },
  { label: "Bandeja", to: "/inbox", icon: Inbox, permission: "conversations.read" },
  { label: "Agenda", to: "/agenda", icon: CalendarDays, permission: "appointments.read" },
  // Solo donde el producto vende con pedido al taller o al laboratorio (vistIA, ADR 0171).
  { label: "Pedidos", to: "/orders", icon: PackageCheck, permission: "orders.read", shown: () => Boolean(productUi().orders) },
  { label: "Tareas", to: "/tasks", icon: ListTodo, permission: "tasks.read" },
  // El agente es una sola entrada, junto al trabajo diario; sus secciones
  // (resumen, aprender, conocimiento) son pestañas de página. Es de quien lo
  // supervisa: quien solo decide (recepción) atiende lo del agente en la
  // Bandeja y en el panel del botón «Agente» de la cabecera.
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
      // para quien solo consulta las suyas, que para el profesional son sus honorarios.
      { label: "Mis honorarios", to: "/commissions", icon: Percent, permission: "commissions.read", unlessPermission: "finance.read" },
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

/**
 * Soporte de odentIA mirando la clínica: una franja que no se cierra, de otro
 * color que los avisos de la clínica, con hasta cuándo y «Salir».
 */
function SupportStrip({ support }: { support: SupportMode }) {
  const untilFull = new Date(support.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const until = untilFull.replace(/\.$/, "")
  return (
    <NoticeStrip
      label="Soporte de odentIA"
      notices={[
        {
          id: "soporte-mirando",
          tone: "alarma",
          message: `Solo mirar · Estás viendo la clínica como ${support.viewRoleLabel}, como soporte de odentIA, hasta las ${until}. No puedes cambiar nada.`,
          short: `Solo mirar · ${support.viewRoleLabel} · hasta ${untilFull}`,
          action: {
            label: "Salir",
            onSelect: () => {
              void endSupportSession()
                .catch(() => undefined)
                .finally(() => window.location.replace("/soporte?terminado=1"))
            },
          },
        },
      ]}
    />
  )
}

function OrgLayout() {
  const { org, session, region, support } = orgRouteApi.useRouteContext()
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
  const navigate = useNavigate()
  // La app en este equipo: tocar un aviso con la app abierta navega aquí, sin recargar.
  useEffect(() => registerAppWorker((href) => void navigate({ href })), [navigate])
  useEffect(() => syncThemeColor(), [])
  // Al cargar la página entera, `beforeLoad` corre en el servidor: aquí la sede recordada pasa a
  // ser de esta persona antes de que la pantalla la use (con «useLayoutEffect», sin parpadeo).
  useLayoutEffect(() => setActiveBranchOwner(session.userId), [session.userId])
  // Una sola suscripción SSE para el layout: agenda, trabajo del agente y el número de «Inicio».
  useOrgEvents(["appointment.updated", "saas.subscription.updated", ...AGENT_WORK_EVENTS, ...WAITING_EVENTS], (kind, data) => {
    if (WAITING_EVENTS.includes(kind)) {
      if (!isReceiptOnly(kind, data)) void queryClient.invalidateQueries({ queryKey: ["workspace-waiting"] })
      return
    }
    if (kind === "appointment.updated" || kind === "stream.reconnected") {
      void invalidateAppointmentQueries(queryClient)
    }
    // Un pago, un tope o un acceso de soporte cambian la franja de avisos sin recargar.
    if (kind === "saas.subscription.updated" || kind === "stream.reconnected") {
      void queryClient.invalidateQueries({ queryKey: ["saas", org.id] })
      if (kind === "saas.subscription.updated") return
    }
    if (kind !== "appointment.updated") invalidateAgentWork(queryClient)
  })
  // Cada número donde se resuelve (ADR 0118 y 0125): «Inicio» cuenta las personas que te esperan
  // (lo cuenta el servidor para quien mira) y «Agente» lo que se resuelve dentro de él.
  const waiting = useQuery({
    queryKey: ["workspace-waiting"],
    queryFn: () => apiFetch<{ data: { people: number } }>("/api/workspace/waiting"),
    refetchInterval: 60_000,
  })
  const waitingPeople = waiting.data?.data.people ?? 0
  // Lo que cuenta: personas con algo por responder (casos y conversaciones), no la sala de espera.
  const waitingLabel = waitingPeople === 1 ? "persona por responder" : "personas por responder"
  const toResolve = useAgentSummary(canAccess(role, "agent.read")).data?.data.toResolve ?? 0
  const withNavState = <T extends AppShellNavItem>(item: T): T => {
    if (item.to === "/home") return waitingPeople > 0 ? { ...item, badge: waitingPeople, badgeLabel: waitingLabel } : item
    if (item.to !== "/agent") return item
    // Quien solo decide por el agente entra a su Actividad.
    if (!canAccess(role, "agent.read")) return { ...item, to: "/agent/actividad" }
    return toResolve > 0 ? { ...item, badge: toResolve } : item
  }
  // Filtra entradas y subentradas por permiso: cada grupo muestra solo las hijas autorizadas.
  const navItems = navDefinitions.flatMap((item): AppShellNavEntry[] => {
    const selfVisible =
      (!item.permission || canAccess(role, item.permission)) &&
      (!item.permissionsAny || canAccessAny(role, item.permissionsAny)) &&
      (item.children || !item.shown || item.shown())
    if (!item.children) return selfVisible ? [withNavState(item)] : []
    const children = item.children
      .filter(
        (child) =>
          (!child.permission || canAccess(role, child.permission)) &&
          (!child.permissionsAny || canAccessAny(role, child.permissionsAny)) &&
          !(child.unlessPermission && canAccess(role, child.unlessPermission)),
      )
      .map(withNavState)
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
      notice={support ? <SupportStrip support={support} /> : <ClinicNoticeStrip userId={session.userId} />}
      items={navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={
        support
          ? { name: session.name, email: "Soporte de odentIA", avatarUrl: null }
          : { name: session.name, email: session.email, avatarUrl: session.image }
      }
      // El perfil vive en el panel de la cuenta (otro origen): se llega con un enlace normal.
      userMenuItems={
        support
          ? []
          : [
              // `clinica` deja en el panel el enlace para volver a esta clínica.
              { label: "Mi perfil", icon: UserRound, href: panelUrl(`/profile?clinica=${encodeURIComponent(org.slug)}`) },
              { label: "Cambiar contraseña", icon: KeyRound, href: panelUrl(`/profile?edit=password&clinica=${encodeURIComponent(org.slug)}`) },
            ]
      }
      footerItems={footerItems}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={support ? undefined : <OrgSwitcher />}
      onSignOut={async () => {
        if (support) {
          await endSupportSession().catch(() => undefined)
          queryClient.clear()
          window.location.replace("/soporte?terminado=1")
          return
        }
        // Este equipo deja de recibir los avisos de quien sale.
        await forgetDevicePushOnSignOut()
        await authClient.signOut()
        queryClient.clear()
        window.location.assign(panelUrl("/login"))
      }}
    >
      <NavigationProgress />
      <SideDockProvider draftGuard={PageDraftGuard}>
        <NoticesColumnProvider notices={(frame) => <NoticesPanel {...frame} />}>
          <GlobalSearchProvider orgId={org.id} screens={searchScreens}>
          <HeaderUtilitiesProvider
            value={{
              utilities: (
                <>
                  <GlobalSearchButton />
                  <HelpButton />
                  <WorkspaceNotifications />
                </>
              ),
              menuItems: <HeaderHelpMenuItem />,
              attention: waitingPeople > 0 ? { count: waitingPeople, label: waitingLabel } : undefined,
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
        </NoticesColumnProvider>
      </SideDockProvider>
      {/* Soporte no tiene cuenta en la clínica: ni contraseña nueva ni términos que aceptar. */}
      {support ? null : (
        <>
          {/* Después de entrar con el enlace de acceso: pide la nueva contraseña. */}
          <AccessLinkPasswordGate request={authFetch} />
          {/* Términos nuevos de cada persona y, para quien administra, el contrato de encargo de la clínica. */}
          <LegalGate request={authFetch} clinic={clinicAgreement} links={legalLinks} />
        </>
      )}
    </AppShell>
    </RaiseCapProvider>
  )
}
