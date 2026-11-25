import { Button, toast } from "@odentia/ui"
import {
  type AccountProfileEdit,
  AccountProfilePage,
  authFormMessage,
  ConfirmDialog,
  ErrorState,
  isAccountProfileEdit,
  SkeletonRegion,
  submitErrorMessage,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { ClinicsSkeleton, ProfilePageSkeleton } from "../../components/skeletons/profile"
import { PanelAccount } from "../../lib/account"
import { apiFetch } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { panelWords } from "../../lib/brand"
import { tenantUrl } from "../../lib/host"
import { safeNext } from "../../lib/safe-next"

export const Route = createFileRoute("/_app/profile")({
  // `next`: la clínica que pidió la verificación en dos pasos, para volver al activarla.
  validateSearch: (
    search: Record<string, unknown>,
  ): { edit?: AccountProfileEdit; next?: string } => ({
    ...(isAccountProfileEdit(search.edit) ? { edit: search.edit } : {}),
    ...(typeof search.next === "string" ? { next: search.next } : {}),
  }),
  pendingComponent: ProfilePageSkeleton,
  component: ProfilePage,
})

const appRouteApi = getRouteApi("/_app")

/** Lo que no sea de un campo, dicho para una acción suelta: sin red, que no hubo conexión. */
function actionErrorMessage(error: unknown): string {
  return authFormMessage(error) ?? submitErrorMessage(error)
}

/**
 * Mi perfil: la pantalla común de la cuenta (ADR 0216) con lo propio del panel, sus clínicas y
 * sus invitaciones.
 */
function ProfilePage() {
  const { session } = appRouteApi.useRouteContext()
  const { edit, next } = useSearch({ from: "/_app/profile" })
  const navigate = useNavigate()
  const closeDrawer = () => void navigate({ to: "/profile", search: {}, replace: true })
  return (
    <PanelAccount>
      <AccountProfilePage
        edit={edit}
        onCloseEdit={closeDrawer}
        onTwoFactorActivated={() => {
          // Activada desde la clínica que la pide: de vuelta a ella.
          const back = safeNext(next)
          if (back) window.location.assign(back)
          else closeDrawer()
        }}
        fallbackUser={{
          name: session.name,
          firstName: session.firstName,
          lastName: session.lastName,
          email: session.email,
          image: session.image,
        }}
        profileDescription={`Tu información personal en ${panelWords.name}.`}
        close={{
          description:
            "Sales de tus clínicas y se bloquea tu acceso. Tu trabajo previo conserva tu autoría. Si eres la única propietaria de alguna clínica, nombra antes a otra persona.",
          confirm: "Perderás el acceso a tus clínicas. Esta acción bloquea tu cuenta de inmediato.",
          onClosed: async () => {
            // La cuenta ya está cerrada: a la entrada aunque cerrar la sesión falle por la red.
            await authClient.signOut().catch(() => undefined)
            await navigate({ to: "/login" })
          },
        }}
      >
        <MyClinicsCard />
        <MyInvitationsCard />
      </AccountProfilePage>
    </PanelAccount>
  )
}

const accountOrgsSchema = z.object({
  data: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      slug: z.string(),
      role: z.string(),
      roleLabel: z.string(),
      canLeave: z.boolean(),
      product: z.string(),
      provisioning: z.object({ hasProfile: z.boolean(), hasBranch: z.boolean() }),
    }),
  ),
})

const accountInvitesSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      slug: z.string(),
      roleLabel: z.string(),
    }),
  ),
})

function MyClinicsCard() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [leaveTarget, setLeaveTarget] = useState<{ id: string; name: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const orgsQuery = useQuery({
    queryKey: ["account-organizations"],
    queryFn: async () =>
      accountOrgsSchema.parse(await apiFetch<unknown>("/api/account/organizations")),
  })

  async function handleLeave() {
    if (!leaveTarget) return
    setLeaving(true)
    setLeaveError(null)
    try {
      await apiFetch(
        "/api/account/organizations/" + encodeURIComponent(leaveTarget.id) + "/leave",
        {
          method: "POST",
        },
      )
      await queryClient.invalidateQueries({ queryKey: ["account-organizations"] })
      toast.success("Saliste de la clínica")
      setLeaveTarget(null)
    } catch (error) {
      // Única propietaria (409), sin permiso (403)…: dentro del diálogo, no detrás.
      setLeaveError(actionErrorMessage(error))
    } finally {
      setLeaving(false)
    }
  }

  const orgs = orgsQuery.data?.data ?? []
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Mis clínicas</div>
        <p className="text-sm text-muted-foreground">
          Clínicas a las que perteneces y tu rol en cada una.
        </p>
      </div>
      {orgsQuery.isPending ? (
        <SkeletonRegion message="Cargando tus clínicas…">
          <ClinicsSkeleton />
        </SkeletonRegion>
      ) : orgsQuery.isError ? (
        <ErrorState
          error={orgsQuery.error}
          onRetry={() => {
            void orgsQuery.refetch()
          }}
        />
      ) : orgs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aún no perteneces a ninguna clínica.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orgs.map((org) => {
            const incomplete = !org.provisioning.hasProfile || !org.provisioning.hasBranch
            const canFinish = (org.role === "owner" || org.role === "admin") && incomplete
            return (
              <li
                key={org.organizationId}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{org.organizationName}</p>
                  <p className="text-xs text-muted-foreground">
                    {org.roleLabel}
                    {incomplete ? " · Alta incompleta" : ""}
                  </p>
                </div>
                <span className="ml-auto flex gap-2">
                  {canFinish ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        void navigate({
                          to: "/onboarding",
                          search: { continue: org.organizationId },
                        })
                      }
                    >
                      Terminar alta
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        window.location.assign(tenantUrl(org.slug, "/home", org.product))
                      }
                    >
                      Abrir
                    </Button>
                  )}
                  {org.canLeave ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLeaveTarget({ id: org.organizationId, name: org.organizationName })
                      }
                    >
                      Salir
                    </Button>
                  ) : org.role === "owner" ? (
                    <span className="self-center text-xs text-muted-foreground">
                      Única propietaria
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDialog
        open={leaveTarget !== null}
        title="Salir de la clínica"
        description={`Dejarás de tener acceso a ${leaveTarget?.name ?? ""}. Podrán volverte a invitar.`}
        confirmLabel="Salir"
        variant="destructive"
        pending={leaving}
        error={leaveError}
        onConfirm={() => void handleLeave()}
        onClose={() => {
          setLeaveTarget(null)
          setLeaveError(null)
        }}
      />
    </div>
  )
}

function MyInvitationsCard() {
  const navigate = useNavigate()
  const invitesQuery = useQuery({
    queryKey: ["account-invitations"],
    queryFn: async () =>
      accountInvitesSchema.parse(await apiFetch<unknown>("/api/account/invitations/pending")),
  })
  const invites = invitesQuery.data?.data ?? []
  if (invitesQuery.isPending || invitesQuery.isError || invites.length === 0) return null
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Invitaciones pendientes</div>
        <p className="text-sm text-muted-foreground">Clínicas que te invitaron y aún no aceptas.</p>
      </div>
      <ul className="flex flex-col gap-3">
        {invites.map((invite) => (
          <li key={invite.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{invite.organizationName}</p>
              <p className="text-xs text-muted-foreground">{invite.roleLabel}</p>
            </div>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() =>
                void navigate({
                  to: "/accept-invitation/$invitationId",
                  params: { invitationId: invite.id },
                })
              }
            >
              Aceptar
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
