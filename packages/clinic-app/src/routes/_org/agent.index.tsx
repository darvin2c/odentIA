import { Alert, AlertDescription, AlertTitle, Badge, Button, buttonVariants, cn } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { CapReachedNotice } from "../../components/agent/reception-off-notice"
import { AgentMark, AgentSurface, ConfirmDialog, EmptyState, PageHeader, PageShell, submitErrorMessage, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ArrowRight, ChevronRight, CircleHelp, Lightbulb, Lock, MessageCircle, Mic } from "lucide-react"
import { type ReactNode, useState } from "react"
import type { AdminOverview } from "../../lib/admin"
import { AgentBaseDrawer } from "../../components/agent/base-drawer"
import { WritingHoursCard } from "../../components/agent/writing-hours"
import { AgentTabs } from "../../components/agent-tabs"
import { agentModelDown, type AgentLearned, type AgentOverview, type AgentRole, type AgentRoles, namedAgentRoles } from "../../lib/agent"
import { ADMIN_NAME, useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type AgentConfig, timeAgo, usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { QueryErrorState } from "../../lib/query-error"
import { AgentOverviewPageSkeleton, AgentOverviewSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/")({
  pendingComponent: AgentOverviewPageSkeleton,
  component: AgentSummaryPage,
})
const orgRouteApi = getRouteApi("/_org")

/** Lo que Argos tiene activo, en una frase: cuántas, quién las hace y cuántas más recomienda. */
function adminSummary(admin: AdminOverview): string {
  const parts = [
    admin.on === 0
      ? "Ninguna línea prendida todavía"
      : `${admin.on} ${admin.on === 1 ? "prendida" : "prendidas"}: ${admin.byAgent} ${admin.byAgent === 1 ? "la hace" : "las hace"} ${ADMIN_NAME} y ${admin.byTeam} ${admin.byTeam === 1 ? "le toca" : "le tocan"} a tu equipo`,
    admin.recommended > 0 ? `te recomienda ${admin.recommended} más` : null,
  ]
  return parts.filter(Boolean).join(" · ")
}

const ROLE_ICON: Record<AgentRole["id"], ReactNode> = {
  recepcion: <MessageCircle aria-hidden />,
  asistente_clinico: <Mic aria-hidden />,
  administrador: <Lightbulb aria-hidden />,
  ayuda: <CircleHelp aria-hidden />,
}

/** La página de cada agente que la clínica enciende. La Ayuda viene con el sistema: no está en esta lista. */
const ROLE_PAGE = {
  recepcion: "/agent/recepcion",
  asistente_clinico: "/agent/asistente-clinico",
  administrador: "/agent/administrador",
} as const


const outlineLink = cn(buttonVariants({ variant: "outline" }), "min-h-11 sm:min-h-9")

/** En teléfono la ficha es el número y su nombre; la explicación aparece cuando hay sitio. */
function NeedTile({ count, title, pending, done, to }: { count: number; title: string; pending: string; done: string; to: string }) {
  return (
    <Link to={to} className="lift flex min-h-11 flex-col rounded-xl border bg-card px-3 py-2.5 hover:bg-accent/60 sm:gap-0.5 sm:p-4">
      <span className="font-heading text-2xl font-bold text-primary-soft-foreground tabular-nums sm:text-3xl">{count}</span>
      <span className="text-sm font-semibold sm:text-base sm:font-bold">{title}</span>
      <span className="text-sm text-muted-foreground max-sm:hidden">{count > 0 ? pending : done}</span>
    </Link>
  )
}

/** Aviso de algo que impide responder: dice qué pasa y, a quien puede resolverlo, dónde. */
function SummaryNotice({ tone, title, children, action }: { tone: "danger" | "warning"; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Alert
      role={tone === "danger" ? "alert" : "status"}
      className={cn("gap-1", tone === "danger" ? "border-destructive/30 bg-danger-soft" : "border-warning/40 bg-warning-soft")}
    >
      <AlertTitle className={cn("font-bold", tone === "danger" ? "text-destructive" : "text-warning")}>{title}</AlertTitle>
      <AlertDescription className="text-foreground">{children}</AlertDescription>
      {action ? <div className="mt-2">{action}</div> : null}
    </Alert>
  )
}

/** «el jueves», u «hoy» si fue hoy: la semana cabe en el nombre del día. */
function approvedDay(iso: string): string {
  const date = new Date(iso)
  if (date.toDateString() === new Date().toDateString()) return "hoy"
  return `el ${date.toLocaleDateString("es", { weekday: "long" })}`
}

const LEARNED_ROWS: Array<{ key: keyof Omit<AgentLearned, "latest">; one: string; many: string }> = [
  { key: "officialAnswers", one: "respuesta oficial nueva", many: "respuestas oficiales nuevas" },
  { key: "rules", one: "regla", many: "reglas" },
  { key: "examples", one: "ejemplo de buena respuesta", many: "ejemplos de buena respuesta" },
]

function AgentSummaryPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const canDecide = usePermission("agent.decide")
  const receptionName = useReceptionName()
  const [baseOpen, setBaseOpen] = useState(false)
  const [turnOffOpen, setTurnOffOpen] = useState(false)

  const overviewQuery = useQuery({
    queryKey: ["agent-overview"],
    queryFn: () => apiFetch<{ data: AgentOverview }>("/api/agent/overview"),
    enabled: canRead,
    retry: false,
  })
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    select: (body) => ({ data: namedAgentRoles(body.data, receptionName) }),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    enabled: canRead,
  })
  // Argos se enciende aparte: lo suyo sale de su propio resumen.
  const adminQuery = useQuery({
    queryKey: ["agent-admin", "overview"],
    queryFn: () => apiFetch<{ data: AdminOverview }>("/api/agent/admin/overview"),
    enabled: canRead,
    retry: false,
  })
  const admin = adminQuery.data?.data
  const adminOn = admin?.enabled === true
  useOrgEvents(
    ["agent.run.recorded", "agent.proposal.created", "agent.proposal.decided", "agent.handoff.created", "stream.reconnected"],
    () => void queryClient.invalidateQueries({ queryKey: ["agent-overview"] }),
  )

  const turnOff = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => {
      for (const key of ["agent-config", "agent-overview", "agent-summary"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      setTurnOffOpen(false)
    },
  })

  if (!canRead) {
    // No es un error: la sección existe y esta persona no la administra. Quien
    // decide por el agente conserva sus pendientes, y aquí tiene cómo llegar.
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title="Agente" />
        <AgentTabs />
        <EmptyState
          icon={Lock}
          title="No tienes acceso a esta sección"
          description={`Pídelo a quien administra la clínica.${canDecide ? " Las citas que esperan su sí siguen en «Esperan su sí»." : ""}`}
          {...(canDecide ? { actionLabel: "Ir a Esperan su sí", onAction: () => void navigate({ to: "/agent/pendientes" }) } : {})}
        />
      </PageShell>
    )
  }

  const overview = overviewQuery.data?.data
  const roles = rolesQuery.data?.data
  const config = configQuery.data?.data

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle="Cómo va y qué necesita de ti." />
      <CapReachedNotice />
      <AgentTabs />
      {overviewQuery.isPending || rolesQuery.isPending ? (
        <SkeletonRegion message="Cargando el resumen…">
          <AgentOverviewSkeleton />
        </SkeletonRegion>
      ) : overviewQuery.isError || !overview ? (
        <QueryErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />
      ) : (
        <>
          {overview.enabled && overview.provider.problem ? (
            <SummaryNotice
              tone="danger"
              title={agentModelDown(receptionName).title}
            >
              {agentModelDown(receptionName).body}
              {overview.provider.at ? ` El último intento falló ${timeAgo(overview.provider.at)}.` : ""}
            </SummaryNotice>
          ) : null}

          <AgentSurface aria-labelledby="necesita" className="flex flex-col gap-2 p-3 sm:gap-3.5 sm:p-5">
            <div className="flex items-center gap-3">
              <AgentMark className="max-sm:hidden" />
              <div>
                <h2 id="necesita" className="font-heading text-base font-bold sm:text-lg">
                  Necesita de ti
                </h2>
                <p className="text-sm text-muted-foreground max-sm:hidden">Lo que solo una persona puede decidir.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-3">
              <NeedTile
                count={overview.needsYou.review}
                title="Respuestas por revisar"
                pending="Las dudosas y una muestra al azar."
                done="Nada dudoso por revisar."
                to="/agent/learn"
              />
              <NeedTile
                count={overview.needsYou.lessons}
                title="Lecciones por aprobar"
                pending="Lo que propone aprender de tus correcciones."
                done="Ninguna lección espera tu aprobación."
                to="/agent/learn"
              />
              {/* Las preguntas básicas que faltan se responden en el mismo sitio: van en esta ficha, sin una quinta. */}
              <NeedTile
                count={overview.needsYou.gaps}
                title="Preguntas sin respuesta"
                pending={`Lo que le preguntaron y no sabía.${overview.needsYou.basicsMissing > 0 ? ` Además faltan ${overview.needsYou.basicsMissing} de las ${overview.knows.basicsTotal} básicas.` : ""}`}
                done={
                  overview.needsYou.basicsMissing > 0
                    ? `Faltan ${overview.needsYou.basicsMissing} de las ${overview.knows.basicsTotal} preguntas básicas.`
                    : "Encontró respuesta a todo lo que buscó."
                }
                to="/agent/knowledge"
              />
            </div>
          </AgentSurface>

          <section aria-labelledby="tus-agentes" className="elevated flex flex-col rounded-xl border bg-card">
            <h2 id="tus-agentes" className="px-4 pt-3 font-heading text-base font-bold sm:px-6 sm:pt-5 sm:text-lg">
              Tus agentes
            </h2>
            <div className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted/60 px-3.5 py-2 sm:mx-6 sm:mt-3 sm:py-3">
              <div className="min-w-0 flex-1 basis-36 sm:basis-48">
                <p className="font-bold">La base que comparten los tres</p>
                <p className="text-sm text-muted-foreground max-sm:hidden">
                  Quién es, cómo decide y la voz de tu clínica. Lo demás es de cada agente y no se mezcla.
                </p>
              </div>
              <Button type="button" variant="link" className="min-h-11 px-0 font-semibold sm:min-h-9" onClick={() => setBaseOpen(true)} disabled={!config || !roles}>
                Ver la base <ArrowRight aria-hidden />
              </Button>
            </div>
            <ul className="flex flex-col divide-y sm:mt-1">
              {(roles?.roles ?? []).map((role) => {
                if (role.id === "ayuda") return null
                const to = ROLE_PAGE[role.id]
                const isReception = role.id === "recepcion"
                // `null`: el agente todavía no existe para esta clínica; no hay nada que encender.
                const on = !role.available
                  ? null
                  : isReception
                    ? overview.enabled
                    : role.id === "administrador"
                      ? adminOn
                      : config?.clinicalAssistantEnabled === true
                const channels = overview.readiness.channels
                return (
                  <li key={role.id} className="px-4 sm:px-6">
                    {/* Teléfono: una fila que lleva a la página del agente; ahí se prueba, se configura y se enciende. */}
                    {on === null ? (
                      <div className="flex min-h-13 flex-col justify-center sm:hidden">
                        <span className="font-semibold">{role.name}</span>
                        <span className="text-sm text-muted-foreground">Aún no disponible</span>
                      </div>
                    ) : (
                      <Link to={to} className="flex min-h-13 items-center gap-2.5 sm:hidden">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-semibold">{role.name}</span>
                          <span className={cn("text-sm", on ? "font-bold text-success" : "text-muted-foreground")}>
                            {on
                              ? "Encendido"
                              : canWrite
                                ? "Apagado · ver y encender"
                                : "Apagado · ver"}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    )}
                    <div className="flex flex-wrap items-center gap-3 py-4 max-sm:hidden">
                      <span
                        className={cn(
                          "flex size-10 shrink-0 items-center justify-center rounded-xl [&>svg]:size-5",
                          on ? "bg-primary-soft text-primary-soft-foreground" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {ROLE_ICON[role.id]}
                      </span>
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="flex flex-wrap items-center gap-2 font-bold">
                          {role.name}
                          <Badge variant={on ? "success" : "secondary"}>{on === null ? "Aún no disponible" : on ? "Encendido" : "Apagado"}</Badge>
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {isReception && on
                            ? `Responde por ${
                                channels.length ? channels.map((channel) => channelLabel(channel)).join(", ") : "ningún canal: falta conectar uno"
                              }`
                            : role.id === "administrador" && on && admin
                              ? adminSummary(admin)
                              : role.role}
                        </p>
                      </div>
                      {on === null ? null : on ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {isReception && canWrite ? (
                            <Link to="/agent/recepcion" hash="probar" className={outlineLink}>
                              Probar
                            </Link>
                          ) : null}
                          <Link to={to} className={outlineLink}>
                            {canWrite ? "Configurar" : "Ver"}
                          </Link>
                          {isReception && canWrite ? (
                            <Switch checked aria-label={`Apagar a ${receptionName}`} onCheckedChange={(next) => (next ? undefined : setTurnOffOpen(true))} />
                          ) : null}
                        </div>
                      ) : (
                        <Link to={to} className={cn(outlineLink, canWrite && "border-primary text-primary-soft-foreground")}>
                          {canWrite ? "Ver y encender" : "Ver"}
                        </Link>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          <WritingHoursCard canWrite={canWrite} />

          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <section aria-label="Cómo le fue esta semana" className="elevated flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 sm:gap-3 sm:p-6">
              <div>
                <h2 className="font-heading text-base font-bold sm:text-lg">
                  <span className="sm:hidden">Esta semana</span>
                  <span className="max-sm:hidden">Cómo le fue esta semana</span>
                </h2>
                <p className="text-sm text-muted-foreground">
                  {overview.week.attended > 0 ? (
                    <>
                      {overview.week.attended} {overview.week.attended === 1 ? "conversación atendida" : "conversaciones atendidas"}
                      <span className="max-sm:hidden">. Cuenta el resultado, no los mensajes.</span>
                    </>
                  ) : overview.enabled ? (
                    "Todavía no atendió ninguna conversación esta semana."
                  ) : (
                    "Está apagado: no atendió conversaciones esta semana."
                  )}
                </p>
              </div>
              {overview.week.attended > 0 ? (
                <WeekOutcomes week={overview.week} />
              ) : !overview.enabled && canWrite ? (
                <Link to="/agent/recepcion" className={cn(outlineLink, "self-start")}>
                  Ver y encender
                </Link>
              ) : null}
            </section>

            <section aria-labelledby="aprendio" className="elevated flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:p-6">
              <div>
                <h2 id="aprendio" className="font-heading text-base font-bold sm:text-lg">
                  Lo que aprendió esta semana
                </h2>
                <p className="text-sm text-muted-foreground">
                  {overview.learned.latest ? "Todo lo aprobó una persona de tu equipo." : "Esta semana no se aprobó ninguna lección."}
                </p>
              </div>
              {overview.learned.latest ? (
                <>
                  <ul className="flex flex-col gap-1.5">
                    {LEARNED_ROWS.map((row) => (
                      <li key={row.key} className="flex items-center gap-2.5">
                        <strong className="w-6 shrink-0 font-heading text-lg tabular-nums">{overview.learned[row.key]}</strong>
                        <span>{overview.learned[row.key] === 1 ? row.one : row.many}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-col gap-0.5 rounded-xl bg-muted/60 px-3.5 py-3">
                    <span className="text-xs font-bold text-muted-foreground">La más reciente</span>
                    <span className="break-words">
                      «{overview.learned.latest.title}»{" "}
                      {overview.learned.latest.approvedByName
                        ? `La aprobó ${overview.learned.latest.approvedByName} ${approvedDay(overview.learned.latest.approvedAt)}.`
                        : `Se aprobó ${approvedDay(overview.learned.latest.approvedAt)}.`}
                    </span>
                  </div>
                </>
              ) : null}
              <Link to="/agent/learn" className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-primary hover:underline sm:min-h-8">
                Ver todo lo aprendido <ArrowRight className="size-4" aria-hidden />
              </Link>
            </section>
          </div>

          <Link
            to="/agent/registro"
            className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-muted-foreground underline hover:text-foreground sm:min-h-8"
          >
            Registro técnico: ejecuciones, costo y proveedor del modelo
          </Link>

          {config && roles ? (
            <AgentBaseDrawer
              open={baseOpen}
              onClose={() => setBaseOpen(false)}
              config={config}
              principles={roles.principles}
              clinicName={org.name}
              canWrite={canWrite}
            />
          ) : null}
          <ConfirmDialog
            open={turnOffOpen}
            title={`Apagar a ${receptionName}`}
            description="Deja de responder en todos los canales. Las conversaciones abiertas y lo que esté a medias quedan para tu equipo."
            confirmLabel="Apagar"
            pending={turnOff.isPending}
            onClose={() => {
              if (!turnOff.isPending) setTurnOffOpen(false)
            }}
            onConfirm={() => turnOff.mutate()}
          >
            {turnOff.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitErrorMessage(turnOff.error)}
              </p>
            ) : null}
          </ConfirmDialog>
        </>
      )}
    </PageShell>
  )
}

/**
 * Tres tramos que suman las conversaciones atendidas. La barra es un dibujo de
 * la lista de abajo: el texto alternativo y la lista dicen lo mismo con números.
 */
function WeekOutcomes({ week }: { week: AgentOverview["week"] }) {
  const parts = [
    { label: "Las resolvió sola", count: week.alone, color: "bg-primary" },
    { label: "Las pasó a una persona", count: week.passed, color: "bg-chart-1" },
    { label: "Se las corregiste", count: week.corrected, color: "bg-warning/60" },
  ]
  return (
    <>
      <div
        className="flex h-3 gap-[3px] overflow-hidden rounded-full sm:h-3.5"
        role="img"
        aria-label={`${week.alone} las resolvió sola, ${week.passed} las pasó a una persona, ${week.corrected} se las corregiste`}
      >
        {parts.map((part) => (part.count > 0 ? <span key={part.label} className={cn("rounded-[4px]", part.color)} style={{ flex: `${part.count} 1 0` }} /> : null))}
      </div>
      <dl className="flex flex-col gap-1 text-sm sm:gap-1.5 sm:text-base">
        {parts.map((part) => (
          <div key={part.label} className="flex items-center gap-2.5">
            <span aria-hidden className={cn("size-3 shrink-0 rounded-[4px]", part.color)} />
            <dt className="flex-1">{part.label}</dt>
            <dd className="font-bold tabular-nums">{part.count}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t pt-2.5 text-sm sm:text-base">
        {week.booked > 0 ? (
          <>
            Reservó{" "}
            <strong>
              {week.booked} {week.booked === 1 ? "cita" : "citas"}
            </strong>{" "}
            sin que nadie interviniera.
          </>
        ) : (
          "No reservó citas por su cuenta esta semana."
        )}
      </p>
      <p className="text-xs text-muted-foreground">Que nadie interviniera no prueba que el caso quedara bien resuelto.</p>
    </>
  )
}
