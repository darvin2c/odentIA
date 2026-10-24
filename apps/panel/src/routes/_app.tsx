import { AccessLinkPasswordGate, Brand, LegalGate, PersonAvatar, SideDockProvider, SideDockSlot } from "@odentia/ui-patterns"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { createFileRoute, getRouteApi, Link as RouterLink, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, CircleHelp, KeyRound, LogOut, ShieldCheck, UserRound } from "lucide-react"
import { useEffect, useState } from "react"
import { accountOrganizationsQuery } from "../lib/account-organizations"
import { adminAccessQuery } from "../lib/admin-access"
import { authClient, authFetch } from "../lib/auth-client"
import { DraftGuard } from "../lib/draft-guard"
import { requireTermsAccepted, requireVerifiedSession } from "../lib/guards"
import { adminUrl, legalLinks, tenantUrl } from "../lib/host"

export const Route = createFileRoute("/_app")({
  // `?clinica=<slug>`: se llegó desde esa clínica (Mi perfil); el panel ofrece volver a ella.
  validateSearch: (search: Record<string, unknown>): { clinica?: string } =>
    typeof search.clinica === "string" && search.clinica ? { clinica: search.clinica } : {},
  beforeLoad: async ({ location }) => {
    const session = await requireVerifiedSession()
    await requireTermsAccepted(location)
    return { session }
  },
  component: AppLayout,
})

const appRouteApi = getRouteApi("/_app")

/** La clínica desde la que se llegó (`?clinica=<slug>`), para volver a ella; se recuerda en la pestaña. */
const DESDE_KEY = "odentia.panel.desde-clinica"

function useClinicaDeOrigen(): string | null {
  const desde = appRouteApi.useSearch().clinica ?? null
  const [slug, setSlug] = useState<string | null>(desde)
  useEffect(() => {
    try {
      if (desde) window.sessionStorage.setItem(DESDE_KEY, desde)
      setSlug(desde ?? window.sessionStorage.getItem(DESDE_KEY))
    } catch {
      setSlug(desde)
    }
  }, [desde])
  return slug
}

/**
 * El panel es de la persona, no de una clínica (ADR 0065): sin barra lateral,
 * con la marca a la izquierda y el menú de la cuenta a la derecha, igual en
 * todas sus páginas. Lo que es de una clínica (Plan y pagos) vive en ella.
 */
function AppLayout() {
  const { session } = appRouteApi.useRouteContext()
  const navigate = useNavigate()
  const staff = useQuery(adminAccessQuery)
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const live = authClient.useSession().data?.user
  const user = live
    ? {
        name: live.name,
        email: live.email,
        avatarUrl: live.image ?? null,
        givenNames: live.firstName ?? "",
        familyName: live.lastName ?? "",
      }
    : {
        name: session.name,
        email: session.email,
        avatarUrl: session.image,
        givenNames: session.firstName,
        familyName: session.lastName,
      }
  const origen = useClinicaDeOrigen()
  const organizations = useQuery({ ...accountOrganizationsQuery, enabled: origen !== null })
  const clinicaOrigen = origen ? organizations.data?.find((org) => org.slug === origen) : undefined

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
  const volver = "inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Brand />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Menú de ${user.name || "usuario"}`}
            className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PersonAvatar
              name={user.name}
              givenNames={user.givenNames}
              familyName={user.familyName}
              src={user.avatarUrl}
              className="size-9"
              fallbackClassName="text-xs"
              decorative
            />
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
      {pathname !== "/" ? (
        <nav aria-label="Volver" className="px-4 sm:px-6">
          {clinicaOrigen ? (
            <a href={tenantUrl(clinicaOrigen.slug, "/home", clinicaOrigen.product)} className={volver}>
              <ChevronLeft className="size-4" aria-hidden />
              {clinicaOrigen.organizationName}
            </a>
          ) : (
            <RouterLink to="/" search={{ cambiar: 1 }} className={volver}>
              <ChevronLeft className="size-4" aria-hidden />
              Elige tu clínica
            </RouterLink>
          )}
        </nav>
      ) : null}
      {/* Columna lateral del layout: los formularios del perfil se abren ahí
          en ventana ancha, igual que en la plataforma. */}
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
    </div>
  )
}
