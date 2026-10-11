import { AppShell, type AppShellNavEntry, Brand } from "@odentia/ui-patterns"
import {
  createFileRoute,
  getRouteApi,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { Building2, KeyRound, UserRound } from "lucide-react"
import { authClient } from "../lib/auth-client"
import { requireVerifiedSession } from "../lib/guards"

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ session: await requireVerifiedSession() }),
  component: AppLayout,
})

const navItems: AppShellNavEntry[] = [{ label: "Organizaciones", to: "/", icon: Building2 }]

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
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const live = authClient.useSession().data?.user
  const user = live
    ? { name: live.name, email: live.email, avatarUrl: live.image ?? undefined }
    : { name: session.name, email: session.email }

  return (
    <AppShell
      items={navItems}
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
        await navigate({ to: "/login" })
      }}
    >
      <Outlet />
    </AppShell>
  )
}
