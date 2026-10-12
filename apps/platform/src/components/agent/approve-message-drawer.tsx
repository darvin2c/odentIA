import { Badge, Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { DetailDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { useEffect, useState } from "react"
import { apiFetch } from "../../lib/api"
import { ANSWER_CHECK_LABEL, type AgentProposal, type AnswerTrace } from "../../lib/agent"
import { channelLabel } from "../../lib/channels"
import { timeAgo } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"

/** El borrador de un mensaje de texto: lo único que se edita al aprobar. Nulo si la propuesta no es un mensaje de texto. */
export function messageDraftOf(proposal: AgentProposal): string | null {
  return proposal.action === "enviar_mensaje" && proposal.payload.kind !== "template" && typeof proposal.payload.text === "string"
    ? proposal.payload.text
    : null
}

/**
 * Aprobar un mensaje del agente: se lee lo que escribió la persona, se corrige
 * el borrador si hace falta y se decide. Nada sale hasta aprobar. La misma
 * superficie desde Aprobaciones, el panel del agente e Inicio.
 */
export function ApproveMessageDrawer({
  proposal,
  onClose,
  onDecided,
}: {
  /** La propuesta de mensaje; null = cerrado. */
  proposal: AgentProposal | null
  onClose: () => void
  onDecided: (response: { data: AgentProposal }) => void
}) {
  const navigate = useNavigate()
  const draft = proposal ? (messageDraftOf(proposal) ?? "") : ""
  const [text, setText] = useState(draft)
  const [showOriginal, setShowOriginal] = useState(false)
  const proposalId = proposal?.id ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de propuesta, para no pisar lo que se está escribiendo.
  useEffect(() => {
    setText(draft)
    setShowOriginal(false)
  }, [proposalId])

  const conversationId = proposal?.conversationId ?? null
  const traceQuery = useQuery({
    queryKey: ["agent-answer-traces", conversationId],
    queryFn: () => apiFetch<{ data: AnswerTrace[] }>(`/api/agent/answer-traces?conversationId=${conversationId}`),
    enabled: conversationId !== null,
    retry: false,
  })
  const trace = traceQuery.data?.data.find((item) => item.proposalId === proposalId) ?? null

  const decide = useMutation({
    retry: false,
    mutationFn: (input: { decision: "aprobada" | "rechazada"; reason?: string; editedText?: string; answerMyself?: boolean }) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${proposalId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: input.decision, reason: input.reason, editedText: input.editedText }),
      }),
    onSuccess: (response, input) => {
      onDecided(response)
      if (input.answerMyself && conversationId) void navigate({ to: "/inbox", search: { conversation: conversationId } })
    },
  })

  if (!proposal) return null
  const edited = text.trim() !== "" && text.trim() !== draft.trim()
  const error = mutationErrorMessage(decide.error)
  const failed = trace?.checks.filter((check) => !check.ok) ?? []
  const close = () => {
    decide.reset()
    onClose()
  }

  return (
    <DetailDrawer
      open
      title="Aprobar un mensaje"
      description="Mensaje del agente · espera tu aprobación"
      onClose={close}
      isDirty={edited}
      isSubmitting={decide.isPending}
      size="lg"
      actions={
        <>
          <Button type="button" variant="outline" className="text-destructive" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "rechazada" })}>
            Rechazar
          </Button>
          {conversationId ? (
            <Button
              type="button"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: "rechazada", reason: "Responde una persona del equipo", answerMyself: true })}
            >
              Responder yo
            </Button>
          ) : null}
          <SubmitButton
            type="button"
            pending={decide.isPending}
            disabled={!text.trim()}
            onClick={() => decide.mutate({ decision: "aprobada", ...(edited ? { editedText: text.trim() } : {}) })}
          >
            Aprobar y enviar
          </SubmitButton>
        </>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground">
            {[
              proposal.context.contactName ?? "Interlocutor no disponible",
              proposal.context.channel ? channelLabel(proposal.context.channel) : null,
              timeAgo(proposal.createdAt) || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {trace?.question ? (
            <p className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2">{trace.question}</p>
          ) : null}
        </div>

        <Field>
          <FieldLabel htmlFor="aprobar-borrador" className="flex items-center gap-2">
            Borrador del agente
            {edited ? <Badge variant="warning">Lo editaste</Badge> : null}
          </FieldLabel>
          <Textarea id="aprobar-borrador" rows={5} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
          {edited ? (
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-11 self-start p-0 sm:min-h-0"
              aria-expanded={showOriginal}
              onClick={() => setShowOriginal(!showOriginal)}
            >
              {showOriginal ? "Ocultar lo que había escrito el agente" : "Ver lo que había escrito el agente"}
            </Button>
          ) : null}
          {edited && showOriginal ? (
            <p className="whitespace-pre-wrap rounded-xl border border-agent-border bg-agent-soft p-3">{draft}</p>
          ) : null}
        </Field>

        {trace ? (
          <div className="flex flex-col gap-1 rounded-xl border p-3">
            <span className="text-xs font-semibold text-muted-foreground">En qué se basó el agente</span>
            {trace.basis.length === 0 ? (
              <span>No consultó ninguna fuente: respondió con lo que había en la conversación.</span>
            ) : (
              trace.basis.map((item) => (
                <span key={`${item.kind}-${item.label}-${item.detail ?? ""}`}>
                  {item.label}
                  {item.detail ? `: ${item.detail}` : ""}
                </span>
              ))
            )}
            {failed.map((check) => (
              <span key={`${check.kind}-${check.value}`} className="font-semibold text-warning-foreground">
                No tenía este dato: {ANSWER_CHECK_LABEL[check.kind].toLowerCase()} {check.value}
              </span>
            ))}
          </div>
        ) : null}

        {edited ? (
          <div className="flex gap-2.5 rounded-xl border border-agent-border bg-agent-soft p-3">
            <Bot className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Como lo cambiaste, al enviar se propondrá guardar tu texto como respuesta oficial. Lo aprueba quien administra.
            </span>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-center text-muted-foreground">Nada sale a la persona hasta que apruebes.</p>
      </div>
    </DetailDrawer>
  )
}
