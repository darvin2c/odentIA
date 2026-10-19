import { Avatar, AvatarFallback, AvatarImage, Badge, Button, Input, toast } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, RowActions, type RowActionItem } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, ClipboardCheck, CreditCard, LogOut, Plus, Search, ShieldCheck } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { accountInvitationsQuery, accountOrganizationsQuery, billingStatusSchema, type AccountInvitation, type AccountOrganization } from "../../lib/account-organizations"
import { adminAccessQuery } from "../../lib/admin-access"
import { apiFetch } from "../../lib/api"
import { API_URL, authClient, authFetch } from "../../lib/auth-client"
import { storedInvitation } from "../../lib/founders"
import { adminUrl, BASE_DOMAIN, tenantUrl, webUrl } from "../../lib/host"

const appRouteApi = getRouteApi("/_app")

export const Route = createFileRoute("/_app/")({
  // `?cambiar=1`: vuelve desde «Cambiar de clínica» y no autoentra (issue 114).
  validateSearch: (search: Record<string, unknown>) => ({
    ...(String(search.cambiar) === "1" ? { cambiar: 1 as const } : {}),
  }),
  component: OrgsPage,
})

type BillingStatus = z.infer<typeof billingStatusSchema>

/** Si abrir una clínica pide invitación (Fundadores, issue 165); lo decide el servidor, esto solo lo explica. */
const signupModeQuery = {
  queryKey: ["public", "sign-up"],
  queryFn: async () => {
    const res = await fetch(`${API_URL}/api/public/sign-up`)
    if (!res.ok) throw new Error(`Error ${res.status}`)
    return z.object({ signupMode: z.enum(["invitacion", "abierta"]).default("abierta") }).passthrough().parse(await res.json())
  },
  staleTime: 60_000,
}

/** Con este número de clínicas aparece el buscador (caso asesor, issue 114). */
const BUSCADOR_DESDE = 6

/** Inicial con color estable: tokens categóricos existentes (ver `globals.css`). */
const SERIES_INICIAL = ["text-series-1", "text-series-2", "text-series-3"] as const

const ULTIMA_KEY = "odentia.panel.ultima-clinica"

/** Última clínica usada por esta persona, guardada en su navegador. */
function ultimaClinica(userId: string): string | null {
  try {
    const raw = window.localStorage.getItem(`${ULTIMA_KEY}.${userId}`)
    if (!raw) return null
    const parsed = z.object({ organizationId: z.string().min(1) }).passthrough().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.organizationId : null
  } catch {
    return null
  }
}

function recordarClinica(userId: string, organizationId: string): void {
  try {
    window.localStorage.setItem(`${ULTIMA_KEY}.${userId}`, JSON.stringify({ organizationId, at: Date.now() }))
  } catch {
    // Sin almacenamiento, la lista sigue en orden alfabético.
  }
}
const SELECTOR_VISTO_KEY = "odentia.panel.selector-visto"

/** El selector ya se mostró en esta pestaña para esta persona. */
function selectorVistoAntes(userId: string): boolean {
  try {
    if (typeof window === "undefined") return false
    return window.sessionStorage.getItem(SELECTOR_VISTO_KEY) === userId
  } catch {
    return false
  }
}

function marcarSelectorVisto(userId: string): void {
  try {
    window.sessionStorage.setItem(SELECTOR_VISTO_KEY, userId)
  } catch {
    // Sin almacenamiento de sesión, el aviso `?cambiar=1` sigue impidiendo el bucle.
  }
}


/** «sáb 17 oct»: como el resto de la plataforma, sin el punto de «sáb.». */
function fechaCorta(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  // Sin región fija (issue 114): el panel es de cuenta, sin clínica cuya
  // región usar; el idioma base respeta el formato del resto de la plataforma.
  return new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })
    .format(date)
    .replace(/\./g, "")
}
/**
 * Un solo estado por clínica, sin contradicciones (issue 114): la
 * demostración no muestra el fin de la prueba.
 */
function estadoClinica(status: BillingStatus): { insignia: string; detalle: string | null } {
  if (status.isDemo) return { insignia: "Demostración · sin cobro", detalle: null }
  switch (status.status) {
    case "prueba": {
      if (!status.trialEndsAt) return { insignia: "En prueba", detalle: null }
      const fin = new Date(status.trialEndsAt).getTime()
      const fecha = fechaCorta(status.trialEndsAt)
      if (Number.isNaN(fin) || fecha === null) return { insignia: "En prueba", detalle: null }
      const dias = Math.max(0, Math.ceil((fin - Date.now()) / 86_400_000))
      const quedan = dias <= 0 ? "termina hoy" : dias === 1 ? "queda 1 día" : `quedan ${dias} días`
      return { insignia: `Prueba · ${quedan}`, detalle: `Termina ${fecha}` }
    }
    case "activa":
      return { insignia: "Plan activo", detalle: null }
    case "gracia": {
      const fecha = status.graceEndsAt ? fechaCorta(status.graceEndsAt) : null
      return { insignia: "Pago pendiente", detalle: fecha ? `Gracia hasta el ${fecha}` : null }
    }
    case "restringida":
      return { insignia: "Solo lectura", detalle: null }
    case "pausada":
      return { insignia: "Suspendida", detalle: null }
    case "cancelada":
      return { insignia: "Cancelada", detalle: null }
    case "sin_suscripcion":
      return { insignia: "Sin suscripción", detalle: null }
  }
}
function OrgsPage() {
  const { session } = appRouteApi.useRouteContext()
  const search = Route.useSearch()
  const organizations = useQuery(accountOrganizationsQuery)
  const invitations = useQuery(accountInvitationsQuery)
  const staff = useQuery(adminAccessQuery)
  const signUp = useQuery(signupModeQuery)
  // La invitación Fundadores que trajo el enlace del correo, si quedó guardada al crear la cuenta.
  const [founderToken, setFounderToken] = useState<string | null>(null)
  useEffect(() => setFounderToken(storedInvitation()), [])
  const [ultima, setUltima] = useState<string | null>(null)
  useEffect(() => setUltima(ultimaClinica(session.userId)), [session.userId])
  const [texto, setTexto] = useState("")
  // Tras salir de una clínica o responder una invitación no se autoentra:
  // la persona está mirando la lista y elige a dónde ir. Igual cuando el
  // selector ya se mostró en esta pestaña (volver desde perfil o soporte):
  // la autoentrada es solo para la primera llegada.
  const [bloquearAuto, setBloquearAuto] = useState(() => selectorVistoAntes(session.userId))
  useEffect(() => { marcarSelectorVisto(session.userId) }, [session.userId])
  // La autoentrada no salta las ventanas que piden contraseña o términos
  // (las pinta el layout): solo entra directo cuando ya están resueltas.
  const [puertasListas, setPuertasListas] = useState(false)
  useEffect(() => {
    let viva = true
    void (async () => {
      try {
        const [legal, acceso] = await Promise.all([
          authFetch("/legal/status", { method: "GET" }),
          authFetch("/access-link/status", { method: "GET" }),
        ])
        const terminos = z.object({ terms: z.object({ state: z.string() }) }).safeParse(legal.data)
        const accesoActual = z.object({ pending: z.boolean() }).safeParse(acceso.data)
        if (viva && !legal.error && !acceso.error && terminos.success && terminos.data.terms.state === "ok" && accesoActual.success && !accesoActual.data.pending) setPuertasListas(true)
      } catch {
        // Sin respuesta del servidor no se autoentra: la persona elige a mano.
      }
    })()
    return () => { viva = false }
  }, [])
  const queryClient = useQueryClient()
  const [leaving, setLeaving] = useState<AccountOrganization | null>(null)
  const leave = useMutation({
    mutationFn: (org: AccountOrganization) => apiFetch(`/api/account/organizations/${encodeURIComponent(org.organizationId)}/leave`, { method: "POST" }),
    onSuccess: async () => { setBloquearAuto(true); setLeaving(null); await queryClient.invalidateQueries({ queryKey: ["account"] }); toast.success("Saliste de la organización") },
    onError: (error) => toast.error(error.message),
  })
  // La política de alta la decide el servidor (Fundadores, issue 165): si aún
  // no respondió, no se ofrece crear ni se explica nada.
  const politicaLista = signUp.isSuccess
  const invitationOnly = politicaLista && signUp.data?.signupMode === "invitacion"
  const canCreate = founderToken !== null || (politicaLista && !invitationOnly)

  const todas = useMemo(() => organizations.data ?? [], [organizations.data])
  const ordenadas = useMemo(() => {
    const lista = [...todas]
    // La última clínica usada va primero; el resto conserva el orden del servidor.
    lista.sort((a, b) => (a.organizationId === ultima ? -1 : b.organizationId === ultima ? 1 : 0))
    const consulta = texto.trim().toLowerCase()
    if (!consulta) return lista
    return lista.filter((org) =>
      org.organizationName.toLowerCase().includes(consulta)
      || org.slug.toLowerCase().includes(consulta)
      || `${org.slug}.${BASE_DOMAIN}`.toLowerCase().includes(consulta),
    )
  }, [todas, ultima, texto])

  // Con una sola clínica lista y sin invitaciones se entra directo (issue 114).
  // `?cambiar=1` vuelve desde «Cambiar de clínica» e impide el bucle.
  // No autoentra al personal de odentIA (elige entre su clínica y
  // Administración), ni con las ventanas pendientes, ni sin saber las
  // invitaciones: ante la duda, la persona elige.
  const unica = todas.length === 1 ? todas[0] : undefined
  const unicaLista = unica?.provisioning.hasProfile && unica.provisioning.hasBranch ? unica : undefined
  const autoIdo = useRef(false)
  useEffect(() => {
    if (autoIdo.current || search.cambiar === 1 || bloquearAuto || !unicaLista) return
    if (!invitations.isSuccess || (invitations.data?.length ?? 0) > 0) return
    if (!staff.isSuccess || staff.data.staff) return
    if (!puertasListas) return
    autoIdo.current = true
    recordarClinica(session.userId, unicaLista.organizationId)
    window.location.replace(tenantUrl(unicaLista.slug, "/home"))
  }, [search.cambiar, bloquearAuto, unicaLista, invitations.isSuccess, invitations.data, staff.isSuccess, staff.data, puertasListas, session.userId])

  const pendientes = invitations.data ?? []
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10 sm:py-14">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-xl font-semibold">Elige tu clínica</h1>
        <p className="text-sm text-muted-foreground">Entraste como {session.email}</p>
      </div>
      {staff.data?.staff && <a href={adminUrl()} className="flex items-center gap-3 rounded-xl border bg-card p-4 hover:bg-muted"><ShieldCheck className="size-5" aria-hidden /><div><p className="font-medium">Administración de odentIA</p><p className="text-sm text-muted-foreground">Organizaciones clientes, cobros y soporte</p></div></a>}
      {invitations.isError && <ErrorState title="No se pudieron cargar tus invitaciones" error={invitations.error} onRetry={() => void invitations.refetch()} />}
      {pendientes.length > 0 && <section aria-labelledby="invitations-title" className="space-y-3"><h2 id="invitations-title" className="text-sm font-semibold">Invitaciones pendientes</h2><ul className="space-y-3">{pendientes.map((invitation) => <InvitationItem key={invitation.id} invitation={invitation} onRespond={() => setBloquearAuto(true)} />)}</ul></section>}
      <section aria-label="Clínicas" className="space-y-3">
        {organizations.isPending ? <LoadingState message="Cargando clínicas…" /> : organizations.isError ? <ErrorState title="No se pudieron cargar tus clínicas" error={organizations.error} onRetry={() => void organizations.refetch()} /> : todas.length === 0 ? (!politicaLista && founderToken === null ? (signUp.isError ? <ErrorState title="No se pudo comprobar cómo crear una clínica" error={signUp.error} onRetry={() => void signUp.refetch()} /> : <LoadingState message="Comprobando cómo crear una clínica…" />) : canCreate ? <EmptyState title="Todavía no perteneces a una clínica" description="Acepta una invitación o crea la cuenta de tu clínica. Si necesitas ayuda, puedes escribir a soporte." /> : <NoInvitation email={session.email} />) : (
          <>
            {todas.length >= BUSCADOR_DESDE && (
              <div className="relative">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={texto} onChange={(event) => setTexto(event.target.value)} placeholder="Buscar clínica…" aria-label="Buscar clínica" className="pl-9" />
              </div>
            )}
            {ordenadas.length === 0 ? <p className="rounded-xl border bg-card p-4 text-center text-sm text-muted-foreground">Ninguna clínica coincide con «{texto.trim()}».</p> : (
              <ul className="space-y-3">
                {ordenadas.map((org) => (
                  <OrganizationItem key={org.organizationId} org={org} esUltima={org.organizationId === ultima} userId={session.userId} onLeave={() => setLeaving(org)} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <footer className="flex flex-col items-center gap-3 border-t pt-6">
        {canCreate && (founderToken ? (
          <Button render={<Link to="/onboarding" search={{ continue: undefined, invitacion: founderToken }} />}>Abrir mi clínica</Button>
        ) : (
          <Button variant="outline" render={<Link to="/onboarding" search={{ continue: undefined }} />}><Plus className="size-4" aria-hidden />{todas.length > 0 ? "Crear otra clínica" : "Crear mi clínica"}</Button>
        ))}
        <p className="text-sm text-muted-foreground">¿Necesitas ayuda? <Link to="/support" className="underline">Contacta con soporte</Link></p>
      </footer>
      <ConfirmDialog open={leaving !== null} title={`Salir de ${leaving?.organizationName ?? "la organización"}`} description="Perderás el acceso a esta clínica. Lo que registraste se conserva con tu autoría; para volver necesitarás una invitación." confirmLabel="Salir de la organización" pending={leave.isPending} onClose={() => setLeaving(null)} onConfirm={() => { if (leaving) leave.mutate(leaving) }} />
    </main>
  )
}

function OrganizationItem({ org, esUltima, userId, onLeave }: { org: AccountOrganization; esUltima: boolean; userId: string; onLeave: () => void }) {
  const navigate = useNavigate()
  const status = useQuery({
    queryKey: ["account", "billing-status", org.organizationId],
    queryFn: async () => z.object({ data: billingStatusSchema }).parse(await apiFetch<unknown>(`/api/account/billing/status?orgId=${encodeURIComponent(org.organizationId)}`)).data,
  })
  const canManage = org.role === "owner" || org.role === "admin"
  const incomplete = !org.provisioning.hasProfile || !org.provisioning.hasBranch
  const dominio = `${org.slug}.${BASE_DOMAIN}`
  const estado = status.data ? estadoClinica(status.data) : null
  const inicial = org.organizationName.trim().charAt(0).toUpperCase() || "C"
  let serie = 0
  for (const punto of org.organizationName) serie = (serie * 31 + (punto.codePointAt(0) ?? 0)) % SERIES_INICIAL.length
  const acciones: RowActionItem[] = []
  if (canManage && !incomplete) acciones.push({ key: "plan", label: "Plan y pagos", icon: <CreditCard className="size-4" aria-hidden />, onSelect: () => void navigate({ to: "/billing/$organizationId", params: { organizationId: org.organizationId } }) })
  if (incomplete && canManage) acciones.push({ key: "alta", label: "Terminar el alta", icon: <ClipboardCheck className="size-4" aria-hidden />, onSelect: () => void navigate({ to: "/onboarding", search: { continue: org.organizationId } }) })
  if (org.canLeave) acciones.push({ key: "salir", label: "Salir de esta clínica", tone: "danger", icon: <LogOut className="size-4" aria-hidden />, onSelect: onLeave })
  // Toda la fila lleva a la clínica con el enlace estirado: el menú «⋯» queda
  // por encima y sigue siendo accionable por separado.
  const enlace = "font-medium break-words before:absolute before:inset-0 before:rounded-xl focus-visible:outline-none"
  return (
    <li className="relative flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <Avatar className="size-11 shrink-0">
        {org.logo ? <AvatarImage src={org.logo} alt="" /> : null}
        <AvatarFallback className={`bg-muted font-semibold ${SERIES_INICIAL[serie] ?? "text-series-1"}`}>{inicial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {incomplete && !canManage ? <span className={enlace}>{org.organizationName}</span>
            : incomplete ? <Link to="/onboarding" search={{ continue: org.organizationId }} onClick={() => recordarClinica(userId, org.organizationId)} aria-label={`Terminar el alta de ${org.organizationName}`} className={enlace}>{org.organizationName}</Link>
            : <a href={tenantUrl(org.slug, "/home")} onClick={() => recordarClinica(userId, org.organizationId)} aria-label={`Entrar a ${org.organizationName}`} className={enlace}>{org.organizationName}</a>
          }
          {esUltima && <Badge variant="outline">Última usada</Badge>}
          {estado && <Badge variant="secondary">{estado.insignia}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{dominio} · {org.roleLabel}</p>
        {estado?.detalle && <p className="mt-0.5 text-sm text-muted-foreground">{estado.detalle}</p>}
        {status.data?.restricted && <p className="mt-1 text-sm">{canManage ? "Consulta Plan y pagos o contacta con soporte para revisar la restricción." : "La operación está restringida. Contacta con quien administra tu clínica."}</p>}
        {incomplete && !canManage && <p className="mt-1 text-sm">Quien administra la clínica debe terminar el alta.</p>}
        {status.isError && <p className="relative mt-2 text-sm text-destructive">No se pudo consultar el estado. <button type="button" className="underline" onClick={() => void status.refetch()}>Reintentar</button></p>}
      </div>
      <div className="relative flex shrink-0 items-center gap-1">
        {!incomplete && <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
        {acciones.length > 0 && <RowActions label={`Acciones de ${org.organizationName}`} items={acciones} />}
      </div>
    </li>
  )
}

function InvitationItem({ invitation, onRespond }: { invitation: AccountInvitation; onRespond: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const response = useMutation({
    mutationFn: async (accept: boolean) => {
      const result = accept
        ? await authClient.organization.acceptInvitation({ invitationId: invitation.id })
        : await authClient.organization.rejectInvitation({ invitationId: invitation.id })
      if (result.error) throw new Error(result.error.message ?? "No se pudo responder la invitación")
      return accept
    },
    onSuccess: async (accepted) => {
      setRejecting(false)
      onRespond()
      await queryClient.invalidateQueries({ queryKey: ["account"] })
      toast.success(accepted ? "Invitación aceptada" : "Invitación rechazada")
      if (accepted && (invitation.role === "owner" || invitation.role === "admin") && (!invitation.provisioning.hasProfile || !invitation.provisioning.hasBranch)) await navigate({ to: "/onboarding", search: { continue: invitation.organizationId } })
    },
    onError: (error) => toast.error(error.message),
  })
  return <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-card p-4">
    <div><p className="font-medium">{invitation.organizationName}</p><p className="text-sm text-muted-foreground">{invitation.slug}.{BASE_DOMAIN} · Te invitaron como {invitation.roleLabel}</p></div>
    <div className="flex gap-2"><Button variant="ghost" disabled={response.isPending} onClick={() => setRejecting(true)}>Rechazar</Button><Button disabled={response.isPending} onClick={() => response.mutate(true)}>{response.isPending ? "Guardando…" : "Aceptar"}</Button></div>
    <ConfirmDialog open={rejecting} title="Rechazar invitación" description={`No entrarás a ${invitation.organizationName}. Si cambias de opinión, tendrán que invitarte de nuevo.`} confirmLabel="Rechazar invitación" pending={response.isPending} onClose={() => setRejecting(false)} onConfirm={() => response.mutate(false)} />
  </li>
}
/**
 * Sin clínica y sin invitación mientras se entra por invitación (Fundadores,
 * tablero 10): dos salidas, pedir la invitación o pedir que la clínica invite.
 * El servidor tampoco deja abrir una clínica sin invitación.
 */
function NoInvitation({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div>
        <p className="text-lg font-semibold">Todavía no perteneces a una clínica</p>
        <p className="mt-1 text-sm text-muted-foreground">Por ahora se entra a odentIA con invitación: estamos abriendo con un grupo de clínicas Fundadoras.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <div>
          <p className="font-medium">Quiero usar odentIA en mi clínica</p>
          <p className="text-sm text-muted-foreground">Pide tu invitación en la web; te respondemos en 2 días hábiles.</p>
        </div>
        <Button render={<a href={webUrl("/solicitar-invitacion")} />}>Solicitar invitación</Button>
      </div>
      <div className="rounded-lg border p-4">
        <p className="font-medium">Trabajo en una clínica que ya usa odentIA</p>
        <p className="text-sm text-muted-foreground">
          Pide a quien administra tu clínica que te invite{email ? ` a ${email}` : ""}. La invitación aparecerá aquí.
        </p>
      </div>
    </div>
  )
}
