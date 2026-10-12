import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { ConfirmDialog, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { ArrowRight, ChevronDown, ChevronRight, Lock, Plus } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { AgentBaseDrawer } from "../../components/agent/base-drawer"
import {
  FunctionNoteDrawer,
  InstructionDrawer,
  LimitsDrawer,
  type LimitsSection,
} from "../../components/agent/reception-drawers"
import { AgentSandbox } from "../../components/agent/sandbox"
import { TurnOnDrawer } from "../../components/agent/turn-on-drawer"
import { useAgentPanel } from "../../components/agent-panel"
import {
  type AgentFunction,
  type AgentLevelId,
  type AgentOverview,
  type AgentRoles,
  LEVEL_LABEL,
  type LearningOverview,
  minutesToClock,
  splitInstructions,
  voicePreview,
} from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type AgentConfig, usePermission } from "../../lib/crm"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/recepcion")({
  component: ReceptionPage,
})
const orgRouteApi = getRouteApi("/_org")

const LINK = "inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline sm:min-h-8"
const ROW =
  "flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
const TREATMENT_LABEL = { tu: "de tú", usted: "de usted" } as const
const TONE_LABEL = { cercano: "cercano", neutro: "neutro", formal: "formal" } as const
/** El mismo corte que `sm` de los estilos: por debajo, «Probar» es una pantalla propia. */
const PHONE = "(max-width: 639.98px)"

const count = (total: number, one: string, many: string) => `${total} ${total === 1 ? one : many}`

/**
 * Tarjeta de una sección. En teléfono la página es compacta: sin la línea de
 * ayuda y, con `phone`, la sección se resume en una fila que lleva a otra
 * pantalla (`to`) o despliega el contenido (`onToggle`).
 */
function Card({
  title,
  hint,
  phone,
  phoneExtra,
  children,
}: {
  title: string
  hint: string
  phone?: { summary: string; to?: "/agent/knowledge"; expanded?: boolean; onToggle?: () => void }
  /** Teléfono: lo que sigue a la fila-resumen aunque el contenido esté plegado. */
  phoneExtra?: ReactNode
  children: ReactNode
}) {
  const phoneRow = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-heading text-base font-semibold text-foreground">{title}</span>
        <span className="text-sm font-normal text-muted-foreground">{phone?.summary}</span>
      </span>
      {phone?.onToggle ? (
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${phone.expanded ? "rotate-180" : ""}`} aria-hidden />
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </>
  )
  const phoneRowClass = "flex min-h-11 w-full items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <section aria-label={title} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 max-sm:gap-3 sm:p-6">
      {phone ? (
        <h2 className="sm:hidden">
          {phone.to ? (
            <Link to={phone.to} className={phoneRowClass}>
              {phoneRow}
            </Link>
          ) : phone.onToggle ? (
            <Button
              type="button"
              variant="ghost"
              className={`${phoneRowClass} h-auto justify-start rounded-lg p-0 whitespace-normal hover:bg-transparent`}
              aria-expanded={phone.expanded}
              onClick={phone.onToggle}
            >
              {phoneRow}
            </Button>
          ) : (
            <span className={phoneRowClass}>{phoneRow}</span>
          )}
        </h2>
      ) : null}
      <div className={phone ? "max-sm:hidden" : undefined}>
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground max-sm:hidden">{hint}</p>
      </div>
      <div className={`flex min-w-0 flex-col gap-4 ${phone && !phone.expanded ? "max-sm:hidden" : ""}`}>{children}</div>
      {phoneExtra}
    </section>
  )
}

/** Fila con su entrada: lo que hay y, si se puede cambiar, a dónde lleva. */
function EntryRow({ label, value, onClick, to }: { label: string; value: string | null; onClick?: () => void; to?: "/agent/knowledge" | "/services" | "/branches" | "/agent/learn" }) {
  const content = (
    <>
      <span className="min-w-0 flex-[1_1_9rem] font-semibold">{label}</span>
      {value ? <span className="min-w-0 flex-[1_1_9rem] text-muted-foreground">{value}</span> : null}
      {onClick || to ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  )
  if (to)
    return (
      <Link to={to} className={`${ROW} hover:bg-muted`}>
        {content}
      </Link>
    )
  if (onClick)
    return (
      <Button type="button" variant="ghost" className={`${ROW} h-auto justify-start rounded-none font-normal whitespace-normal`} onClick={onClick}>
        {content}
      </Button>
    )
  return <div className={ROW}>{content}</div>
}

/** Una función de la ficha: su interruptor y, plegado, cómo trabaja y la indicación de la clínica. */
function FunctionRow({
  fn,
  on,
  note,
  canWrite,
  busy,
  onToggle,
  onEditNote,
}: {
  fn: AgentFunction
  on: boolean
  note: string | undefined
  canWrite: boolean
  busy: boolean
  onToggle: (next: boolean) => void
  onEditNote: () => void
}) {
  const [open, setOpen] = useState(false)
  const steps = fn.steps ?? []
  const hasDetail = on && (steps.length > 0 || fn.fills.length > 0 || Boolean(note) || canWrite)
  return (
    <li className="py-3 first:pt-0 last:pb-0 max-sm:py-1.5">
      <Collapsible open={open && hasDetail} onOpenChange={setOpen}>
        <div className="flex items-start gap-3 max-sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{fn.label}</p>
            <p className={`text-sm text-muted-foreground ${on ? "max-sm:hidden" : ""}`}>{on ? fn.description : (fn.offNote ?? "Apagada.")}</p>
            {hasDetail ? (
              <CollapsibleTrigger className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline sm:min-h-8">
                {open ? "Ocultar cómo trabaja" : "Ver cómo trabaja"}
                <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
                <span className="sr-only">: {fn.label}</span>
              </CollapsibleTrigger>
            ) : null}
          </div>
          {fn.fixed ? (
            <span className="inline-flex min-h-8 shrink-0 items-center gap-1 text-sm text-muted-foreground">
              <Lock className="size-3.5" aria-hidden /> Siempre
            </span>
          ) : (
            <Switch checked={on} disabled={!canWrite || busy} aria-label={fn.label} onCheckedChange={onToggle} />
          )}
        </div>
        <CollapsibleContent>
          <div className="mt-1 flex flex-col gap-3 rounded-xl bg-muted/60 p-4 text-sm">
            {steps.length > 0 ? (
              <ol className="flex list-decimal flex-col gap-0.5 pl-5">
                {steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            {fn.fills.length > 0 ? (
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Qué datos puede llenar</p>
                <ul className="flex flex-col gap-1">
                  {fn.fills.map((fill) => (
                    <li key={fill.operation}>
                      <span className="font-medium">{fill.label}:</span>{" "}
                      <span className="text-muted-foreground">{fill.fields.map((field) => field.label.toLowerCase()).join(", ")}.</span>
                    </li>
                  ))}
                </ul>
                <p className="pt-1 text-xs text-muted-foreground">Son los mismos campos y las mismas reglas que en la pantalla.</p>
              </div>
            ) : null}
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Tu indicación para esta función</p>
              <div className="flex items-start gap-3">
                <p className={`min-w-0 flex-1 py-1 ${note ? "" : "text-muted-foreground"}`}>{note ? `«${note}»` : "Todavía no le diste ninguna."}</p>
                {canWrite ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto min-h-11 shrink-0 p-0 sm:min-h-8"
                    aria-label={`${note ? "Editar" : "Agregar"} la indicación de «${fn.label}»`}
                    onClick={onEditNote}
                  >
                    {note ? "Editar" : "Agregar"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function ReceptionPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const agentPanel = useAgentPanel()
  const [noteFor, setNoteFor] = useState<AgentFunction | null>(null)
  const [limits, setLimits] = useState<LimitsSection | null>(null)
  const [instruction, setInstruction] = useState<number | "nueva" | null>(null)
  const [baseOpen, setBaseOpen] = useState(false)
  const [turnOnOpen, setTurnOnOpen] = useState(false)
  const [turnOffOpen, setTurnOffOpen] = useState(false)
  const [levelToConfirm, setLevelToConfirm] = useState<AgentLevelId | null>(null)
  const [behaviorOpen, setBehaviorOpen] = useState(false)
  // Teléfono: «Probar» abierto como pantalla propia.
  const [testing, setTesting] = useState(false)
  const testButtonRef = useRef<HTMLButtonElement>(null)

  // Quien llega desde el resumen con «Probar» (`#probar`) entra, en teléfono, a esa pantalla.
  // Al ensanchar la ventana «Probar» vuelve a su sitio junto a la página.
  useEffect(() => {
    const phone = window.matchMedia(PHONE)
    if (phone.matches && window.location.hash === "#probar") setTesting(true)
    const onChange = () => {
      if (!phone.matches) setTesting(false)
    }
    phone.addEventListener("change", onChange)
    return () => phone.removeEventListener("change", onChange)
  }, [])

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
  // Solo para decir cuántas lecciones tiene: mientras no llega, la fila va sin cifra.
  const learningQuery = useQuery({
    queryKey: ["agent-learning"],
    queryFn: () => apiFetch<{ data: LearningOverview }>("/api/agent/learning"),
    enabled: canRead,
    retry: false,
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
  const channelsText = channels.length > 0 ? channels.map((channel) => channelLabel(channel)).join(", ") : "Sin canal conectado"
  const dailyLimit = count(config.dailyRunLimit, "respuesta", "respuestas")
  const voice = [
    config.personaName ? `Se presenta como ${config.personaName}` : "Sin nombre propio",
    `trata ${TREATMENT_LABEL[config.treatment ?? "tu"]}`,
    `tono ${TONE_LABEL[config.tone]}`,
  ].join(" · ")
  const instructions = splitInstructions(config.systemPrompt)
  const levelSummary =
    activeLevel === "personalizado"
      ? `${LEVEL_LABEL.personalizado}: lo ajustaste acto por acto en Ajustes técnicos. Elegir un nivel lo reemplaza.`
      : (roles.levels.find((level) => level.id === activeLevel)?.summary ?? "")
  const lessons = learningQuery.data?.data.learned.filter((lesson) => lesson.agent === "recepcion").length
  const { today, knows } = overview
  const gaps = overview.needsYou.gaps
  const status = overview.enabled ? "Encendido" : "Apagado"
  // En la pantalla de «Probar» del teléfono lo demás no se muestra.
  const besideTest = testing ? "max-sm:hidden" : ""

  function pickLevel(level: AgentLevelId) {
    if (!canWrite || changeLevel.isPending || level === overview?.level) return
    // Subir al máximo o pisar un ajuste acto por acto se confirma; lo demás se aplica y se deshace igual de fácil.
    if (level === "autonomo" || overview?.level === "personalizado") setLevelToConfirm(level)
    else changeLevel.mutate(level)
  }

  /** «Probar» desde otra superficie: en teléfono abre su pantalla; al lado de la página, la acerca. */
  function openTest() {
    if (window.matchMedia(PHONE).matches) setTesting(true)
    else document.getElementById("probar")?.scrollIntoView({ block: "start" })
  }

  const gapNotice =
    gaps > 0 ? (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-warning-soft px-4 py-3 text-sm">
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-semibold">{count(gaps, "pregunta que no supo responder", "preguntas que no supo responder")}</p>
          <p className="text-muted-foreground max-sm:hidden">{gaps === 1 ? "Respóndela una vez y ya la sabe." : "Respóndelas una vez y ya las sabe."}</p>
        </div>
        {canWrite ? (
          <Link to="/agent/knowledge" className={LINK}>
            Enseñarle
          </Link>
        ) : null}
      </div>
    ) : null

  return (
    <PageShell className={`flex flex-col gap-6 ${canWrite && !testing ? "max-sm:pb-24" : ""}`}>
      <Breadcrumb className={`-mb-3 ${besideTest}`}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/agent" />} className="inline-flex min-h-11 items-center sm:min-h-0">
              Agente
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Recepción</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader
        className={besideTest}
        title="Recepción"
        subtitle={
          <>
            <span className="max-sm:hidden">{role.role}</span>
            <span className="truncate sm:hidden">
              {status} · {count(today.attended, "conversación hoy", "conversaciones hoy")}
            </span>
          </>
        }
        actions={
          canWrite ? (
            <label htmlFor="recepcion-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
              <span className="max-sm:hidden">{status}</span>
              <Switch
                id="recepcion-encendido"
                checked={overview.enabled}
                aria-label={overview.enabled ? "Apagar Recepción" : "Encender Recepción"}
                onCheckedChange={(next) => (next ? setTurnOnOpen(true) : setTurnOffOpen(true))}
              />
            </label>
          ) : (
            <Badge variant={overview.enabled ? "success" : "secondary"} className="max-sm:hidden">
              {status}
            </Badge>
          )
        }
      />

      {/* Hoy: lo que pasó en conversaciones, no en mensajes. En teléfono va resumido en la cabecera. */}
      <section
        aria-label="Hoy"
        className={`elevated flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm max-sm:hidden sm:px-6 ${besideTest}`}
      >
        <h2 className="font-heading text-base font-semibold">Hoy</h2>
        <p>
          <strong className="font-heading text-base font-bold tabular-nums">{today.attended}</strong>{" "}
          {today.attended === 1 ? "conversación atendida" : "conversaciones atendidas"}
        </p>
        <p>
          <strong className="font-heading text-base font-bold tabular-nums">{today.booked}</strong>{" "}
          {today.booked === 1 ? "cita reservada" : "citas reservadas"}
        </p>
        <p>
          <strong className="font-heading text-base font-bold tabular-nums">{today.passed}</strong>{" "}
          {today.passed === 1 ? "pasada a una persona" : "pasadas a una persona"}
        </p>
        <Button type="button" variant="link" size="sm" className="ml-auto h-auto min-h-8 p-0" onClick={() => agentPanel.setOpen(true, "actividad")}>
          Ver qué hizo
          <ArrowRight aria-hidden />
        </Button>
      </section>

      {/* Dos columnas según el ancho del contenido, no de la ventana: con la columna lateral abierta vuelve a una. */}
      <div className="@container min-w-0">
      <div className="grid min-w-0 items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className={`flex min-w-0 flex-col gap-6 max-sm:gap-4 ${besideTest}`}>
          <Card title="Qué hace" hint="Sus funciones. Apaga la que no quieras que haga: pierde esa capacidad, no solo la instrucción.">
            <ul className="flex flex-col divide-y">
              {role.functions.map((fn) => (
                <FunctionRow
                  key={fn.id}
                  fn={fn}
                  on={fn.fixed || !disabled.includes(fn.id)}
                  note={config.functionNotes[fn.id]}
                  canWrite={canWrite}
                  busy={toggleFunction.isPending}
                  onToggle={(next) =>
                    toggleFunction.mutate(
                      next ? config.disabledFunctions.filter((id) => id !== fn.id) : [...config.disabledFunctions, fn.id],
                    )
                  }
                  onEditNote={() => setNoteFor(fn)}
                />
              ))}
            </ul>
            {toggleFunction.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(toggleFunction.error)}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground max-sm:hidden">
              Los pasos son los mismos que usa tu equipo. Tú eliges qué funciones tiene y quién confirma.
            </p>
          </Card>

          <Card title="Hasta dónde llega solo" hint="Empieza supervisado y súbelo cuando confíes.">
            <ToggleGroup
              aria-label="Nivel de autonomía"
              variant="outline"
              spacing={0}
              className="w-full"
              value={activeLevel === "personalizado" ? [] : [activeLevel]}
              disabled={!canWrite || changeLevel.isPending}
              onValueChange={(next) => {
                const level = next[0] as AgentLevelId | undefined
                if (level) pickLevel(level)
              }}
            >
              {roles.levels.map((level) => (
                <ToggleGroupItem
                  key={level.id}
                  value={level.id}
                  className="min-h-11 flex-1 disabled:opacity-100 aria-pressed:bg-primary-soft aria-pressed:font-semibold aria-pressed:text-primary-soft-foreground sm:min-h-9"
                >
                  {level.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex flex-wrap items-start gap-x-4 text-sm">
              <p className="min-w-0 flex-1 basis-64 text-muted-foreground">{levelSummary}</p>
              {canWrite ? (
                <Link to="/settings/agent" className={`${LINK} max-sm:hidden`}>
                  Personalizar por acto
                </Link>
              ) : null}
            </div>
            {changeLevel.isError && !levelToConfirm ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(changeLevel.error)}
              </p>
            ) : null}

            {/* Teléfono: una fila lleva a todos los límites; quien solo lee los ve desplegados. */}
            {canWrite ? (
              <div className="overflow-hidden rounded-xl border sm:hidden">
                <EntryRow label="Límites y cuándo pasa a una persona" value={null} onClick={() => setLimits("todo")} />
              </div>
            ) : null}
            <div className={`flex flex-col gap-4 ${canWrite ? "max-sm:hidden" : ""}`}>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Pasa a una persona cuando</h3>
                <ul className="flex flex-wrap items-center gap-2">
                  {["Duda o no tiene el dato", "Piden hablar con alguien", ...config.handoffKeywords.map((word) => `Mencionan «${word}»`)].map((reason) => (
                    <li key={reason}>
                      <Badge variant="secondary" className="h-auto rounded-full px-3 py-1 text-sm font-normal">
                        {reason}
                      </Badge>
                    </li>
                  ))}
                  {canWrite ? (
                    <li>
                      <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => setLimits("pasa")}>
                        <Plus aria-hidden />
                        Agregar
                      </Button>
                    </li>
                  ) : null}
                </ul>
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Límites que aplica el sistema</h3>
                <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
                  <li>
                    <EntryRow label="Horario" value={hours} onClick={canWrite ? () => setLimits("horario") : undefined} />
                  </li>
                  <li>
                    <EntryRow label="Canales" value={channelsText} onClick={canWrite ? () => setLimits("canales") : undefined} />
                  </li>
                  <li>
                    <EntryRow label="Tope diario" value={dailyLimit} onClick={canWrite ? () => setLimits("tope") : undefined} />
                  </li>
                </ul>
                {overview.readiness.channels.length === 0 && canWrite ? (
                  <Link to="/settings/channels" className={`w-fit ${LINK}`}>
                    Conectar un canal
                  </Link>
                ) : null}
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-4 text-sm">
                <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="font-semibold">Nunca, y no se puede cambiar</p>
                  <p className="text-muted-foreground">{role.never}</p>
                </div>
              </div>
            </div>
          </Card>

          <Card
            title="Qué sabe"
            hint="Solo responde con esto. Si el dato no está aquí, lo dice y pasa a una persona."
            phone={{
              summary: `${count(knows.answers, "respuesta", "respuestas")} · ${count(knows.servicesWithPrice, "servicio con precio", "servicios con precio")} · ${count(knows.branches, "sede", "sedes")} · lo que recuerda de cada persona`,
              to: canWrite ? "/agent/knowledge" : undefined,
            }}
            phoneExtra={gapNotice ? <div className="sm:hidden">{gapNotice}</div> : null}
          >
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
              <li>
                <EntryRow
                  label="Respuestas oficiales"
                  value={knows.answers === 0 ? "Ninguna publicada todavía" : count(knows.answers, "publicada", "publicadas")}
                  to={canWrite ? "/agent/knowledge" : undefined}
                />
              </li>
              <li>
                <EntryRow
                  label="Servicios y tarifas"
                  value={knows.servicesWithPrice === 0 ? "Ninguno con precio todavía" : `${knows.servicesWithPrice} con precio`}
                  to="/services"
                />
              </li>
              <li>
                <EntryRow
                  label="Sedes y horarios"
                  value={knows.branches === 0 ? "Ninguna sede activa" : count(knows.branches, "sede", "sedes")}
                  to="/branches"
                />
              </li>
              <li>
                <EntryRow
                  label="Lo que aprendió de tus correcciones"
                  value={lessons === undefined ? null : lessons === 0 ? "Ninguna lección todavía" : count(lessons, "lección", "lecciones")}
                  to="/agent/learn"
                />
              </li>
            </ul>
            <div className="flex flex-col gap-1 rounded-xl bg-muted/60 p-4 text-sm">
              <h3 className="font-semibold">Lo que recuerda de cada persona</h3>
              <p className="text-muted-foreground">
                Pocos datos prácticos, cada uno con su origen, a la vista en la ficha de cada contacto. Los puedes corregir o quitar. Nunca guarda
                información clínica.
              </p>
            </div>
            {gapNotice}
          </Card>

          <Card
            title="Cómo se comporta"
            hint="La voz es la de tu clínica. Aquí va solo lo propio de Recepción."
            phone={{
              summary: `${config.personaName ?? "Sin nombre propio"} · ${TREATMENT_LABEL[config.treatment ?? "tu"]} · tono ${TONE_LABEL[config.tone]} · ${count(instructions.length, "indicación", "indicaciones")}`,
              expanded: behaviorOpen,
              onToggle: () => setBehaviorOpen((open) => !open),
            }}
          >
            <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
              <div className="min-w-0 flex-1 basis-48 text-sm">
                <p className="font-semibold">Usa la base de tu clínica</p>
                <p>{voice}</p>
                <p className="text-muted-foreground">La comparten todos tus agentes.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setBaseOpen(true)}>
                {canWrite ? "Editar la base" : "Ver la base"}
                <ArrowRight aria-hidden />
              </Button>
            </div>
            <div className="flex flex-col gap-1 rounded-xl border border-agent-border bg-agent-soft p-4">
              <span className="text-xs font-semibold text-primary-soft-foreground">Así sonaría</span>
              <p className="text-sm">
                «{voicePreview({ personaName: config.personaName, treatment: config.treatment, tone: config.tone, clinicName: org.name })}»
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Indicaciones solo para Recepción</h3>
              {instructions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todavía no le diste ninguna. Con la base y lo que sabe ya puede atender.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {instructions.map((item, index) => (
                    <li key={item.line} className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-2 text-sm">
                      <p className="min-w-0 flex-1 py-1.5 break-words">«{item.text}»</p>
                      {canWrite ? (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto min-h-11 shrink-0 p-0 sm:min-h-8"
                          aria-label={`Editar la indicación ${index + 1}`}
                          onClick={() => setInstruction(item.line)}
                        >
                          Editar
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite ? (
                <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => setInstruction("nueva")}>
                  <Plus aria-hidden />
                  Agregar indicación
                </Button>
              ) : null}
              <p className="text-sm text-muted-foreground">Orientan al agente. Lo que deba cumplirse siempre va en los límites.</p>
            </div>
          </Card>

          {canWrite ? (
            <Link
              to="/settings/agent"
              className="elevated lift flex min-h-13 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">Ajustes técnicos</span>
                <span className="text-muted-foreground">
                  Proveedor del modelo, modelo de decisión y autonomía acto por acto. Para quien administra.
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          ) : null}
        </div>

        {canWrite ? (
          <div className="min-w-0 @5xl:sticky @5xl:top-4">
            <AgentSandbox
              screen={testing}
              onLeaveScreen={() => {
                setTesting(false)
                // El foco vuelve al botón que abrió la pantalla, ya visible otra vez.
                requestAnimationFrame(() => testButtonRef.current?.focus())
              }}
              onTested={() => void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })}
            />
          </div>
        ) : null}
      </div>
      </div>

      {/* Teléfono: «Probar» queda a mano, fijo al pie, y abre su propia pantalla. */}
      {canWrite && !testing ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
          <Button ref={testButtonRef} type="button" className="h-12 w-full" onClick={() => setTesting(true)}>
            Probar
          </Button>
        </div>
      ) : null}

      <FunctionNoteDrawer fn={noteFor} config={config} onClose={() => setNoteFor(null)} />
      <LimitsDrawer section={limits} onClose={() => setLimits(null)} config={config} connectedChannels={overview.readiness.channels} />
      <InstructionDrawer target={instruction} onClose={() => setInstruction(null)} config={config} />
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
          openTest()
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
