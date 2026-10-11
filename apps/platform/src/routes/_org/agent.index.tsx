import { Badge, Button } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ArrowRight, BookOpen, CircleHelp, Lightbulb, MessageCircle, Mic, ShieldCheck } from "lucide-react"
import { type ReactNode, useState } from "react"
import type { AdvisorSettings } from "../../components/agent/advisor"
import { AgentBaseDrawer } from "../../components/agent/base-drawer"
import { TurnOnDrawer } from "../../components/agent/turn-on-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import { type AgentOverview, type AgentRole, type AgentRoles, LEVEL_LABEL } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type AgentConfig, usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/")({
  component: AgentSummaryPage,
})
const orgRouteApi = getRouteApi("/_org")

const ROLE_ICON: Record<AgentRole["id"], ReactNode> = {
  recepcion: <MessageCircle aria-hidden />,
  asistente_clinico: <Mic aria-hidden />,
  asesor: <Lightbulb aria-hidden />,
  ayuda: <CircleHelp aria-hidden />,
}

function NeedTile({ count, title, pending, done, to }: { count: number; title: string; pending: string; done: string; to: string }) {
  return (
    <Link
      to={to}
      className={`lift flex min-h-24 flex-col gap-1 rounded-xl border p-4 hover:bg-accent/60 ${count > 0 ? "border-primary/30 bg-primary-soft/40" : "bg-card"}`}
    >
      <span className="font-heading text-2xl font-bold tabular-nums">{count}</span>
      <span className="font-semibold">{title}</span>
      <span className="text-sm text-muted-foreground">{count > 0 ? pending : done}</span>
    </Link>
  )
}

function AgentSummaryPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [baseOpen, setBaseOpen] = useState(false)
  const [turnOnOpen, setTurnOnOpen] = useState(false)
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
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    enabled: canRead,
  })
  // El Asesor se enciende aparte: su estado sale de sus propios ajustes.
  const advisorQuery = useQuery({
    queryKey: ["agent-advisor-settings"],
    queryFn: () => apiFetch<{ data: AdvisorSettings }>("/api/agent/advisor/settings"),
    enabled: canRead,
    retry: false,
  })
  const advisorOn = advisorQuery.data?.data.enabled === true
  useOrgEvents(
    ["agent.run.recorded", "agent.proposal.created", "agent.proposal.decided", "agent.handoff.created", "stream.reconnected"],
    () => void queryClient.invalidateQueries({ queryKey: ["agent-overview"] }),
  )

  const turnOff = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => {
      for (const key of ["agent-config", "agent-overview", "agent-panel"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      setTurnOffOpen(false)
    },
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso al resumen del agente. Si decides sus propuestas, entra por Aprobaciones." />
      </PageShell>
    )
  }

  const overview = overviewQuery.data?.data
  const roles = rolesQuery.data?.data
  const config = configQuery.data?.data
  const limitReached = overview ? overview.usage.runsToday >= overview.usage.dailyRunLimit : false

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle="Cómo va y qué necesita de ti." />
      <AgentTabs />
      {overviewQuery.isPending || rolesQuery.isPending ? (
        <LoadingState message="Cargando el resumen…" />
      ) : overviewQuery.isError || !overview ? (
        <QueryErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />
      ) : (
        <>
          {limitReached && overview.enabled ? (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">Llegó al tope de hoy ({overview.usage.dailyRunLimit} respuestas).</span> Lo que entre
                desde ahora pasa a tu equipo hasta mañana.
              </span>
              {canWrite ? (
                <Link to="/settings/agent" className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline sm:min-h-8">
                  Cambiar el tope
                </Link>
              ) : null}
            </div>
          ) : null}

          <section aria-labelledby="necesita" className="flex flex-col gap-3">
            <div>
              <h2 id="necesita" className="font-heading text-base font-semibold">
                Necesita de ti
              </h2>
              <p className="text-sm text-muted-foreground">Lo que solo una persona puede decidir.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <NeedTile
                count={overview.needsYou.approvals}
                title="Aprobaciones"
                pending="Esperan tu visto bueno."
                done="Nada espera tu aprobación."
                to="/agent/approvals"
              />
              <NeedTile
                count={overview.needsYou.gaps}
                title="Preguntas sin respuesta"
                pending="Lo que le preguntaron y no sabía."
                done="Encontró respuesta a todo lo que buscó."
                to="/agent/knowledge"
              />
              <NeedTile
                count={overview.needsYou.basicsMissing}
                title="Preguntas básicas por responder"
                pending={`Tiene ${overview.knows.basicsCovered} de ${overview.knows.basicsTotal}.`}
                done="Lo básico de tu clínica está completo."
                to="/agent/knowledge"
              />
              <NeedTile
                count={overview.needsYou.review + overview.needsYou.lessons}
                title="Por revisar y aprender"
                pending={`${overview.needsYou.review} ${overview.needsYou.review === 1 ? "respuesta" : "respuestas"} por revisar y ${overview.needsYou.lessons} ${overview.needsYou.lessons === 1 ? "lección" : "lecciones"} por aprobar.`}
                done="Nada dudoso ni lecciones esperando."
                to="/agent/learn"
              />
            </div>
          </section>

          <section aria-labelledby="tus-agentes" className="elevated flex flex-col rounded-xl border bg-card">
            <h2 id="tus-agentes" className="px-5 pt-5 font-heading text-base font-semibold sm:px-6">
              Tus agentes
            </h2>
            <div className="mx-5 mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 p-4 sm:mx-6">
              <span className="shrink-0 text-primary-soft-foreground [&>svg]:size-5">
                <ShieldCheck aria-hidden />
              </span>
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-semibold">La base que comparten</p>
                <p className="text-sm text-muted-foreground">Lo que fija odentIA y la voz de tu clínica. Lo demás es de cada agente y no se mezcla.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setBaseOpen(true)} disabled={!config || !roles}>
                Ver la base
              </Button>
            </div>
            <ul className="flex flex-col divide-y">
              {(roles?.roles ?? []).map((role) => {
                const isReception = role.id === "recepcion"
                return (
                  <li key={role.id} className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-xl [&>svg]:size-5 ${isReception && overview.enabled ? "bg-primary-soft text-primary-soft-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {ROLE_ICON[role.id]}
                    </span>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        {role.name}
                        {isReception ? (
                          <Badge variant={overview.enabled ? "success" : "secondary"}>{overview.enabled ? "Encendido" : "Apagado"}</Badge>
                        ) : role.id === "asesor" && role.available ? (
                          <Badge variant={advisorOn ? "success" : "secondary"}>{advisorOn ? "Encendido" : "Apagado"}</Badge>
                        ) : role.id === "ayuda" && role.available ? (
                          <Badge variant="success">Siempre disponible</Badge>
                        ) : role.id === "asistente_clinico" && role.available ? (
                          <Badge variant={config?.clinicalAssistantEnabled ? "success" : "secondary"}>
                            {config?.clinicalAssistantEnabled ? "Encendido" : "Apagado"}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Aún no disponible</Badge>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {isReception && overview.enabled
                          ? `Nivel ${LEVEL_LABEL[overview.level]} · ${
                              config?.channels?.length
                                ? config.channels.map((channel) => channelLabel(channel)).join(", ")
                                : overview.readiness.channels.length
                                  ? overview.readiness.channels.map((channel) => channelLabel(channel)).join(", ")
                                  : "sin canal conectado"
                            }`
                          : role.role}
                      </p>
                    </div>
                    {isReception ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {canWrite ? (
                          <Link
                            to="/agent/recepcion"
                            hash="probar"
                            className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-accent/60 sm:min-h-9"
                          >
                            Probar
                          </Link>
                        ) : null}
                        <Link
                          to="/agent/recepcion"
                          className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-accent/60 sm:min-h-9"
                        >
                          {canWrite ? "Configurar" : "Ver"}
                        </Link>
                        {canWrite ? (
                          <Switch
                            checked={overview.enabled}
                            aria-label={overview.enabled ? "Apagar Recepción" : "Encender Recepción"}
                            onCheckedChange={(next) => (next ? setTurnOnOpen(true) : setTurnOffOpen(true))}
                          />
                        ) : null}
                      </div>
                    ) : role.id === "asistente_clinico" && role.available ? (
                      <Link
                        to="/agent/asistente-clinico"
                        className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-accent/60 sm:min-h-9"
                      >
                        {canWrite ? "Configurar" : "Ver"}
                      </Link>
                    ) : role.id === "asesor" && role.available ? (
                      <Link
                        to="/agent/asesor"
                        className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-accent/60 sm:min-h-9"
                      >
                        {canWrite ? "Configurar" : "Ver"}
                      </Link>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>

          <section aria-labelledby="semana" className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
            <div>
              <h2 id="semana" className="font-heading text-base font-semibold">
                Cómo le fue esta semana
              </h2>
              <p className="text-sm text-muted-foreground">
                {overview.week.attended > 0
                  ? `${overview.week.attended} ${overview.week.attended === 1 ? "conversación atendida" : "conversaciones atendidas"}. Cuenta conversaciones, no mensajes.`
                  : overview.enabled
                    ? "Todavía no atendió ninguna conversación esta semana."
                    : "Está apagado: no atendió conversaciones esta semana."}
              </p>
            </div>
            {overview.week.attended > 0 ? (
              <>
                <div
                  className="flex h-3 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${overview.week.alone} las llevó sola y ${overview.week.passed} las pasó a una persona`}
                >
                  <div className="bg-primary" style={{ width: `${(overview.week.alone / overview.week.attended) * 100}%` }} />
                  <div className="bg-warning" style={{ width: `${(overview.week.passed / overview.week.attended) * 100}%` }} />
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-primary" />
                    <dt className="flex-1">Las llevó sin intervención de tu equipo</dt>
                    <dd className="font-semibold tabular-nums">{overview.week.alone}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] bg-warning" />
                    <dt className="flex-1">Las pasó a una persona o alguien intervino</dt>
                    <dd className="font-semibold tabular-nums">{overview.week.passed}</dd>
                  </div>
                </dl>
                <p className="text-sm">
                  {overview.week.booked > 0
                    ? `Reservó ${overview.week.booked} ${overview.week.booked === 1 ? "cita" : "citas"} sin que nadie de tu equipo interviniera.`
                    : "No reservó citas por su cuenta esta semana."}
                </p>
                <p className="text-xs text-muted-foreground">Que no interviniera nadie no prueba que el caso quedara bien resuelto.</p>
              </>
            ) : !overview.enabled && canWrite ? (
              <Button type="button" className="min-h-11 self-start sm:min-h-9" onClick={() => setTurnOnOpen(true)}>
                Encender Recepción
              </Button>
            ) : null}
          </section>

          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <Link to="/agent/knowledge" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline sm:min-h-8">
              <BookOpen className="size-4" aria-hidden /> Lo que sabe: {overview.knows.answers} {overview.knows.answers === 1 ? "respuesta oficial" : "respuestas oficiales"}
            </Link>
            <Link to="/agent/registro" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline sm:min-h-8">
              Registro técnico: ejecuciones, costo y proveedor del modelo <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>

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
          {roles ? (
            <TurnOnDrawer
              open={turnOnOpen}
              onClose={() => setTurnOnOpen(false)}
              overview={overview}
              levels={roles.levels}
              onTest={() => {
                setTurnOnOpen(false)
                void navigate({ to: "/agent/recepcion", hash: "probar" })
              }}
            />
          ) : null}
          <ConfirmDialog
            open={turnOffOpen}
            title="Apagar Recepción"
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
                {mutationErrorMessage(turnOff.error) ?? "No pudimos apagarlo."}
              </p>
            ) : null}
          </ConfirmDialog>
        </>
      )}
    </PageShell>
  )
}
