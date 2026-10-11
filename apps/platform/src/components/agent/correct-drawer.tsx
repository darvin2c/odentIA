import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import { type AnswerBasisItem, type CorrectionFailure, FAILURE_OPTIONS, type LessonItem } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { mutationErrorMessage } from "../../lib/query-error"

/** La respuesta que se corrige: una entrada de «Por revisar» o una respuesta marcada desde la Bandeja. */
export interface CorrectionTarget {
  reviewItemId?: string
  traceId?: string
  question: string
  reply: string
  /** Lo que respondió el equipo después, si lo hubo: punto de partida de la corrección. */
  teamReply: string | null
  basis: AnswerBasisItem[]
  /** Por qué entró a revisión, cuando viene de la lista. */
  why?: string
}

/**
 * Corregir una respuesta del agente: qué falló y cómo debió responder. No
 * cambia nada todavía: deja una lección propuesta que aprueba quien administra.
 */
export function CorrectDrawer({
  target,
  onClose,
  onCorrected,
}: {
  target: CorrectionTarget | null
  onClose: () => void
  onCorrected?: (lesson: LessonItem) => void
}) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<CorrectionFailure | null>(null)
  const [text, setText] = useState("")
  useEffect(() => {
    if (!target) return
    setFailure(null)
    setText(target.teamReply ?? "")
  }, [target])

  const refresh = () => {
    for (const key of ["agent-learning", "agent-overview"]) void queryClient.invalidateQueries({ queryKey: [key] })
  }
  const correct = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch<{ data: LessonItem }>("/api/agent/learning/corrections", {
        method: "POST",
        body: JSON.stringify({
          ...(target?.reviewItemId ? { reviewItemId: target.reviewItemId } : { traceId: target?.traceId }),
          failure,
          ...(text.trim() ? { correctedReply: text.trim() } : {}),
        }),
      }),
    onSuccess: (response) => {
      refresh()
      onCorrected?.(response.data)
      onClose()
    },
  })
  const markOk = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/agent/learning/review/${target?.reviewItemId}/ok`, { method: "POST" }),
    onSuccess: () => {
      refresh()
      onClose()
    },
  })

  // «No debió responder» no necesita una respuesta alternativa: la regla es pasar el caso.
  const needsText = failure !== "no_debio_responder"
  const ready = failure !== null && (!needsText || text.trim().length > 0)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (ready && !correct.isPending) correct.mutate()
  }

  return (
    <FormDrawer
      open={target !== null}
      onClose={() => {
        correct.reset()
        markOk.reset()
        onClose()
      }}
      title="Corregir una respuesta"
      description={target?.question ? `«${target.question}»` : "Respuesta del agente"}
      onSubmit={submit}
      isSubmitting={correct.isPending}
      isDirty={failure !== null || text !== (target?.teamReply ?? "")}
      error={mutationErrorMessage(correct.error ?? markOk.error)}
      submitLabel="Enviar corrección"
      cancelLabel="Cancelar"
      submitDisabled={!ready}
    >
      <div className="flex flex-col gap-5">
      {target ? (
        <>
          <section aria-label="La respuesta" className="flex flex-col gap-2">
            {target.question ? (
              <p className="max-w-[92%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                <span className="sr-only">Preguntó: </span>
                {target.question}
              </p>
            ) : null}
            <p className="max-w-[92%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md border border-agent-border bg-agent-soft px-4 py-2.5 text-sm">
              <span className="sr-only">El agente respondió: </span>
              {target.reply}
            </p>
          </section>

          <section aria-labelledby="corregir-basado" className="flex flex-col gap-1 text-sm">
            <h3 id="corregir-basado" className="font-semibold">
              En qué se basó
            </h3>
            {target.basis.length > 0 ? (
              <ul className="list-disc pl-5 text-muted-foreground">
                {target.basis.map((item) => (
                  <li key={`${item.kind}-${item.label}-${item.detail ?? ""}`}>
                    {item.label}
                    {item.detail ? `: ${item.detail}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No consultó ninguna fuente: respondió con lo que había en la conversación.</p>
            )}
            {target.why ? (
              <p className="pt-1">
                <span className="font-semibold">Por qué está aquí:</span> {target.why}
              </p>
            ) : null}
          </section>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-semibold">¿Qué falló?</legend>
            <div className="flex flex-wrap gap-1.5">
              {FAILURE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={failure === option.value ? "default" : "outline"}
                  aria-pressed={failure === option.value}
                  className="min-h-11 rounded-full sm:min-h-8"
                  onClick={() => setFailure(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </fieldset>

          <Field>
            <FieldLabel htmlFor="corregir-respuesta">
              {needsText ? "¿Cómo debió responder?" : "¿Qué debió hacer? (opcional)"}
            </FieldLabel>
            <Textarea
              id="corregir-respuesta"
              rows={4}
              maxLength={2000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={needsText ? "Escribe la respuesta correcta." : "Si lo dejas vacío, la regla será pasar el caso a una persona."}
            />
            {target.teamReply && text === target.teamReply ? (
              <FieldDescription>Puse lo que respondió tu equipo. Cámbialo si quieres.</FieldDescription>
            ) : null}
          </Field>

          <p className="text-sm text-muted-foreground">
            Con tu corrección se propone qué aprender. Nada cambia hasta que lo apruebe quien administra el agente.
          </p>
          {target.reviewItemId ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start sm:min-h-9"
              disabled={markOk.isPending || correct.isPending}
              onClick={() => markOk.mutate()}
            >
              Estuvo bien, quitar de la lista
            </Button>
          ) : null}
        </>
      ) : null}
      </div>
    </FormDrawer>
  )
}
