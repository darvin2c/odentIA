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
  Drawer,
  DrawerContent,
  useIsMobile,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  ErrorState,
  PageHeader,
  PageShell,
  SideColumn,
  type SideColumnWidth,
  SideDockPortal,
  submitErrorMessage,
  useDetailMode,
  useSideColumnWidth,
  useSideDock,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { ArrowRight, ChevronDown, ChevronRight, Lock, Plus } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { AgentGuidance } from "../../components/agent/agent-guidance"
import { AgentBaseDrawer } from "../../components/agent/base-drawer"
import {
  FunctionNoteDrawer,
  LimitsDrawer,
  type LimitsSection,
} from "../../components/agent/reception-drawers"
import { AgentTestChat, PROBAR_INPUT } from "../../components/agent/test-chat"
import { TurnOnDrawer } from "../../components/agent/turn-on-drawer"
import {
  agentModelDown,
  type AgentFunction,
  type AgentOverview,
  type AgentRoles,
  type LearningOverview,
  namedAgentRoles,
  voicePreview,
} from "../../lib/agent"
import { AGENT_NAME_REASONS, RECEPTION_DEFAULT_NAME, useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { type AgentConfig, usePermission } from "../../lib/crm"
import { RECEPTION_TEST_COLUMN } from "../../lib/screen-rules"
import { useOrgProfile } from "../../lib/org"
import { QueryErrorState } from "../../lib/query-error"
import { ReceptionPageSkeleton, ReceptionSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/recepcion")({
  pendingComponent: ReceptionPageSkeleton,
  component: ReceptionPage,
})
const orgRouteApi = getRouteApi("/_org")

const LINK = "inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline sm:min-h-8"
const ROW =
  "flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
const TREATMENT_LABEL = { tu: "de tú", usted: "de usted" } as const
const TONE_LABEL = { cercano: "cercano", neutro: "neutro", formal: "formal" } as const
const EMOJIS_LABEL = { no: "sin emojis", pocos: "pocos emojis" } as const
/** El mismo corte que `sm` de los estilos: por debajo, «Probar» es una pantalla propia. */

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
function EntryRow({ label, value, onClick, to }: { label: string; value: string | null; onClick?: () => void; to?: "/agent/knowledge" | "/services" | "/settings/branches" | "/agent/learn" }) {
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
  error,
  onToggle,
  onEditNote,
}: {
  fn: AgentFunction
  on: boolean
  note: string | undefined
  canWrite: boolean
  busy: boolean
  /** Por qué no se guardó el último cambio de este interruptor. */
  error: string | null
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
            <Switch
              checked={on}
              disabled={!canWrite || busy}
              aria-label={fn.label}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `funcion-${fn.id}-error` : undefined}
              onCheckedChange={onToggle}
            />
          )}
        </div>
        {error ? (
          <p id={`funcion-${fn.id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
  const orgProfile = useOrgProfile()
  const canEditClinic = usePermission("settings.write")
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const receptionName = useReceptionName()
  const [noteFor, setNoteFor] = useState<AgentFunction | null>(null)
  const [limits, setLimits] = useState<LimitsSection | null>(null)
  const [baseOpen, setBaseOpen] = useState(false)
  const [turnOnOpen, setTurnOnOpen] = useState(false)
  const [turnOffOpen, setTurnOffOpen] = useState(false)
  const [behaviorOpen, setBehaviorOpen] = useState(false)
  // «Probar» (ADR 0094): en ventana ancha, columna fija a la derecha; si no cabe, cajón.
  const [testing, setTesting] = useState(false)
  const testButtonRef = useRef<HTMLButtonElement>(null)
  const phoneTestButtonRef = useRef<HTMLButtonElement>(null)
  const dock = useSideDock()
  const docked = useDetailMode() === "panel" && dock.available

  // Quien llega desde el resumen con «Probar» (`#probar`) lo encuentra abierto.
  // Al ensanchar la ventana el cajón se cierra: «Probar» ya está en su columna.
  useEffect(() => {
    if (docked) setTesting(false)
    else if (window.location.hash === "#probar") setTesting(true)
  }, [docked])

  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    select: (body) => ({ data: namedAgentRoles(body.data, receptionName) }),
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
    for (const key of ["agent-config", "agent-overview", "agent-summary"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  // Los interruptores guardan al momento; mientras viaja se muestra lo pedido.
  const toggleFunction = useMutation({
    retry: false,
    // `fnId` solo dice qué fila se tocó: su error se pinta en ella.
    mutationFn: ({ disabledFunctions }: { fnId: string; disabledFunctions: string[] }) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ disabledFunctions }) }),
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

  const title = `${receptionName}, tu agente de recepción`
  const roles = rolesQuery.data?.data
  const overview = overviewQuery.data?.data
  const config = configQuery.data?.data
  const role = roles?.roles.find((item) => item.id === "recepcion")
  const pending = rolesQuery.isPending || overviewQuery.isPending || configQuery.isPending
  const failed = rolesQuery.isError ? rolesQuery : overviewQuery.isError ? overviewQuery : configQuery.isError ? configQuery : null

  if (pending || failed || !roles || !overview || !config || !role) {
    return (
      <>
      {/* «Probar» no depende de estos datos: su columna ya ocupa su sitio y la página no salta al llegar.
          Va primero en las dos ramas, en el mismo lugar: al llegar los datos conserva lo que ya se escribió. */}
      {pending && canWrite && docked ? (
        <SideDockPortal fallback={null}>
          <TestColumn />
        </SideDockPortal>
      ) : null}
      <PageShell className="flex flex-col gap-6">
        <PageHeader title={title} />
        {pending ? (
          <SkeletonRegion message={`Cargando a ${receptionName}…`}>
            <ReceptionSkeleton />
          </SkeletonRegion>
        ) : (
          <QueryErrorState error={failed?.error} onRetry={() => void (failed ?? rolesQuery).refetch()} />
        )}
      </PageShell>
      </>
    )
  }

  const disabled =
    toggleFunction.isPending && toggleFunction.variables ? toggleFunction.variables.disabledFunctions : config.disabledFunctions
  const closeAfter = `A las ${count(config.closeAfterHours, "hora", "horas")} sin respuesta`
  const voice = [
    `Se presenta como ${config.personaName?.trim() || receptionName}`,
    `trata ${TREATMENT_LABEL[config.treatment ?? "tu"]}`,
    `tono ${TONE_LABEL[config.tone]}`,
    EMOJIS_LABEL[config.emojis],
  ].join(" · ")
  const lessons = learningQuery.data?.data.learned.filter((lesson) => lesson.agent === "recepcion").length
  const { today, knows } = overview
  const gaps = overview.needsYou.gaps
  const status = overview.enabled ? "Encendido" : "Apagado"
  /** Al cerrar el cajón, el foco vuelve al botón que lo abre: el del resumen o, en el teléfono, el del pie. */
  const openerOfTest = () => [phoneTestButtonRef.current, testButtonRef.current].find((button) => button?.offsetParent) ?? null

  /** «Probar» desde otra superficie: en su columna, al campo; si no, abre su cajón. */
  function openTest() {
    if (docked) document.getElementById(PROBAR_INPUT)?.focus()
    else setTesting(true)
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
    <>
    {canWrite && docked ? (
      <SideDockPortal fallback={<TestDrawer open={testing} onClose={() => setTesting(false)} returnFocus={openerOfTest} />}>
        <TestColumn />
      </SideDockPortal>
    ) : canWrite ? (
      <TestDrawer open={testing} onClose={() => setTesting(false)} returnFocus={openerOfTest} />
    ) : null}
    <PageShell className={`flex flex-col gap-6 ${canWrite && !testing ? "max-sm:pb-24" : ""}`}>
      <PageHeader
        title={title}
        subtitle={
          <>
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link to="/agent" />} className="inline-flex min-h-11 items-center sm:min-h-0">
                    Agente
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{receptionName}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            {/* El porqué de «Sofi»; con otro nombre, lo que hace. */}
            <span className="max-sm:hidden">{receptionName === RECEPTION_DEFAULT_NAME ? AGENT_NAME_REASONS.recepcion : role.role}</span>
            <span className="truncate sm:hidden">
              {status} · {count(today.attended, "conversación hoy", "conversaciones hoy")}
            </span>
            {canWrite ? (
              <label htmlFor="recepcion-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
                <span className="max-sm:hidden">{status}</span>
                <Switch
                  id="recepcion-encendido"
                  checked={overview.enabled}
                  aria-label={overview.enabled ? `Apagar a ${receptionName}` : `Encender a ${receptionName}`}
                  onCheckedChange={(next) => (next ? setTurnOnOpen(true) : setTurnOffOpen(true))}
                />
              </label>
            ) : (
              <Badge variant={overview.enabled ? "success" : "secondary"} className="max-sm:hidden">
                {status}
              </Badge>
            )}
          </>
        }
      />

      {/* El modelo dejó de responder: los casos pasan al equipo y odentIA ya tiene el caso. Se va solo cuando vuelve a responder. */}
      {overview.enabled && overview.provider.problem ? (
        <p role="alert" className={`rounded-xl border border-destructive/30 bg-danger-soft px-4 py-3 text-sm font-semibold`}>
          {agentModelDown(receptionName).line}
        </p>
      ) : null}

      {/* Sin teléfono para urgencias Sofi solo da el número de emergencias del país: se dice con su acción (ADR 0050 y 0084). */}
      {orgProfile.data && !orgProfile.data.emergencyPhone ? (
        <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm`}>
          <span className="font-semibold">Sin teléfono para urgencias.</span>
          <span className="min-w-0 flex-1">Ante una urgencia, {receptionName} solo puede decir a qué número de emergencias llamar o que vaya a la emergencia más cercana.</span>
          {canEditClinic ? (
            <Link to="/settings" className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline sm:min-h-0">
              Agregarlo en Datos de la clínica
            </Link>
          ) : null}
        </p>
      ) : null}

      {/* Hoy: lo que pasó en conversaciones, no en mensajes. En teléfono va resumido en la cabecera. */}
      <section
        aria-label="Hoy"
        className={`elevated flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm max-sm:hidden sm:px-6`}
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
        <Button variant="link" size="sm" className="ml-auto h-auto min-h-8 p-0" render={<Link to="/agent/actividad" />}>
          Ver qué hizo
          <ArrowRight aria-hidden />
        </Button>
        {canWrite && !docked ? (
          <Button ref={testButtonRef} type="button" size="sm" className="min-h-8" onClick={() => setTesting(true)}>
            Probar
          </Button>
        ) : null}
      </section>

      {/* «Probar» va aparte, en la columna lateral o en su cajón: la página es una sola columna. */}
      <div className="min-w-0">
      <div className="grid min-w-0 items-start gap-6">
        <div className="flex min-w-0 flex-col gap-6 max-sm:gap-4">
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
                  error={
                    toggleFunction.isError && toggleFunction.variables?.fnId === fn.id
                      ? submitErrorMessage(toggleFunction.error)
                      : null
                  }
                  onToggle={(next) =>
                    toggleFunction.mutate({
                      fnId: fn.id,
                      disabledFunctions: next
                        ? config.disabledFunctions.filter((id) => id !== fn.id)
                        : [...config.disabledFunctions, fn.id],
                    })
                  }
                  onEditNote={() => setNoteFor(fn)}
                />
              ))}
            </ul>
            <p className="text-sm text-muted-foreground max-sm:hidden">
              Los pasos son los mismos que usa tu equipo. Tú eliges qué funciones tiene; antes de una cita siempre confirma el paciente.
            </p>
          </Card>

          <Card title="Límites" hint="Siempre responde al momento. Aquí decides cuándo pasa el caso a una persona y cuánto puede hacer al día.">
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
                    <EntryRow label="Cerrar la conversación" value={closeAfter} onClick={canWrite ? () => setLimits("cierre") : undefined} />
                  </li>
                </ul>
                {overview.readiness.channels.length === 0 && canWrite ? (
                  <Link to="/settings/integrations" className={`w-fit ${LINK}`}>
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
              summary: `${count(knows.answers, "respuesta", "respuestas")} · ${count(knows.servicesWithPrice, "precio que dice", "precios que dice")} · ${count(knows.branches, "sede", "sedes")} · lo que recuerda de cada persona`,
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
                  label="Servicios y precios"
                  value={knows.servicesWithPrice === 0 ? "Ningún precio que pueda decir todavía" : `${knows.servicesWithPrice} con precio que puede decir`}
                  to="/services"
                />
              </li>
              <li>
                <EntryRow
                  label="Sedes y horarios"
                  value={knows.branches === 0 ? "Ninguna sede activa" : count(knows.branches, "sede", "sedes")}
                  to="/settings/branches"
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
            hint={`La voz es la de tu clínica. Aquí va solo lo propio de ${receptionName}.`}
            phone={{
              summary: `${config.personaName?.trim() || receptionName} · ${TREATMENT_LABEL[config.treatment ?? "tu"]} · tono ${TONE_LABEL[config.tone]} · ${EMOJIS_LABEL[config.emojis]}`,
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
                «{voicePreview({ personaName: config.personaName, treatment: config.treatment, tone: config.tone, emojis: config.emojis, clinicName: org.name })}»
              </p>
            </div>
          </Card>

          {/* Decisión 24: lo que escribe la clínica y lo que aprendió, en una sola lista. */}
          <AgentGuidance canWrite={canWrite} />
        </div>

      </div>
      </div>

      {/* Teléfono: «Probar» queda a mano, fijo al pie, y abre su cajón; sigue montado para recibir el foco al cerrarlo. */}
      {canWrite ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
          <Button ref={phoneTestButtonRef} type="button" className="h-12 w-full" onClick={() => setTesting(true)}>
            Probar
          </Button>
        </div>
      ) : null}

      <FunctionNoteDrawer fn={noteFor} config={config} onClose={() => setNoteFor(null)} />
      <LimitsDrawer section={limits} onClose={() => setLimits(null)} config={config} />
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
        onTest={() => {
          setTurnOnOpen(false)
          openTest()
        }}
      />
      <ConfirmDialog
        open={turnOffOpen}
        title={`Apagar a ${receptionName}`}
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
            {submitErrorMessage(turnOff.error)}
          </p>
        ) : null}
      </ConfirmDialog>
    </PageShell>
    </>
  )
}

/** La columna de «Probar»: ancho de un chat, que se puede cambiar como el de cualquier panel. */
const TEST_COLUMN: SideColumnWidth = RECEPTION_TEST_COLUMN

/** «Probar» en la columna lateral (ADR 0094): fija a la derecha, a todo el alto; la página sigue al lado. */
function TestColumn() {
  const [width, resize] = useSideColumnWidth("odentia.side-panel.probar", TEST_COLUMN)
  return (
    <SideColumn
      aria-labelledby="probar-titulo"
      width={width}
      onResize={resize}
      bounds={TEST_COLUMN}
      // Lo que la columna deja siempre a la página, como el detalle de una lista.
      pageMinWidth={512}
      resizeLabel="Cambiar el ancho de Probar"
    >
      <AgentTestChat titleId="probar-titulo" />
    </SideColumn>
  )
}

/** «Probar» donde no cabe la columna: el cajón estándar, a todo el alto en el teléfono. */
function TestDrawer({
  open,
  onClose,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  /** Adónde vuelve el foco al cerrar: el botón visible que abre «Probar». */
  returnFocus: () => HTMLElement | null
}) {
  const isMobile = useIsMobile()
  return (
    <Drawer
      open={open}
      swipeDirection={isMobile ? "down" : "right"}
      showSwipeHandle={isMobile}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DrawerContent
        aria-labelledby="probar-titulo"
        finalFocus={() => returnFocus() ?? true}
        className="overflow-hidden data-[swipe-axis=x]:sm:[--drawer-content-width:min(28rem,calc(100vw-2rem))] data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem-env(safe-area-inset-top))] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]"
      >
        {open ? <AgentTestChat titleId="probar-titulo" onClose={onClose} /> : null}
      </DrawerContent>
    </Drawer>
  )
}
