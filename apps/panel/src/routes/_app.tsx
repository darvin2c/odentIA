import {
  AccessLinkPasswordGate,
  AppShell,
  type AppShellNavEntry,
  Brand,
  SideDockProvider,
  SideDockSlot,
} from "@odentia/ui-patterns"
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
import { adminUrl } from "../lib/host"
import { Building2, CircleHelp, KeyRound, ShieldCheck, UserRound } from "lucide-react"
import { authClient, authFetch } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { requireVerifiedSession } from "../lib/guards"

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ session: await requireVerifiedSession() }),
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
    </AppShell>
  )
}
