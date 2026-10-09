import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import {
  AgentMark,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  SubmitButton,
} from "@odentia/ui-patterns"
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { ArrowLeft, Bot } from "lucide-react"
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  ACTION_LABEL,
  type AgentActivityItem,
  type AgentHandoff,
  type AgentPanelSummary,
  type AgentProposal,
  approvalOutcomeMessage,
  permissionForAction,
  proposalErrorMessage,
} from "../lib/agent"
import { ApiError, apiFetch } from "../lib/api"
import { channelLabel } from "../lib/channels"
import { usePermission } from "../lib/crm"

/**
 * Panel lateral global del agente: decidir, ver derivadas y actividad desde
 * cualquier pantalla. Se superpone como cajón sin cerrar la página ni sus
 * borradores; en móvil ocupa la pantalla completa con botón de retorno.
 *
 * El layout de la organización monta el panel una sola vez y suscribe estos
 * eventos en su única conexión SSE; aquí solo se declara qué invalidar.
 */
export const AGENT_PANEL_EVENTS = [
  "agent.proposal.created",
  "agent.proposal.decided",
  "agent.proposal.executed",
  "agent.handoff.created",
  "agent.run.recorded",
  "task.updated",
  "stream.reconnected",
]

const PANEL_KEYS = [
  "agent-panel",
  "agent-panel-proposals",
  "agent-panel-handoffs",
  "agent-panel-activity",
  "agent-proposals",
  "agent-handoffs",
  "workspace-home",
  "tasks",
]

export function invalidateAgentPanelQueries(queryClient: QueryClient): void {
  for (const key of PANEL_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

interface AgentPanelState {
  open: boolean
  setOpen: (open: boolean) => void
  /** Botón de cabecera, para devolverle el foco al cerrar el cajón. */
  buttonRef: RefObject<HTMLButtonElement | null>
}

const AgentPanelContext = createContext<AgentPanelState>({
  open: false,
  setOpen: () => {},
  buttonRef: { current: null },
})

export function useAgentPanelSummary(enabled: boolean) {
  return useQuery({
    queryKey: ["agent-panel"],
    queryFn: () => apiFetch<{ data: AgentPanelSummary }>("/api/agent/panel"),
    enabled,
    refetchInterval: 60_000,
  })
}

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // Los enlaces del panel no lo cierran al clic: si la página protege un
  // borrador y el usuario elige seguir editando, el panel sigue tal cual. Se
  // cierra cuando la navegación se confirma (cambia la ubicación).
  const href = useRouterState({ select: (state) => state.location.href })
  const lastHref = useRef(href)
  useEffect(() => {
    if (lastHref.current !== href) {
      lastHref.current = href
      setOpen(false)
    }
  }, [href])
  return (
    <AgentPanelContext.Provider value={{ open, setOpen, buttonRef }}>
      {children}
      <AgentPanel />
    </AgentPanelContext.Provider>
  )
}

function useCanSeePanel(): boolean {
  const canRead = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  return canRead || canDecide
}

/** Botón «Agente · N» de la cabecera: abre el panel desde cualquier página. */
export function AgentPanelButton() {
  const canSee = useCanSeePanel()
  const { open, setOpen, buttonRef } = useContext(AgentPanelContext)
  const summary = useAgentPanelSummary(canSee)
  if (!canSee) return null
  const pending = summary.data?.data.pendingProposals ?? 0
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={open ? "default" : "outline"}
      className="elevated relative h-11 gap-2 rounded-full px-2 sm:pr-4"
      onClick={() => setOpen(!open)}
      aria-label={`Agente${pending > 0 ? `, ${pending} por decidir` : ""}`}
      aria-expanded={open}
    >
      <span
        className={`flex size-7 items-center justify-center rounded-full ${open ? "bg-background text-primary" : "bg-primary text-primary-foreground"}`}
      >
        <Bot className="size-4" aria-hidden />
      </span>
      <span className="hidden sm:inline">
        Agente{pending > 0 ? ` · ${pending} por decidir` : ""}
      </span>
      {pending > 0 ? (
        <span className="sm:hidden absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-background px-1 text-xs font-bold text-primary ring-2 ring-primary">
          {pending > 99 ? "99+" : pending}
        </span>
      ) : null}
    </Button>
  )
}

type WhenFormatter = (iso: string) => string

/** Fechas en la zona y el idioma de la organización, como en Inicio. */
function whenFormatter(summary: AgentPanelSummary | undefined): WhenFormatter {
  const locale = summary?.locale ?? "es-PE"
  const timeZone = summary?.timezone
  return (iso) =>
    new Date(iso).toLocaleString(locale, {
      timeZone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
}

function headerStatus(data: AgentPanelSummary): string {
  const parts = [
    data.enabled ? "Activo" : "Pausado",
    `${data.interventionsToday} ${data.interventionsToday === 1 ? "intervención" : "intervenciones"} hoy`,
  ]
  if (data.failedToday > 0) parts.push(`${data.failedToday} con error`)
  return parts.join(" · ")
}

function AgentPanel() {
  const { open, setOpen, buttonRef } = useContext(AgentPanelContext)
  const canSee = useCanSeePanel()
  const summary = useAgentPanelSummary(open && canSee)
  const data = summary.data?.data
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        finalFocus={buttonRef}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[400px] data-[side=right]:sm:max-w-md"
        aria-label="Agente"
      >
        <div className="flex items-center gap-3 border-b p-4 sm:p-5">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="sm:hidden"
            aria-label="Volver"
            onClick={() => setOpen(false)}
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Button>
          <AgentMark />
          <div className="min-w-0 flex-1 leading-tight">
            <SheetTitle className="text-[17px] font-bold tracking-tight">Agente</SheetTitle>
            <SheetDescription className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${data?.enabled ? "bg-success" : "bg-muted-foreground"}`}
              />
              {data ? headerStatus(data) : "Cargando…"}
            </SheetDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="hidden sm:inline-flex"
            aria-label="Cerrar el panel del agente"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden className="text-lg leading-none">
              ×
            </span>
          </Button>
        </div>
        {open ? <PanelBody summary={data} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({ summary }: { summary: AgentPanelSummary | undefined }) {
  const pending = summary?.pendingProposals ?? 0
  const openHandoffs = summary?.openHandoffs ?? 0
  const when = whenFormatter(summary)
  return (
    <Tabs defaultValue="decidir" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="mx-4 mt-3 grid grid-cols-3 sm:mx-5">
        <TabsTrigger value="decidir">Por decidir{pending > 0 ? ` · ${pending}` : ""}</TabsTrigger>
        <TabsTrigger value="derivadas">
          Derivadas{openHandoffs > 0 ? ` · ${openHandoffs}` : ""}
        </TabsTrigger>
        <TabsTrigger value="actividad">Actividad</TabsTrigger>
      </TabsList>
      {/* Pestañas montadas: cambiar de pestaña no pierde un rechazo a medio escribir. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4 sm:p-5">
          <TabsContent value="decidir" keepMounted>
            <ProposalsTab when={when} />
          </TabsContent>
          <TabsContent value="derivadas" keepMounted>
            <HandoffsTab when={when} />
          </TabsContent>
          <TabsContent value="actividad" keepMounted>
            <ActivityTab when={when} />
          </TabsContent>
        </div>
      </ScrollArea>
      <div className="border-t p-4 sm:p-5">
        <Link
          to="/agent/approvals"
          className="flex min-h-11 items-center justify-center rounded-full border font-semibold hover:bg-accent/60"
        >
          Ver todas las aprobaciones
        </Link>
      </div>
    </Tabs>
  )
}

/** Enlace secundario con objetivo táctil suficiente en móvil. */
const INLINE_LINK = "inline-flex min-h-11 items-center font-semibold text-primary hover:underline sm:min-h-0"
/** Botones compactos en escritorio, de 44 px en móvil. */
const TOUCH_SM = "min-h-11 sm:min-h-8"

function ProposalsTab({ when }: { when: WhenFormatter }) {
  const queryClient = useQueryClient()
  const canDecide = usePermission("agent.decide")
  const canConversations = usePermission("conversations.write")
  const canAgenda = usePermission("appointments.write")
  const canCrm = usePermission("crm.write")
  const [approving, setApproving] = useState<AgentProposal | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [outcome, setOutcome] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["agent-panel-proposals"],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>("/api/agent/proposals?status=propuesta&limit=50"),
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "aprobada" | "rechazada"; reason?: string }) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${input.id}/decision`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (response) => {
      const proposal = response.data
      // Un desenlace que ya no figura en la lista se dice, no se silencia.
      setOutcome(
        proposal.status === "fallida" || proposal.status === "expirada"
          ? `La propuesta quedó ${proposal.status}.${proposalErrorMessage(proposal) ? ` ${proposalErrorMessage(proposal)}` : ""} Gestiona la acción desde el caso.`
          : proposal.status === "rechazada"
            ? "Propuesta rechazada."
            : approvalOutcomeMessage(proposal),
      )
      setApproving(null)
      setRejecting(null)
      setReason("")
      invalidateAgentPanelQueries(queryClient)
    },
  })
  const error =
    decide.error instanceof ApiError
      ? decide.error.shape.message
      : decide.error
        ? "No pudimos registrar la decisión. No se muestra como ejecutada."
        : null
  const authorized = (action: string) => {
    if (!canDecide) return false
    const permission = permissionForAction(action)
    return permission === "conversations.write"
      ? canConversations
      : permission === "appointments.write"
        ? canAgenda
        : canCrm
  }
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar las propuestas.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  // El equipo decide todo lo que no exige confirmación del interlocutor; esas
  // se muestran aparte para que no parezcan decisiones pendientes de nadie.
  const proposals = query.data.data
  const forTeam = proposals.filter((p) => p.mode !== "confirmar_usuario")
  const forContact = proposals.filter((p) => p.mode === "confirmar_usuario")
  const renderProposal = (proposal: AgentProposal, decidable: boolean) => {
    const person = proposal.context.contactName ?? "Interlocutor no disponible"
    const patient =
      proposal.context.patientName && proposal.context.patientName !== proposal.context.contactName
        ? proposal.context.patientName
        : null
    return (
      <li
        key={proposal.id}
        className={`flex flex-col gap-3 rounded-2xl border p-4 ${decidable ? "border-primary/30 bg-primary-soft/40" : "bg-card"}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={decidable ? "soft" : "secondary"}>
            {decidable ? "Espera tu aprobación" : "Espera al interlocutor"}
          </Badge>
          <span className="text-muted-foreground">{when(proposal.createdAt)}</span>
        </div>
        <h3 className="text-[15px] font-bold tracking-tight">
          {ACTION_LABEL[proposal.action] ?? proposal.action}
        </h3>
        <div className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
          <p className="font-semibold">
            {person}
            {proposal.context.channel ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {channelLabel(proposal.context.channel)}
              </span>
            ) : null}
          </p>
          {patient ? <p>Paciente: {patient}</p> : null}
          {proposal.context.opportunityTitle ? (
            <p className="text-muted-foreground">{proposal.context.opportunityTitle}</p>
          ) : null}
          {proposal.context.beforeSummary ? (
            <p className="text-xs text-muted-foreground">
              Al proponer: {proposal.context.beforeSummary}
            </p>
          ) : null}
          <p>{proposal.context.afterSummary}</p>
          {proposal.reason ? <p className="text-muted-foreground">Motivo: {proposal.reason}</p> : null}
          {proposal.context.isStale ? (
            <p role="alert" className="text-destructive">
              La situación cambió desde que se propuso; revisa el caso antes de decidir.
            </p>
          ) : null}
        </div>
        {decidable && authorized(proposal.action) ? (
          rejecting === proposal.id ? (
            <div className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor={`panel-rechazo-${proposal.id}`}>Motivo del rechazo</FieldLabel>
                <Input
                  id={`panel-rechazo-${proposal.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                  autoFocus
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton
                  size="sm"
                  variant="outline"
                  className={TOUCH_SM}
                  pending={decide.isPending}
                  disabled={!reason.trim()}
                  onClick={() => decide.mutate({ id: proposal.id, decision: "rechazada", reason })}
                >
                  Confirmar rechazo
                </SubmitButton>
                <Button
                  size="sm"
                  variant="ghost"
                  className={TOUCH_SM}
                  onClick={() => {
                    setRejecting(null)
                    setReason("")
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className={`flex-1 rounded-full ${TOUCH_SM}`}
                disabled={decide.isPending}
                onClick={() => {
                  decide.reset()
                  setApproving(proposal)
                }}
              >
                Revisar y aprobar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={`rounded-full ${TOUCH_SM}`}
                onClick={() => {
                  decide.reset()
                  setRejecting(proposal.id)
                }}
              >
                Rechazar…
              </Button>
            </div>
          )
        ) : null}
        {proposal.conversationId ? (
          <Link
            to="/inbox"
            search={{ conversation: proposal.conversationId }}
            className={`text-sm ${INLINE_LINK}`}
          >
            {decidable ? "Abrir caso" : "Abrir conversación"}
          </Link>
        ) : null}
      </li>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {outcome ? (
        <p role="status" className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
          {outcome}{" "}
          <button type="button" className="underline" onClick={() => setOutcome(null)}>
            Descartar
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {forTeam.length === 0 ? (
        <EmptyState
          title="Nada por decidir"
          description="Cuando el agente prepare un cambio que necesite tu aprobación, aparecerá aquí."
        />
      ) : null}
      <ul className="flex flex-col gap-3">{forTeam.map((p) => renderProposal(p, true))}</ul>
      {forContact.length > 0 ? (
        <section aria-label="Esperan al interlocutor" className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Esperan al interlocutor · {forContact.length}
          </h3>
          <ul className="flex flex-col gap-3">{forContact.map((p) => renderProposal(p, false))}</ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={approving !== null}
        title="Aprobar y ejecutar el cambio"
        description={
          approving
            ? `${approving.context.patientName && approving.context.patientName !== approving.context.contactName ? `Paciente: ${approving.context.patientName} · Interlocutor: ` : ""}${approving.context.contactName ?? "Interlocutor"}: ${approving.context.afterSummary}`
            : ""
        }
        confirmLabel="Aprobar y ejecutar"
        variant="default"
        pending={decide.isPending}
        onClose={() => {
          if (!decide.isPending) setApproving(null)
        }}
        onConfirm={() => approving && decide.mutate({ id: approving.id, decision: "aprobada" })}
      />
    </div>
  )
}

function HandoffsTab({ when }: { when: WhenFormatter }) {
  const queryClient = useQueryClient()
  const canTasks = usePermission("tasks.write")
  const query = useQuery({
    queryKey: ["agent-panel-handoffs"],
    queryFn: () => apiFetch<{ data: AgentHandoff[] }>("/api/agent/handoffs?open=1&limit=50"),
  })
  const claim = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: AgentHandoff }>(`/api/agent/handoffs/${id}/claim`, { method: "POST" }),
    onSuccess: () => invalidateAgentPanelQueries(queryClient),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar las derivaciones.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  const handoffs = query.data.data
  const error =
    claim.error instanceof ApiError
      ? claim.error.shape.message
      : claim.error
        ? "No pudimos tomar el caso."
        : null
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {handoffs.length === 0 ? (
        <EmptyState
          title="Sin derivaciones abiertas"
          description="Los casos que el agente pase al equipo esperan aquí hasta que alguien los tome y resuelva."
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {handoffs.map((handoff) => {
          const high = handoff.priority === "alta"
          return (
            <li
              key={handoff.id}
              className="flex flex-col gap-2 rounded-2xl border bg-card p-4 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  aria-hidden
                  className={
                    high ? "size-2 rounded-full bg-destructive" : "size-2 rounded-[2px] bg-warning"
                  }
                />
                <span
                  className={`text-xs font-semibold ${high ? "text-destructive" : "text-warning"}`}
                >
                  Prioridad {handoff.priority}
                </span>
                <Badge variant="secondary">
                  {handoff.status === "tomada" ? "Responsable asignado" : "En cola por recoger"}
                </Badge>
              </div>
              <p className="font-semibold">
                {handoff.contactName ?? "Interlocutor no disponible"}
                {handoff.channel ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {channelLabel(handoff.channel)}
                  </span>
                ) : null}
              </p>
              <p>{handoff.reason}</p>
              {handoff.dueAt ? (
                <p className="text-xs text-muted-foreground">Vence {when(handoff.dueAt)}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {handoff.status === "abierta" && canTasks ? (
                  <SubmitButton
                    size="sm"
                    className={`rounded-full ${TOUCH_SM}`}
                    pending={claim.isPending}
                    onClick={() => claim.mutate(handoff.id)}
                  >
                    Tomar caso
                  </SubmitButton>
                ) : null}
                {handoff.conversationId ? (
                  <Link
                    to="/inbox"
                    search={{ conversation: handoff.conversationId }}
                    className={INLINE_LINK}
                  >
                    Abrir conversación
                  </Link>
                ) : null}
                {handoff.taskId ? (
                  <Link to="/tasks" search={{ task: handoff.taskId }} className={INLINE_LINK}>
                    Abrir pendiente
                  </Link>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const ACTIVITY_STATUS: Record<string, string> = {
  propuesta: "pendiente",
  aprobada: "aprobada",
  rechazada: "rechazada",
  ejecutada: "ejecutada",
  fallida: "fallida",
  expirada: "expirada",
  abierta: "en cola",
  tomada: "tomada",
  resuelta: "resuelta",
  // Entrega de mensajes: lo que el proveedor confirmó, no lo que se intentó.
  queued: "pendiente de envío",
  sent: "enviado",
  delivered: "entregado",
  read: "leído",
  failed: "no se envió",
  unknown: "entrega incierta",
}

function ActivityTab({ when }: { when: WhenFormatter }) {
  const query = useQuery({
    queryKey: ["agent-panel-activity"],
    queryFn: () => apiFetch<{ data: AgentActivityItem[] }>("/api/agent/activity?limit=50"),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar la actividad.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  const items = query.data.data
  if (items.length === 0)
    return (
      <EmptyState
        title="Sin actividad"
        description="Aquí verás lo que el agente envió, propuso o derivó."
      />
    )
  return (
    <ul className="flex flex-col divide-y">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-1 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{when(item.at)}</span>
            {item.status ? (
              <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
                {ACTIVITY_STATUS[item.status] ?? item.status}
              </Badge>
            ) : null}
          </div>
          <p>
            <span className="font-semibold">{item.title}</span>
            {item.contactName ? ` · ${item.contactName}` : ""}
          </p>
          {item.detail ? <p className="text-muted-foreground">{item.detail}</p> : null}
          {item.conversationId ? (
            <Link
              to="/inbox"
              search={{ conversation: item.conversationId }}
              className={`text-xs ${INLINE_LINK}`}
            >
              Abrir conversación
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
