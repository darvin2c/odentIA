import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useState } from "react"
import { ApiError, api } from "../../lib/api"

export const Route = createFileRoute("/_app/team")({
  component: TeamPage,
})

interface StaffRow {
  userId: string
  name: string
  email: string
  role: "admin" | "support"
  active: boolean
  createdAt: string
}

interface InvitationRow {
  id: string
  email: string
  role: "admin" | "support"
  status: string
  expiresAt: string
  createdAt: string
}
interface TeamData {
  staff: StaffRow[]
  invitations: InvitationRow[]
}

interface AccessSession {
  actor: { userId: string; role: "admin" | "support" }
  verified: boolean
}

interface InviteResult {
  invitationId: string
  email: string
  role: "admin" | "support"
  expiresAt: string
  delivery: "sent" | "uncertain"
  token: string
}

function inviteLinkOf(token: string): string {
  return `${window.location.origin}/security?invitation=${encodeURIComponent(token)}`
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? `Error ${error.status}`
  return "No pudimos conectar con el servidor"
}

function TeamPage() {
  const queryClient = useQueryClient()
  const team = useQuery({
    queryKey: ["admin-team"],
    queryFn: () => api<TeamData>("/api/admin/access/team"),
  })
  const session = useQuery({
    queryKey: ["admin-access-session"],
    queryFn: () => api<AccessSession>("/api/admin/access/session"),
  })
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<"admin" | "support">("support")
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [reactivate, setReactivate] = useState<{ row: StaffRow; reason: string } | null>(null)
  const [confirm, setConfirm] = useState<
    | { kind: "role"; row: StaffRow; role: "admin" | "support" }
    | { kind: "deactivate"; row: StaffRow; reason: string }
    | { kind: "reset"; row: StaffRow; reason: string }
    | { kind: "revoke-invitation"; invitation: InvitationRow }
    | { kind: "resend"; invitation: InvitationRow; reason: string }
    | null
  >(null)

  const refresh = () => {
    setConfirm(null)
    setReactivate(null)
    void queryClient.invalidateQueries({ queryKey: ["admin-team"] })
  }

  const invite = useMutation({
    mutationFn: () =>
      api<InviteResult>(`/api/admin/access/team/invite`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      }),
    onSuccess: (data) => {
      setInviteEmail("")
      setInviteLink(inviteLinkOf(data.token))
      if (data.delivery === "sent")
        toast.success("Invitación enviada por correo; aquí tienes el enlace también")
      else toast.success("No pudimos confirmar el envío: comparte el enlace manualmente")
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const apply = useMutation({
    mutationFn: async () => {
      if (!confirm) return { ok: true as const }
      if (confirm.kind === "role") {
        return api<{ ok: true }>(`/api/admin/access/team/${confirm.row.userId}/role`, {
          method: "POST",
          body: JSON.stringify({ role: confirm.role }),
        })
      }
      if (confirm.kind === "deactivate") {
        return api<{ ok: true }>(`/api/admin/access/team/${confirm.row.userId}/active`, {
          method: "POST",
          body: JSON.stringify({ active: false, reason: confirm.reason }),
        })
      }
      if (confirm.kind === "reset") {
        return api<{ ok: true }>(`/api/admin/access/team/${confirm.row.userId}/factor-reset`, {
          method: "POST",
          body: JSON.stringify({ reason: confirm.reason }),
        })
      }
      if (confirm.kind === "resend") {
        return api<InviteResult>(
          `/api/admin/access/team/invitations/${confirm.invitation.id}/resend`,
          {
            method: "POST",
            body: JSON.stringify({ reason: confirm.reason }),
          },
        )
      }
      return api<{ ok: true }>(
        `/api/admin/access/team/invitations/${confirm.invitation.id}/revoke`,
        { method: "POST" },
      )
    },
    onSuccess: (data) => {
      if (confirm?.kind === "resend") {
        const delivery =
          typeof data === "object" &&
          data !== null &&
          "delivery" in data &&
          data.delivery === "sent"
            ? "sent"
            : "uncertain"
        const token =
          typeof data === "object" &&
          data !== null &&
          "token" in data &&
          typeof data.token === "string"
            ? data.token
            : ""
        setInviteLink(inviteLinkOf(token))
        if (delivery === "sent")
          toast.success("Invitación reenviada por correo; aquí tienes el enlace también")
        else toast.success("No pudimos confirmar el envío: comparte el enlace manualmente")
      } else toast.success("Listo")
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const setActive = useMutation({
    mutationFn: (input: { userId: string; active: boolean; reason: string }) =>
      api<{ ok: true }>(`/api/admin/access/team/${input.userId}/active`, {
        method: "POST",
        body: JSON.stringify({ active: input.active, reason: input.reason }),
      }),
    onSuccess: () => {
      toast.success("Integrante reactivado")
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const isManager = session.data?.actor.role === "admin"
  const confirmReason =
    confirm?.kind === "deactivate" || confirm?.kind === "reset" || confirm?.kind === "resend"
      ? confirm.reason
      : "ok"
  const confirmReady =
    confirm?.kind === "role" ||
    confirm?.kind === "revoke-invitation" ||
    (confirmReason.trim().length >= 8 && !apply.isPending)

  return (
    <PageShell>
      <PageHeader
        title="Equipo"
        subtitle="Personal interno: invitaciones nominales, roles y reactivación"
        primary={
          isManager ? { label: "Invitar", icon: <Plus aria-hidden />, onClick: () => setInviteOpen(true) } : undefined
        }
      />
      {team.isPending || session.isPending ? (
        <LoadingState message="Cargando equipo…" />
      ) : team.isError ? (
        <ErrorState
          message={apiMessage(team.error)}
          onRetry={() => void team.refetch()}
          {...(team.error instanceof ApiError &&
          team.error.status === 403 &&
          (team.error.shape.code === "MFA_REQUIRED" ||
            team.error.shape.code === "MFA_ENROLL_REQUIRED")
            ? { learnMoreLabel: "Verifica en Seguridad de acceso", learnMoreHref: "/security" }
            : {})}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {inviteLink ? (
            <p role="alert" className="rounded-md border px-3 py-2 text-sm">
              Comparte este enlace una sola vez por canal interno seguro:{" "}
              <code className="break-all">{inviteLink}</code>{" "}
              <Button
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(inviteLink).then(
                    () => toast.success("Enlace copiado"),
                    () => toast.error("No se pudo copiar"),
                  )
                }}
              >
                Copiar
              </Button>{" "}
              <Button variant="ghost" onClick={() => setInviteLink(null)}>
                Ocultar
              </Button>
            </p>
          ) : null}
          <section aria-label="Personal" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Personal</h2>
            {team.data.staff.length === 0 ? (
              <EmptyState title="Sin personal" description="Invita al primer miembro del equipo." />
            ) : (
              <ul className="flex flex-col gap-2">
                {team.data.staff.map((row) => (
                  <li
                    key={row.userId}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate font-medium">{row.name || row.email}</p>
                      <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                    </div>
                    <Badge>{row.role === "admin" ? "Administración" : "Soporte"}</Badge>
                    {row.active ? null : <Badge>Desactivado</Badge>}
                    {isManager && session.data && row.userId !== session.data.actor.userId ? (
                      reactivate?.row.userId === row.userId ? (
                        <form
                          className="flex w-full flex-wrap items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            setActive.mutate({
                              userId: row.userId,
                              active: true,
                              reason: reactivate.reason,
                            })
                          }}
                        >
                          <Input
                            aria-label="Motivo de reactivación"
                            placeholder="Motivo (queda auditado)"
                            value={reactivate.reason}
                            onChange={(event) => setReactivate({ row, reason: event.target.value })}
                          />
                          <Button
                            type="submit"
                            disabled={setActive.isPending || reactivate.reason.trim().length < 8}
                          >
                            {setActive.isPending ? "Reactivando…" : "Confirmar"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setReactivate(null)}>
                            Cancelar
                          </Button>
                        </form>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setConfirm({
                                kind: "role",
                                row,
                                role: row.role === "admin" ? "support" : "admin",
                              })
                            }
                          >
                            {row.role === "admin" ? "Pasar a soporte" : "Hacer admin"}
                          </Button>
                          {row.active ? (
                            <Button
                              variant="ghost"
                              onClick={() => setConfirm({ kind: "deactivate", row, reason: "" })}
                            >
                              Desactivar
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              onClick={() => setReactivate({ row, reason: "" })}
                            >
                              Reactivar
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() => setConfirm({ kind: "reset", row, reason: "" })}
                          >
                            Resetear factor
                          </Button>
                        </div>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Invitaciones" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Invitaciones pendientes</h2>
            {team.data.invitations.length === 0 ? (
              <EmptyState
                title="Sin invitaciones"
                description="Las invitaciones caducan a los 7 días."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {team.data.invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate font-medium">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {invitation.role === "admin" ? "Administración" : "Soporte"} · vence{" "}
                        {new Date(invitation.expiresAt).toLocaleDateString("es-PE")}
                      </p>
                    </div>
                    {isManager ? (
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => setConfirm({ kind: "resend", invitation, reason: "" })}
                        >
                          Reenviar
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setConfirm({ kind: "revoke-invitation", invitation })}
                        >
                          Revocar
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <FormDrawer
        open={inviteOpen}
        title="Invitar personal"
        onClose={() => setInviteOpen(false)}
        onSubmit={(event) => {
          event.preventDefault()
          invite.mutate()
        }}
        isDirty={inviteEmail.trim().length > 0}
        isSubmitting={invite.isPending}
        error={invite.isError ? apiMessage(invite.error) : null}
      >
        <Field>
          <FieldLabel htmlFor="invite-email">Correo del integrante</FieldLabel>
          <Input
            id="invite-email"
            type="email"
            autoComplete="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <FieldError>{null}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="invite-role">Rol</FieldLabel>
          <Select
            value={inviteRole}
            onValueChange={(value) => setInviteRole(value === "admin" ? "admin" : "support")}
          >
            <SelectTrigger id="invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="support">Soporte</SelectItem>
              <SelectItem value="admin">Administración</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FormDrawer>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "deactivate"
            ? "Desactivar personal"
            : confirm?.kind === "role"
              ? "Cambiar rol"
              : confirm?.kind === "reset"
                ? "Resetear segundo factor"
                : confirm?.kind === "resend"
                  ? "Reenviar invitación"
                  : "Revocar invitación"
        }
        description={
          confirm?.kind === "deactivate"
            ? `${confirm.row.email} pierde el acceso y sus sesiones. El último admin activo está protegido.`
            : confirm?.kind === "role"
              ? `${confirm.row.email} pasará a ${confirm.role === "admin" ? "Administración" : "Soporte"}.`
              : confirm?.kind === "reset"
                ? `${confirm.row.email} deberá enrolar un factor nuevo desde cero. Usa evidencia de autoridad fuera de banda.`
                : confirm?.kind === "resend"
                  ? `Se revoca la anterior y se crea una nueva para ${confirm.invitation.email}.`
                  : "La invitación dejará de ser válida."
        }
        confirmLabel={confirm?.kind === "revoke-invitation" ? "Revocar" : "Confirmar"}
        variant={
          confirm?.kind === "revoke-invitation" || confirm?.kind === "deactivate"
            ? "destructive"
            : "default"
        }
        pending={apply.isPending}
        confirmDisabled={!confirmReady}
        onConfirm={() => apply.mutate()}
        onClose={() => setConfirm(null)}
      >
        {confirm?.kind === "deactivate" ||
        confirm?.kind === "reset" ||
        confirm?.kind === "resend" ? (
          <Field>
            <FieldLabel htmlFor="confirm-reason">Motivo (obligatorio, queda auditado)</FieldLabel>
            <Input
              id="confirm-reason"
              value={confirm.reason}
              onChange={(event) => setConfirm({ ...confirm, reason: event.target.value })}
            />
          </Field>
        ) : null}
      </ConfirmDialog>
    </PageShell>
  )
}
