import {
  AccessLinkPasswordGate,
  LegalGate,
  AppShell,
  type AppShellNavEntry,
  Brand,
  SideDockProvider,
  SideDockSlot,
} from "@odentia/ui-patterns"
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
  createFileRoute,
  getRouteApi,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { adminAccessQuery } from "../lib/admin-access"
import { adminUrl, legalLinks } from "../lib/host"
import { Building2, CircleHelp, KeyRound, LogOut, ShieldCheck, UserRound } from "lucide-react"
import { authClient, authFetch } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { requireTermsAccepted, requireVerifiedSession } from "../lib/guards"

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = await requireVerifiedSession()
    await requireTermsAccepted(location)
    return { session }
  },
  component: AppLayout,
})

const navItems: AppShellNavEntry[] = [
  { label: "Organizaciones", to: "/", icon: Building2 },
  { label: "Soporte", to: "/support", icon: CircleHelp },
]

function RouterLink({
  to,
  search,
  className,
  children,
  title,
  onClick,
  ...rest
}: {
  to: string
  search?: Record<string, string>
  className?: string
  children: React.ReactNode
  title?: string
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
}) {
  return (
    <Link to={to} search={search} className={className} title={title} onClick={onClick} {...rest}>
      {children}
    </Link>
  )
}

const appRouteApi = getRouteApi("/_app")

function AppLayout() {
  const { session } = appRouteApi.useRouteContext()
  const navigate = useNavigate()
  const staff = useQuery(adminAccessQuery)
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const live = authClient.useSession().data?.user
  const user = live
    ? { name: live.name, email: live.email, avatarUrl: live.image ?? undefined }
    : { name: session.name, email: session.email }

  // El selector de clínica (issue 114) va sin barra lateral: marca arriba y
  // menú de cuenta a la derecha (perfil, contraseña, soporte, administración).
  if (pathname === "/") {
    const initial = user.name?.trim().charAt(0).toUpperCase() || "U"
    const signOut = async () => {
      await authClient.signOut()
      queryClient.clear()
      await navigate({ to: "/login" })
    }
    const accountMenu: Array<{ label: string; icon: React.ComponentType<{ className?: string }>; to: string; search?: Record<string, string> }> = [
      { label: "Mi perfil", icon: UserRound, to: "/profile" },
      { label: "Cambiar contraseña", icon: KeyRound, to: "/profile", search: { edit: "password" } },
      { label: "Soporte", icon: CircleHelp, to: "/support" },
    ]
    return (
      <div className="flex min-h-svh flex-col bg-background">
        <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Brand />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Menú de ${user.name || "usuario"}`}
              className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar className="size-9">
                {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                <AvatarFallback className="bg-foreground font-semibold text-background">{initial}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium">{user.name}</p>
                {user.email ? <p className="truncate text-xs text-muted-foreground">{user.email}</p> : null}
              </div>
              <DropdownMenuSeparator />
              {accountMenu.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  render={(menuProps) => {
                    const { onClick, ...rest } = menuProps
                    return (
                      <RouterLink to={item.to} search={item.search} {...rest} onClick={onClick}>
                        {menuProps.children}
                      </RouterLink>
                    )
                  }}
                >
                  <item.icon />
                  {item.label}
                </DropdownMenuItem>
              ))}
              {staff.data?.staff ? (
                <DropdownMenuItem
                  render={(menuProps) => {
                    const { onClick, ...rest } = menuProps
                    return (
                      <a href={adminUrl()} {...rest} onClick={onClick}>
                        {menuProps.children}
                      </a>
                    )
                  }}
                >
                  <ShieldCheck />
                  Administración de odentIA
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut}>
                <LogOut />
                Cerrar sesión
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <SideDockProvider draftGuard={DraftGuard}>
          <Outlet />
        </SideDockProvider>
        {/* Después de entrar con el enlace de acceso: pide la nueva contraseña. */}
        <AccessLinkPasswordGate request={authFetch} />
        {/* Términos nuevos: los acepta cada persona al entrar. */}
        <LegalGate request={authFetch} links={legalLinks} />
      </div>
    )
  }

  return (
    <AppShell
      items={staff.data?.staff ? [...navItems, { label: "Administración de odentIA", to: adminUrl(), icon: ShieldCheck, external: true }] : navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={user}
      userMenuItems={[
        { label: "Mi perfil", icon: UserRound, to: "/profile" },
        {
          label: "Cambiar contraseña",
          icon: KeyRound,
          to: "/profile",
          search: { edit: "password" },
        },
      ]}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      onSignOut={async () => {
        await authClient.signOut()
        queryClient.clear()
        await navigate({ to: "/login" })
      }}
    >
      {/* Columna lateral del layout: los formularios del perfil se abren ahí
          en ventana ancha, igual que en el platform. */}
      <SideDockProvider draftGuard={DraftGuard}>
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
          <SideDockSlot />
        </div>
      </SideDockProvider>
      {/* Después de entrar con el enlace de acceso: pide la nueva contraseña. */}
      <AccessLinkPasswordGate request={authFetch} />
      {/* Términos nuevos: los acepta cada persona al entrar. */}
      <LegalGate request={authFetch} links={legalLinks} />
    </AppShell>
  )
}
