import { Badge, Button, toast } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Building2, ShieldCheck } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { accountInvitationsQuery, accountOrganizationsQuery, billingStatusSchema, type AccountInvitation, type AccountOrganization } from "../../lib/account-organizations"
import { adminAccessQuery } from "../../lib/admin-access"
import { apiFetch } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { adminUrl, tenantUrl } from "../../lib/host"

export const Route = createFileRoute("/_app/")({ component: OrgsPage })

const statusLabels = {
  prueba: "En prueba", activa: "Al día", gracia: "Pago pendiente",
  restringida: "Solo lectura", pausada: "Suspendida", cancelada: "Cancelada",
  sin_suscripcion: "Sin suscripción",
}

function OrgsPage() {
  const organizations = useQuery(accountOrganizationsQuery)
  const invitations = useQuery(accountInvitationsQuery)
  const staff = useQuery(adminAccessQuery)
  const queryClient = useQueryClient()
  const [leaving, setLeaving] = useState<AccountOrganization | null>(null)
  const leave = useMutation({
    mutationFn: (org: AccountOrganization) => apiFetch(`/api/account/organizations/${encodeURIComponent(org.organizationId)}/leave`, { method: "POST" }),
    onSuccess: async () => { setLeaving(null); await queryClient.invalidateQueries({ queryKey: ["account"] }); toast.success("Saliste de la organización") },
    onError: (error) => toast.error(error.message),
  })
  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Mis organizaciones" subtitle="Elige dónde quieres trabajar" actions={<Button variant="outline" render={<Link to="/onboarding" search={{ continue: undefined }} />}>Crear organización</Button>} />
    {staff.data?.staff && <a href={adminUrl()} className="flex items-center gap-3 rounded-xl border bg-card p-4 hover:bg-muted"><ShieldCheck className="size-5" aria-hidden /><div><p className="font-medium">Administración de odentIA</p><p className="text-sm text-muted-foreground">Organizaciones clientes, cobros y soporte</p></div></a>}
    {invitations.isError && <ErrorState title="No se pudieron cargar tus invitaciones" error={invitations.error} onRetry={() => void invitations.refetch()} />}
    {invitations.data && invitations.data.length > 0 && <section aria-labelledby="invitations-title" className="space-y-3"><h2 id="invitations-title" className="text-sm font-semibold">Invitaciones pendientes</h2><ul className="space-y-3">{invitations.data.map((invitation) => <InvitationItem key={invitation.id} invitation={invitation} />)}</ul></section>}
    <section aria-labelledby="organizations-title" className="space-y-3">
      <h2 id="organizations-title" className="text-sm font-semibold">Donde trabajas</h2>
      {organizations.isPending ? <LoadingState message="Cargando organizaciones…" /> : organizations.isError ? <ErrorState error={organizations.error} onRetry={() => void organizations.refetch()} /> : organizations.data.length === 0 ? <EmptyState title="Todavía no perteneces a una organización" description="Acepta una invitación o crea la cuenta de tu clínica. Si necesitas ayuda, puedes escribir a soporte." /> : <ul className="space-y-3">{organizations.data.map((org) => <OrganizationItem key={org.organizationId} org={org} onLeave={() => setLeaving(org)} />)}</ul>}
    </section>
    <ConfirmDialog open={leaving !== null} title={`Salir de ${leaving?.organizationName ?? "la organización"}`} description="Perderás el acceso a esta clínica. Lo que registraste se conserva con tu autoría; para volver necesitarás una invitación." confirmLabel="Salir de la organización" pending={leave.isPending} onClose={() => setLeaving(null)} onConfirm={() => { if (leaving) leave.mutate(leaving) }} />
  </PageShell>
}

function OrganizationItem({ org, onLeave }: { org: AccountOrganization; onLeave: () => void }) {
  const status = useQuery({
    queryKey: ["account", "billing-status", org.organizationId],
    queryFn: async () => z.object({ data: billingStatusSchema }).parse(await apiFetch<unknown>(`/api/account/billing/status?orgId=${encodeURIComponent(org.organizationId)}`)).data,
  })
  const canManage = org.role === "owner" || org.role === "admin"
  const incomplete = !org.provisioning.hasProfile || !org.provisioning.hasBranch
  return <li className="rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-start gap-3">
      <Building2 className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{org.organizationName}</h3>{status.data && <Badge variant="secondary">{status.data.isDemo ? "Demostración · sin cobro" : statusLabels[status.data.status]}</Badge>}</div><p className="text-sm text-muted-foreground">{org.roleLabel}</p>
        {status.data?.trialEndsAt && status.data.status === "prueba" && <p className="mt-1 text-sm text-muted-foreground">La prueba termina el {new Date(status.data.trialEndsAt).toLocaleDateString("es")}</p>}
        {status.data?.restricted && <p className="mt-1 text-sm">{canManage ? "Consulta Plan y pagos o contacta con soporte para revisar la restricción." : "La operación está restringida. Contacta con quien administra tu clínica."}</p>}
        {incomplete && !canManage && <p className="mt-1 text-sm">Quien administra la clínica debe terminar el alta.</p>}
        {status.isError && <p className="mt-2 text-sm text-destructive">No se pudo consultar el estado. <button type="button" className="underline" onClick={() => void status.refetch()}>Reintentar</button></p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManage && <Button variant="outline" render={<Link to="/billing/$organizationId" params={{ organizationId: org.organizationId }} />}>Plan y pagos</Button>}
        {incomplete && canManage ? <Button render={<Link to="/onboarding" search={{ continue: org.organizationId }} />}>Terminar alta</Button> : !incomplete && <Button render={<a href={tenantUrl(org.slug, "/home")} />}>{status.data?.restricted ? "Entrar para ver" : "Entrar"}</Button>}
        {org.canLeave && <Button variant="ghost" onClick={onLeave}>Salir de esta clínica</Button>}
      </div>
    </div>
  </li>
}

function InvitationItem({ invitation }: { invitation: AccountInvitation }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const response = useMutation({
    mutationFn: async (accept: boolean) => {
      const result = accept ? await authClient.organization.acceptInvitation({ invitationId: invitation.id }) : await authClient.organization.rejectInvitation({ invitationId: invitation.id })
      if (result.error) throw new Error(result.error.message ?? "No se pudo responder la invitación")
      return accept
    },
    onSuccess: async (accepted) => {
      setRejecting(false)
      await queryClient.invalidateQueries({ queryKey: ["account"] })
      toast.success(accepted ? "Invitación aceptada" : "Invitación rechazada")
      if (accepted && (invitation.role === "owner" || invitation.role === "admin") && (!invitation.provisioning.hasProfile || !invitation.provisioning.hasBranch)) await navigate({ to: "/onboarding", search: { continue: invitation.organizationId } })
    },
    onError: (error) => toast.error(error.message),
  })
  return <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
    <div><p className="font-medium">{invitation.organizationName}</p><p className="text-sm text-muted-foreground">Te invitaron como {invitation.roleLabel}</p></div>
    <div className="flex gap-2"><Button variant="ghost" disabled={response.isPending} onClick={() => setRejecting(true)}>Rechazar</Button><Button disabled={response.isPending} onClick={() => response.mutate(true)}>{response.isPending ? "Guardando…" : "Aceptar"}</Button></div>
    <ConfirmDialog open={rejecting} title="Rechazar invitación" description={`No entrarás a ${invitation.organizationName}. Si cambias de opinión, tendrán que invitarte de nuevo.`} confirmLabel="Rechazar invitación" pending={response.isPending} onClose={() => setRejecting(false)} onConfirm={() => response.mutate(false)} />
  </li>
}
