import { Button, cn } from "@odentia/ui"
import { AgentMark, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, ChevronDown } from "lucide-react"
import { useState } from "react"
import { permissionForAction, proposalErrorMessage, type AgentProposal } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError, apiFetch } from "../../lib/api"
import { clockWords } from "../../lib/conversation-state"
import { useCan, usePermission } from "../../lib/crm"
import { canConfirmByPhone } from "../../lib/screen-rules"
import { invalidateAgentPanelQueries } from "../agent-panel"

/** Lo que hizo el agente con esta persona, como lo entrega el servidor. */
export interface AgentActionItem {
  id: string
  at: string
  conversationId: string
  style: "tarjeta" | "linea"
  title: string
  what: string | null
  detail: string | null
  state: "hecho" | "espera" | "no_se_pudo" | "vencio" | "ya_no_vale" | null
  opens: "citas" | "plan" | "datos" | "ventas" | null
  proposalId: string | null
  contactId: string | null
  action: string | null
}

export const agentActionsKey = (conversationId: string) => ["agent-actions", conversationId] as const

export function useAgentActions(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: agentActionsKey(conversationId),
    queryFn: () => apiFetch<{ data: AgentActionItem[] }>(`/api/conversations/${conversationId}/agent-actions`),
    enabled,
  })
}

const STATE_WORDS: Record<NonNullable<AgentActionItem["state"]>, { text: string; tone: string }> = {
  hecho: { text: "Hecho", tone: "text-success" },
  espera: { text: "Espera su sí", tone: "text-muted-foreground" },
  no_se_pudo: { text: "Te toca", tone: "text-warning" },
  vencio: { text: "Venció", tone: "text-muted-foreground" },
  ya_no_vale: { text: "Ya no vale", tone: "text-muted-foreground" },
}

const OPEN_WORDS: Record<NonNullable<AgentActionItem["opens"]>, string> = {
  citas: "Ver la cita",
  plan: "Ver el presupuesto",
  datos: "Ver sus datos",
  ventas: "Ver",
}

/** Las propuestas que la persona puede confirmar por otra vía: las citas. */
const PHONE_CONFIRMABLE = new Set(["reservar_cita", "reprogramar_cita", "cancelar_cita"])

/**
 * Lo que cambia algo que el equipo o la persona van a usar. El hilo nunca aprueba
 * nada: con una cita que espera, «Registrar confirmación» deja constancia del sí
 * que la persona ya dio en el chat, y «Confirmó por teléfono», del que dio por
 * otra vía (ADR 0118: aquí vive lo que antes estaba en «Esperan su sí»). Las dos
 * reservan con la misma operación que el agente.
 */
export function AgentActionCard({
  item,
  personName,
  onOpen,
}: {
  item: AgentActionItem
  /** De quién se espera el sí: se dice su nombre de pila, nunca «el interlocutor». */
  personName: string
  /** Abre esa sección de «Contexto»; ausente si quien mira no la puede abrir. */
  onOpen?: (section: NonNullable<AgentActionItem["opens"]>) => void
}) {
  const receptionName = useReceptionName()
  const queryClient = useQueryClient()
  const canDecide = usePermission("agent.decide")
  const canConversations = usePermission("conversations.write")
  const canAgenda = usePermission("appointments.write")
  const canCrm = usePermission("crm.write")
  const needed = item.action ? permissionForAction(item.action) : null
  const canRegister =
    !!item.proposalId && !!item.contactId && canDecide && canConversations &&
    (needed === "appointments.write" ? canAgenda : needed === "conversations.write" ? canConversations : canCrm)
  const confirm = useMutation({
    mutationFn: () =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${item.proposalId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ contactId: item.contactId }),
      }),
    onSuccess: () => {
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-actions", "agent-proposals", "conversations", "conversation", "crm-context", "conversation-context", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
  const byPhone = useMutation({
    mutationFn: () => apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${item.proposalId}/phone-confirm`, { method: "POST" }),
    onSuccess: () => {
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-actions", "agent-proposals", "conversations", "conversation", "crm-context", "conversation-context", "workspace-home", "appointments"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
  const canPhone =
    canConfirmByPhone(useCan()) && !!item.proposalId && item.state === "espera" && item.action !== null && PHONE_CONFIRMABLE.has(item.action)
  const done = byPhone.data ?? confirm.data
  const failedRun = byPhone.error ?? confirm.error
  const failed = done ? proposalErrorMessage(done.data) : null
  // Si el horario ya no está libre, lo dice el servidor con qué hacer: se muestra tal cual.
  const error =
    failedRun instanceof ApiError
      ? (failedRun.shape.message ?? "No se pudo registrar la confirmación.")
      : failedRun
        ? "No se pudo registrar la confirmación."
        : failed
  const busy = confirm.isPending || byPhone.isPending
  const state = item.state ? STATE_WORDS[item.state] : null
  const needsPerson = item.state === "no_se_pudo"
  const firstName = personName.split(/\s+/)[0] || personName
  return (
    <article
      aria-label={`${receptionName} ${item.title}`}
      className={cn(
        "ml-auto flex w-full max-w-[30rem] flex-col gap-1.5 rounded-xl border px-3 py-2.5",
        needsPerson ? "border-warning/50 bg-warning-soft" : "border-agent-border bg-agent-soft",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentMark size="sm" />
        <span className="min-w-0 flex-1 text-[13px] font-semibold">
          {receptionName} {item.title}
        </span>
        <time dateTime={item.at} className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {clockWords(item.at)}
        </time>
        {state ? <span className={cn("shrink-0 text-xs font-semibold", state.tone)}>{state.text}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-48">
          {item.what ? <p className="text-sm font-semibold">{item.what}</p> : null}
          {item.detail ? <p className="text-[13px] text-muted-foreground">{item.detail}</p> : null}
          {item.state === "espera" ? <p className="text-[13px] text-muted-foreground">Espera el sí de {firstName} en esta conversación.</p> : null}
        </div>
        {canRegister ? (
          <SubmitButton
            size="sm"
            className="min-h-11 rounded-full sm:min-h-8"
            pending={confirm.isPending}
            disabled={busy}
            onClick={() => confirm.mutate()}
          >
            Registrar confirmación
          </SubmitButton>
        ) : null}
        {canPhone ? (
          <SubmitButton
            size="sm"
            variant="outline"
            className="min-h-11 rounded-full border-agent-border bg-card sm:min-h-8"
            pending={byPhone.isPending}
            disabled={busy}
            onClick={() => byPhone.mutate()}
          >
            Confirmó por teléfono
          </SubmitButton>
        ) : null}
        {item.opens && onOpen ? (
          <Button
            type="button"
            size="sm"
            variant={needsPerson ? "default" : "outline"}
            className={cn("min-h-11 rounded-full sm:min-h-8", !needsPerson && "border-agent-border bg-card")}
            onClick={() => item.opens && onOpen(item.opens)}
          >
            {needsPerson ? "Resolver a mano" : OPEN_WORDS[item.opens]}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  )
}

/** Lo menor, en una línea. Varias seguidas se juntan y se abren al tocar. */
export function AgentActionLines({ items }: { items: AgentActionItem[] }) {
  const receptionName = useReceptionName()
  const [open, setOpen] = useState(false)
  const last = items[items.length - 1]
  if (!last) return null
  if (items.length === 1) {
    return (
      <p className="ml-auto flex w-fit max-w-full items-center gap-1 px-0.5 text-right text-xs text-muted-foreground">
        <Bot className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {receptionName} {last.title} · <time dateTime={last.at}>{clockWords(last.at)}</time>
        </span>
      </p>
    )
  }
  return (
    <div className="ml-auto flex w-fit max-w-full flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto min-h-11 gap-1 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground sm:min-h-7"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bot className="size-3.5" aria-hidden />
        {receptionName} hizo {items.length} cosas · {clockWords(last.at)}
        <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </Button>
      {open ? (
        <ul className="flex flex-col gap-1.5 rounded-xl border bg-card px-3 py-2 text-[13px]">
          {items.map((item) => (
            <li key={item.id}>{item.title.charAt(0).toUpperCase() + item.title.slice(1)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
