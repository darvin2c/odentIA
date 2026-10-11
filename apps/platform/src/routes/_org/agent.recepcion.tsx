import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { ChevronDown, Lock } from "lucide-react"
import { type ReactNode, useState } from "react"
import { AgentBaseDrawer } from "../../components/agent/base-drawer"
import { FunctionNoteDrawer, InstructionsDrawer, LimitsDrawer } from "../../components/agent/reception-drawers"
import { AgentSandbox } from "../../components/agent/sandbox"
import { TurnOnDrawer } from "../../components/agent/turn-on-drawer"
import {
  type AgentFunction,
  type AgentLevelId,
  type AgentOverview,
  type AgentRoles,
  LEVEL_LABEL,
  minutesToClock,
} from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type AgentConfig, usePermission } from "../../lib/crm"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/recepcion")({
  component: ReceptionPage,
})
const orgRouteApi = getRouteApi("/_org")

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"
const TREATMENT_LABEL = { tu: "de tú", usted: "de usted" } as const
const TONE_LABEL = { cercano: "cercano", neutro: "neutro", formal: "formal" } as const

function Card({ id, title, hint, action, children }: { id: string; title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <h2 id={id} className="font-heading text-base font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function ReceptionPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [noteFor, setNoteFor] = useState<AgentFunction | null>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [turnOnOpen, setTurnOnOpen] = useState(false)
  const [turnOffOpen, setTurnOffOpen] = useState(false)
  const [levelToConfirm, setLevelToConfirm] = useState<AgentLevelId | null>(null)

  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const overviewQuery = useQuery({
    queryKey: ["agent-overview"],
    queryFn: () => apiFetch<{ data: AgentOverview }>("/api/agent/overview"),
    enabled: canRead,
    retry: false,
  })
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    enabled: canRead,
  })

  function refresh() {
    for (const key of ["agent-config", "agent-overview", "agent-policy", "agent-panel"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  // Los interruptores guardan al momento; mientras viaja se muestra lo pedido.
  const toggleFunction = useMutation({
    retry: false,
    mutationFn: (disabledFunctions: string[]) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ disabledFunctions }) }),
    onSettled: refresh,
  })
  const changeLevel = useMutation({
    retry: false,
    mutationFn: (level: AgentLevelId) => apiFetch("/api/agent/level", { method: "PUT", body: JSON.stringify({ level }) }),
    onSuccess: () => setLevelToConfirm(null),
    onSettled: refresh,
  })
  const turnOff = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => {
      refresh()
      setTurnOffOpen(false)
    },
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso a la configuración del agente." />
      </PageShell>
    )
  }

  const roles = rolesQuery.data?.data
  const overview = overviewQuery.data?.data
  const config = configQuery.data?.data
  const role = roles?.roles.find((item) => item.id === "recepcion")
  const pending = rolesQuery.isPending || overviewQuery.isPending || configQuery.isPending
  const failed = rolesQuery.isError ? rolesQuery : overviewQuery.isError ? overviewQuery : configQuery.isError ? configQuery : null

  if (pending || failed || !roles || !overview || !config || !role) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title="Recepción" />
        {pending ? (
          <LoadingState message="Cargando a Recepción…" />
        ) : (
          <QueryErrorState error={failed?.error} onRetry={() => void (failed ?? rolesQuery).refetch()} />
        )}
      </PageShell>
    )
  }

  const disabled = toggleFunction.isPending && toggleFunction.variables ? toggleFunction.variables : config.disabledFunctions
  const activeLevel = changeLevel.isPending && changeLevel.variables ? changeLevel.variables : overview.level
  const hours =
    config.activeFromMin !== null && config.activeUntilMin !== null
      ? `De ${minutesToClock(config.activeFromMin)} a ${minutesToClock(config.activeUntilMin)}`
      : "A toda hora"
  const channels = config.channels ?? overview.readiness.channels
  const voice = [
    config.personaName ? `Se presenta como ${config.personaName}` : "Sin nombre propio",
    TREATMENT_LABEL[config.treatment ?? "tu"],
    `tono ${TONE_LABEL[config.tone]}`,
  ].join(" · ")

  function pickLevel(level: AgentLevelId) {
    if (!canWrite || changeLevel.isPending || level === overview?.level) return
    // Subir al máximo o pisar un ajuste acto por acto se confirma; lo demás se aplica y se deshace igual de fácil.
    if (level === "autonomo" || overview?.level === "personalizado") setLevelToConfirm(level)
    else changeLevel.mutate(level)
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Recepción"
        subtitle={role.audience}
        actions={
          canWrite ? (
            <label htmlFor="recepcion-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
              {overview.enabled ? "Encendido" : "Apagado"}
              <Switch
                id="recepcion-encendido"
                checked={overview.enabled}
                aria-label={overview.enabled ? "Apagar Recepción" : "Encender Recepción"}
                onCheckedChange={(next) => (next ? setTurnOnOpen(true) : setTurnOffOpen(true))}
              />
            </label>
          ) : (
            <Badge variant={overview.enabled ? "success" : "secondary"}>{overview.enabled ? "Encendido" : "Apagado"}</Badge>
          )
        }
      />
      <Link to="/agent" className={`-mt-3 w-fit ${LINK}`}>
        Volver al resumen del agente
      </Link>
      <p className="-mt-2 max-w-prose text-sm">{role.role}</p>

      {/* Dos columnas según el ancho del contenido, no de la ventana: con la columna lateral abierta vuelve a una. */}
      <div className="@container min-w-0">
      <div className="grid min-w-0 items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card id="que-hace" title="Qué hace" hint="Lo que apagues deja de hacerlo: pierde esa capacidad, no solo la instrucción.">
            <ul className="flex flex-col divide-y">
              {role.functions.map((fn) => {
                const on = fn.fixed || !disabled.includes(fn.id)
                const note = config.functionNotes[fn.id]
                return (
                  <li key={fn.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{fn.label}</p>
                      <p className="text-sm text-muted-foreground">{on ? fn.description : (fn.offNote ?? "Apagada.")}</p>
                      {on && fn.steps ? (
                        <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
                          {fn.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      ) : null}
                      {on && fn.fills.length > 0 ? (
                        <Collapsible className="mt-1">
                          <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline sm:min-h-8">
                            Qué datos puede llenar
                            <ChevronDown className="size-4 transition-transform group-data-[panel-open]:rotate-180" aria-hidden />
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <ul className="flex flex-col gap-1 pb-1 text-sm text-muted-foreground">
                              {fn.fills.map((fill) => (
                                <li key={fill.operation}>
                                  <span className="font-medium text-foreground">{fill.label}:</span>{" "}
                                  {fill.fields.map((field) => field.label.toLowerCase()).join(", ")}.
                                </li>
                              ))}
                            </ul>
                            <p className="pb-1 text-xs text-muted-foreground">Son los mismos campos y las mismas reglas que en la pantalla.</p>
                          </CollapsibleContent>
                        </Collapsible>
                      ) : null}
                      {on && note ? (
                        <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
                          <span className="font-semibold">Tu indicación:</span> {note}
                        </p>
                      ) : null}
                      {on && canWrite ? (
                        <Button type="button" variant="link" size="sm" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={() => setNoteFor(fn)}>
                          {note ? "Cambiar la indicación" : "Añadir una indicación"}
                        </Button>
                      ) : null}
                    </div>
                    {fn.fixed ? (
                      <span className="inline-flex min-h-8 shrink-0 items-center gap-1 text-sm text-muted-foreground">
                        <Lock className="size-3.5" aria-hidden /> Siempre
                      </span>
                    ) : (
                      <Switch
                        checked={on}
                        disabled={!canWrite || toggleFunction.isPending}
                        aria-label={fn.label}
                        onCheckedChange={(next) =>
                          toggleFunction.mutate(
                            next ? config.disabledFunctions.filter((id) => id !== fn.id) : [...config.disabledFunctions, fn.id],
                          )
                        }
                      />
                    )}
                  </li>
                )
              })}
            </ul>
            {toggleFunction.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(toggleFunction.error)}
              </p>
            ) : null}
          </Card>

          <Card id="hasta-donde" title="Hasta dónde llega solo" hint="Qué hace por su cuenta y qué espera a una persona.">
            <fieldset className="m-0 min-w-0 border-0 p-0 grid gap-2 sm:grid-cols-3" aria-label="Nivel de autonomía">
              {roles.levels.map((level) => (
                <Button
                  key={level.id}
                  type="button"
                  variant="outline"
                  aria-pressed={activeLevel === level.id}
                  disabled={!canWrite || changeLevel.isPending}
                  onClick={() => pickLevel(level.id)}
                  className={`h-auto min-h-11 flex-col items-start justify-start gap-1 whitespace-normal rounded-xl p-3 text-left disabled:opacity-100 ${activeLevel === level.id ? "border-primary bg-primary-soft" : ""}`}
                >
                  <span className="font-semibold">{level.label}</span>
                  <span className="text-sm font-normal text-muted-foreground">{level.summary}</span>
                </Button>
              ))}
            </fieldset>
            {overview.level === "personalizado" ? (
              <p className="text-sm">
                <span className="font-semibold">{LEVEL_LABEL.personalizado}:</span> lo ajustaste acto por acto en Ajustes técnicos. Elegir un nivel lo
                reemplaza.
              </p>
            ) : null}
            {changeLevel.isError && !levelToConfirm ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(changeLevel.error)}
              </p>
            ) : null}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Pasa siempre a una persona</dt>
                <dd className="text-muted-foreground">
                  Cuando duda, cuando se lo piden
                  {config.handoffKeywords.length > 0 ? ` o cuando mencionan: ${config.handoffKeywords.join(", ")}.` : "."}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Dónde y cuándo responde</dt>
                <dd className="text-muted-foreground">
                  {channels.length > 0 ? channels.map((channel) => channelLabel(channel)).join(", ") : "Sin canal conectado"} · {hours}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-semibold">Nunca</dt>
                <dd className="text-muted-foreground">{role.never}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-x-6">
              {canWrite ? (
                <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setLimitsOpen(true)}>
                  Cambiar los límites
                </Button>
              ) : null}
              {overview.readiness.channels.length === 0 && canWrite ? (
                <Link to="/settings/channels" className={LINK}>
                  Conectar un canal
                </Link>
              ) : null}
            </div>
          </Card>

          <Card
            id="que-sabe"
            title="Qué sabe"
            hint="Responde solo con esto. Lo que no encuentra, lo dice y lo anota para ti."
            action={
              <Link to="/agent/knowledge" className={LINK}>
                {canWrite ? "Abrir Conocimiento" : "Ver Conocimiento"}
              </Link>
            }
          >
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Respuestas oficiales</dt>
                <dd className="font-heading text-xl font-bold tabular-nums">{overview.knows.answers}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Servicios con precio</dt>
                <dd className="font-heading text-xl font-bold tabular-nums">{overview.knows.servicesWithPrice}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sedes</dt>
                <dd className="font-heading text-xl font-bold tabular-nums">{overview.knows.branches}</dd>
              </div>
            </dl>
            <p className="text-sm">
              Lo básico de tu clínica: {overview.knows.basicsCovered} de {overview.knows.basicsTotal}
              {overview.needsYou.gaps > 0
                ? ` · ${overview.needsYou.gaps} ${overview.needsYou.gaps === 1 ? "pregunta sin respuesta" : "preguntas sin respuesta"}`
                : ""}
              .
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Ve</dt>
                <dd className="text-muted-foreground">{role.sees}</dd>
              </div>
              <div>
                <dt className="font-semibold">No ve</dt>
                <dd className="text-muted-foreground">{role.notSees}</dd>
              </div>
            </dl>
          </Card>

          <Card id="como-se-comporta" title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después lo que le pides tú.">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 p-4">
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-semibold">La base</p>
                <p className="text-sm text-muted-foreground">{voice}</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setBaseOpen(true)}>
                Ver la base
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-semibold">Indicaciones de tu clínica</p>
              {config.systemPrompt.trim() ? (
                <p className="line-clamp-6 whitespace-pre-wrap text-sm text-muted-foreground">{config.systemPrompt}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Todavía no le diste ninguna. Con la base y lo que sabe ya puede atender.</p>
              )}
              {canWrite ? (
                <Button type="button" variant="outline" size="sm" className="mt-1 min-h-11 self-start sm:min-h-8" onClick={() => setInstructionsOpen(true)}>
                  {config.systemPrompt.trim() ? "Cambiar las indicaciones" : "Escribir indicaciones"}
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Quién confirma:</span> {role.confirms}
            </p>
          </Card>

          {canWrite ? (
            <Link to="/settings/agent" className={`w-fit ${LINK}`}>
              Ajustes técnicos: proveedor del modelo, tope diario y autonomía acto por acto
            </Link>
          ) : null}
        </div>

        {canWrite ? (
          <div className="min-w-0 @5xl:sticky @5xl:top-4">
            <AgentSandbox onTested={() => void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })} />
          </div>
        ) : null}
      </div>
      </div>

      <FunctionNoteDrawer fn={noteFor} config={config} onClose={() => setNoteFor(null)} />
      <LimitsDrawer open={limitsOpen} onClose={() => setLimitsOpen(false)} config={config} connectedChannels={overview.readiness.channels} />
      <InstructionsDrawer open={instructionsOpen} onClose={() => setInstructionsOpen(false)} config={config} />
      <AgentBaseDrawer
        open={baseOpen}
        onClose={() => setBaseOpen(false)}
        config={config}
        principles={roles.principles}
        clinicName={org.name}
        canWrite={canWrite}
      />
      <TurnOnDrawer
        open={turnOnOpen}
        onClose={() => setTurnOnOpen(false)}
        overview={overview}
        levels={roles.levels}
        onTest={() => {
          setTurnOnOpen(false)
          document.getElementById("probar")?.scrollIntoView({ block: "start" })
        }}
      />
      <ConfirmDialog
        open={levelToConfirm !== null}
        title={levelToConfirm ? `Pasar a ${LEVEL_LABEL[levelToConfirm]}` : "Cambiar el nivel"}
        description={
          overview.level === "personalizado"
            ? "Reemplaza lo que ajustaste acto por acto. Puedes volver a ajustarlo en Ajustes técnicos."
            : (roles.levels.find((level) => level.id === levelToConfirm)?.summary ?? "")
        }
        confirmLabel="Cambiar el nivel"
        variant="default"
        pending={changeLevel.isPending}
        onClose={() => {
          if (!changeLevel.isPending) {
            changeLevel.reset()
            setLevelToConfirm(null)
          }
        }}
        onConfirm={() => {
          if (levelToConfirm) changeLevel.mutate(levelToConfirm)
        }}
      >
        {changeLevel.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutationErrorMessage(changeLevel.error)}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={turnOffOpen}
        title="Apagar Recepción"
        description="Deja de responder en todos los canales. Las conversaciones abiertas y lo que esté a medias quedan para tu equipo."
        confirmLabel="Apagar"
        pending={turnOff.isPending}
        onClose={() => {
          if (!turnOff.isPending) {
            turnOff.reset()
            setTurnOffOpen(false)
          }
        }}
        onConfirm={() => turnOff.mutate()}
      >
        {turnOff.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutationErrorMessage(turnOff.error)}
          </p>
        ) : null}
      </ConfirmDialog>
    </PageShell>
  )
}
