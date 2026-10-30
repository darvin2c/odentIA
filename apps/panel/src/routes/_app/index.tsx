import { Avatar, AvatarFallback, AvatarImage, Button, Input, toast } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, RowActions, type RowActionItem, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, LogOut, Plus, Search, ShieldCheck } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { accountInvitationsQuery, accountOrganizationsQuery, billingStatusSchema, clinicNoticeSchema, type AccountInvitation, type AccountOrganization } from "../../lib/account-organizations"
import { adminAccessQuery } from "../../lib/admin-access"
import { apiFetch } from "../../lib/api"
import { API_URL, authClient, authFetch } from "../../lib/auth-client"
import { authError } from "../../lib/auth-error"
import { storedInvitation } from "../../lib/founders"
import { adminUrl, domainOf, tenantUrl, webUrl } from "../../lib/host"
import { panelWords } from "../../lib/brand"

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
    return z
      .object({ signupMode: z.enum(["invitacion", "abierta"]).default("abierta"), waitlistAnswerDays: z.number().optional() })
      .passthrough()
      .parse(await res.json())
  },
  staleTime: 60_000,
}

/** Con este número de clínicas aparece el buscador (caso asesor, issue 114). */
const BUSCADOR_DESDE = 6

/** Inicial con color estable: tokens categóricos existentes (ver `globals.css`). */
const SERIES_INICIAL = ["text-series-1", "text-series-2", "text-series-3"] as const

const ULTIMA_KEY = "odentia.panel.ultima-clinica"

/** Última clínica usada por esta persona, guardada en su navegador, con cuándo se abrió. */
function ultimaClinica(userId: string): { organizationId: string; at: number | null } | null {
  try {
    const raw = window.localStorage.getItem(`${ULTIMA_KEY}.${userId}`)
    if (!raw) return null
    const parsed = z.object({ organizationId: z.string().min(1), at: z.number().optional() }).passthrough().safeParse(JSON.parse(raw))
    return parsed.success ? { organizationId: parsed.data.organizationId, at: parsed.data.at ?? null } : null
  } catch {
    return null
  }
}

/** «Abriste hoy», «Abriste ayer», «Abriste hace 3 días»: en vez de la etiqueta «Última usada». */
function abriste(at: number | null): string | null {
  if (at === null) return null
  const dia = (value: number) => Math.floor((value - new Date(value).getTimezoneOffset() * 60_000) / 86_400_000)
  const dias = dia(Date.now()) - dia(at)
  if (dias <= 0) return "Abriste hoy"
  if (dias === 1) return "Abriste ayer"
  if (dias < 30) return `Abriste hace ${dias} días`
  return null
}

/** «3 sedes: Miraflores, San Isidro y Surco»; con más de tres, solo cuántas. */
function sedesTexto(sedes: string[]): string | null {
  if (sedes.length === 0) return null
  if (sedes.length === 1) return "1 sede"
  if (sedes.length > 3) return `${sedes.length} sedes`
  return `${sedes.length} sedes: ${new Intl.ListFormat("es", { type: "conjunction" }).format(sedes)}`
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
type Tono = "suave" | "plazo" | "detenido" | "neutro"

/**
 * Un solo estado por clínica, solo cuando importa (issue 114, ADR 0065): sin
 * «Plan activo», que no ayuda a elegir. La demostración no muestra el fin de
 * la prueba y «pausada» (la pone odentIA) dice «En pausa».
 */
function estadoClinica(status: BillingStatus): { insignia: string; tono: Tono; detalle: string | null } | null {
  if (status.isDemo) return { insignia: "Demostración · sin cobro", tono: "neutro", detalle: null }
  switch (status.status) {
    case "prueba": {
      if (!status.trialEndsAt) return { insignia: "En prueba", tono: "suave", detalle: null }
      const fin = new Date(status.trialEndsAt).getTime()
      const fecha = fechaCorta(status.trialEndsAt)
      if (Number.isNaN(fin) || fecha === null) return { insignia: "En prueba", tono: "suave", detalle: null }
      const dias = Math.max(0, Math.ceil((fin - Date.now()) / 86_400_000))
      const quedan = dias <= 0 ? "termina hoy" : dias === 1 ? "queda 1 día" : `quedan ${dias} días`
      return { insignia: `Prueba · ${quedan}`, tono: "suave", detalle: null }
    }
    case "activa":
      return null
    case "gracia": {
      const fecha = status.graceEndsAt ? fechaCorta(status.graceEndsAt) : null
      return { insignia: "Pago pendiente", tono: "plazo", detalle: fecha ? `Se puede usar hasta el ${fecha}` : null }
    }
    case "restringida":
      return { insignia: "Solo lectura", tono: "detenido", detalle: null }
    case "pausada":
      return { insignia: "En pausa", tono: "detenido", detalle: null }
    case "cancelada":
      return { insignia: "Cancelada", tono: "detenido", detalle: null }
    case "sin_suscripcion":
      return { insignia: "Sin suscripción", tono: "neutro", detalle: null }
  }
}

const TONO_CLASE: Record<Tono, string> = {
  suave: "bg-primary-soft text-primary-soft-foreground",
  plazo: "bg-warning-soft text-warning",
  detenido: "bg-destructive/10 text-destructive",
  neutro: "bg-muted text-muted-foreground",
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
  const [ultimaGuardada, setUltima] = useState<{ organizationId: string; at: number | null } | null>(null)
  useEffect(() => setUltima(ultimaClinica(session.userId)), [session.userId])
  const ultima = ultimaGuardada?.organizationId ?? null
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
    onError: (error) => toast.error(submitErrorMessage(error)),
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
      || `${org.slug}.${domainOf(org.product)}`.toLowerCase().includes(consulta),
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
    window.location.replace(tenantUrl(unicaLista.slug, "/home", unicaLista.product))
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
                  <OrganizationItem key={org.organizationId} org={org} abiertaEl={org.organizationId === ultima ? (ultimaGuardada?.at ?? null) : undefined} userId={session.userId} onLeave={() => setLeaving(org)} />
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

function OrganizationItem({ org, abiertaEl, userId, onLeave }: { org: AccountOrganization; abiertaEl?: number | null; userId: string; onLeave: () => void }) {
  const status = useQuery({
    queryKey: ["account", "billing-status", org.organizationId],
    queryFn: async () => z.object({ data: billingStatusSchema }).parse(await apiFetch<unknown>(`/api/account/billing/status?orgId=${encodeURIComponent(org.organizationId)}`)).data,
  })
  // Lo que pide actuar sale de la misma franja de la clínica, con el público que decide el servidor.
  const notices = useQuery({
    queryKey: ["account", "notices", org.organizationId],
    queryFn: async () => z.object({ data: z.array(clinicNoticeSchema) }).parse(await apiFetch<unknown>(`/api/account/billing/notices?orgId=${encodeURIComponent(org.organizationId)}`)).data,
    retry: false,
  })
  const canManage = org.role === "owner" || org.role === "admin"
  const incomplete = !org.provisioning.hasProfile || !org.provisioning.hasBranch
  const estado = status.data ? estadoClinica(status.data) : null
  const urgente = notices.data?.find((notice) => (notice.topic === "cobro" || notice.topic === "tope") && notice.tone !== "aviso")
  const insignia = urgente
    ? { texto: urgente.short, clase: TONO_CLASE[urgente.tone === "limite" ? "detenido" : "plazo"] }
    : estado
      ? { texto: estado.insignia, clase: TONO_CLASE[estado.tono] }
      : null
  const accionPlan = canManage && urgente?.action && ["pagar", "elegir_plan", "subir_tope"].includes(urgente.action.kind) ? urgente.action : null
  const inicial = org.organizationName.trim().charAt(0).toUpperCase() || "C"
  let serie = 0
  for (const punto of org.organizationName) serie = (serie * 31 + (punto.codePointAt(0) ?? 0)) % SERIES_INICIAL.length
  // El «⋯» queda solo para salir: lo que pide acción va en la fila (ADR 0065).
  const acciones: RowActionItem[] = org.canLeave
    ? [{ key: "salir", label: "Salir de esta clínica", tone: "danger", icon: <LogOut className="size-4" aria-hidden />, onSelect: onLeave }]
    : []
  const linea = [`${org.slug}.${domainOf(org.product)}`, org.roleLabel, sedesTexto(org.branches), abiertaEl !== undefined ? abriste(abiertaEl) : null]
    .filter(Boolean)
    .join(" · ")
  const enlace = "font-medium break-words before:absolute before:inset-0 before:rounded-xl focus-visible:outline-none"
  const boton = "relative min-h-11 sm:min-h-9"
  return (
    <li className="relative flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <Avatar className="size-11 shrink-0">
        {org.logo ? <AvatarImage src={org.logo} alt="" /> : null}
        <AvatarFallback className={`bg-muted font-semibold ${SERIES_INICIAL[serie] ?? "text-series-1"}`}>{inicial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2">
          {incomplete && !canManage ? <span className={enlace}>{org.organizationName}</span>
            : incomplete ? <Link to="/onboarding" search={{ continue: org.organizationId }} onClick={() => recordarClinica(userId, org.organizationId)} aria-label={`Terminar el alta de ${org.organizationName}`} className={enlace}>{org.organizationName}</Link>
            : <a href={tenantUrl(org.slug, "/home", org.product)} onClick={() => recordarClinica(userId, org.organizationId)} aria-label={`Entrar a ${org.organizationName}`} className={enlace}>{org.organizationName}</a>
          }
          {incomplete ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONO_CLASE.neutro}`}>Falta terminar el alta</span>
            : insignia ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${insignia.clase}`}>{insignia.texto}</span> : null}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{linea}</p>
        {estado?.detalle && !urgente ? <p className="mt-0.5 text-sm text-muted-foreground">{estado.detalle}</p> : null}
        {!canManage && urgente ? <p className="mt-0.5 text-sm text-muted-foreground">{urgente.message}</p> : null}
        {incomplete && !canManage && <p className="mt-1 text-sm">Quien administra la clínica debe terminar el alta.</p>}
        {status.isError && <p className="relative mt-2 text-sm text-destructive">No se pudo consultar el estado. <button type="button" className="underline" onClick={() => void status.refetch()}>Reintentar</button></p>}
      </div>
      <div className="relative flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:justify-end">
        {incomplete && canManage ? (
          <Button className={boton} render={<Link to="/onboarding" search={{ continue: org.organizationId }} onClick={() => recordarClinica(userId, org.organizationId)} />}>
            Terminar el alta
          </Button>
        ) : accionPlan ? (
          <Button variant="outline" className={boton} render={<a href={tenantUrl(org.slug, "/settings/plan", org.product)} onClick={() => recordarClinica(userId, org.organizationId)} />}>
            {accionPlan.kind === "pagar" ? "Pagar" : accionPlan.label}
          </Button>
        ) : null}
        {!incomplete && <ChevronRight className="size-5 shrink-0 text-muted-foreground max-sm:hidden" aria-hidden />}
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
      if (result.error) throw authError(result.error)
      return accept
    },
    onSuccess: async (accepted) => {
      setRejecting(false)
      onRespond()
      await queryClient.invalidateQueries({ queryKey: ["account"] })
      toast.success(accepted ? "Invitación aceptada" : "Invitación rechazada")
      if (accepted && (invitation.role === "owner" || invitation.role === "admin") && (!invitation.provisioning.hasProfile || !invitation.provisioning.hasBranch)) await navigate({ to: "/onboarding", search: { continue: invitation.organizationId } })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  return <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-card p-4">
    <div><p className="font-medium">{invitation.organizationName}</p><p className="text-sm text-muted-foreground">{invitation.slug}.{domainOf(invitation.product)} · Te invitaron como {invitation.roleLabel}</p></div>
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
  // En cuántos días hábiles se responde: las condiciones comerciales que rigen.
  const answerDays = useQuery(signupModeQuery).data?.waitlistAnswerDays
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div>
        <p className="text-lg font-semibold">Todavía no perteneces a una clínica</p>
        <p className="mt-1 text-sm text-muted-foreground">Por ahora se entra a {panelWords.name} con invitación: estamos abriendo con un grupo de clínicas Fundadoras.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <div>
          <p className="font-medium">Quiero usar {panelWords.name} en mi {panelWords.place.one}</p>
          <p className="text-sm text-muted-foreground">
            Pide tu invitación en la web
            {answerDays ? `; te respondemos en ${answerDays} ${answerDays === 1 ? "día hábil" : "días hábiles"}` : ""}.
          </p>
        </div>
        <Button render={<a href={webUrl("/solicitar-invitacion")} />}>Solicitar invitación</Button>
      </div>
      <div className="rounded-lg border p-4">
        <p className="font-medium">Trabajo en {panelWords.place.indefinite} que ya usa {panelWords.name}</p>
        <p className="text-sm text-muted-foreground">
          Pide a quien administra tu clínica que te invite{email ? ` a ${email}` : ""}. La invitación aparecerá aquí.
        </p>
      </div>
    </div>
  )
}
