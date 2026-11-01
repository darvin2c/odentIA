import { Button, cn, useIsMobile } from "@odentia/ui"
import { FormDrawer, SubmitButton, submitErrorMessage, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import {
  ANSWER_CHECK_LABEL,
  type AnswerBasisItem,
  type AnswerCheck,
  type AnswerConversation,
  agentName,
  type CorrectionFailure,
  FAILURE_OPTIONS,
  type LessonItem,
  type LessonKind,
  type ReviewReason,
  reviewWhen,
} from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { KnowledgeEntry } from "./knowledge-model"

const CORRECTED_REPLY_CHARS = 2000
const QUESTION_CHARS = 200

/**
 * Lo que pide `POST /api/agent/learning/corrections`, con sus mismas palabras.
 * «No debió responder» no necesita una respuesta alternativa: la regla es pasar
 * el caso. Sumar a una respuesta que ya existe tampoco: su texto no cambia.
 */
const correctionSchema = z
  .object({
    failure: z.custom<CorrectionFailure | "">((value) => typeof value === "string"),
    correctedReply: z.string(),
    question: z.string(),
    existingId: z.string(),
    asksQuestion: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (!FAILURE_OPTIONS.some((option) => option.value === value.failure)) {
      ctx.addIssue({ code: "custom", path: ["failure"], message: "Elige qué falló" })
    }
    if (value.asksQuestion && value.existingId) return
    const text = value.correctedReply.trim()
    if (!text && value.failure !== "no_debio_responder") {
      ctx.addIssue({ code: "custom", path: ["correctedReply"], message: "Escribe cómo debió responder" })
    }
    if (text.length > CORRECTED_REPLY_CHARS) {
      ctx.addIssue({ code: "custom", path: ["correctedReply"], message: `La respuesta admite hasta ${CORRECTED_REPLY_CHARS} caracteres` })
    }
    if (value.asksQuestion && value.question.trim().length > QUESTION_CHARS) {
      ctx.addIssue({ code: "custom", path: ["question"], message: `La pregunta admite hasta ${QUESTION_CHARS} caracteres` })
    }
  })

/** La respuesta que se corrige: una entrada de «Por revisar» o una respuesta marcada desde la Bandeja. */
export interface CorrectionTarget {
  reviewItemId?: string
  traceId?: string
  /** El agente que respondió, cuando se sabe: va en el antetítulo. */
  agent?: string
  /** Por qué está en la lista. Lo que no encontró pide además la pregunta y si ya tiene respuesta. */
  reason?: ReviewReason
  query?: string | null
  /** A quién y cuándo: va bajo el título. */
  context?: string
  question: string
  reply: string
  /** Lo que el equipo escribió después, si lo hubo: se puede usar, nunca viene puesto. */
  teamReply: string | null
  basis: AnswerBasisItem[]
  /** Lo que se comprobó antes de enviar; sin el dato, la línea no se muestra. */
  checks?: AnswerCheck[]
  /** Por qué entró a revisión, cuando viene de la lista. */
  why?: string
}

/** Pie propio dentro del cuerpo: queda a la vista al desplazar, encima de «Cancelar». */
export const SURFACE_ACTIONS = "sticky bottom-0 z-10 -mx-6 -mb-4 flex flex-col gap-2 border-t bg-card px-6 pt-3.5 pb-4"

/** Lo que se comprobó de la respuesta, en una línea. */
function checksLine(checks: AnswerCheck[]): string {
  if (checks.length === 0) return "No había precio, fecha ni hora que verificar."
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) return `No coincidía con lo que consultó: ${failed.map((check) => `${ANSWER_CHECK_LABEL[check.kind]} ${check.value}`).join(" · ")}.`
  return `Verificado antes de enviar: ${checks.map((check) => `${ANSWER_CHECK_LABEL[check.kind].toLowerCase()} ${check.value}`).join(" · ")}.`
}

/** En qué se convierte la corrección, dicho antes de enviarla. La falla y su clase las decide el servidor. */
function learnsAs(kind: LessonKind | undefined, name: string): string {
  if (kind === "respuesta_oficial") return `Se propone como respuesta oficial: ${name} la usa cuando pregunten esto.`
  if (kind === "ejemplo") return `Se propone como ejemplo: ${name} lo usa en preguntas parecidas.`
  if (kind === "regla") return `Se propone como regla: ${name} la tiene presente en cada mensaje.`
  return "Con tu corrección se propone qué aprender."
}

/**
 * Corregir una respuesta del agente: lo que pasó en la conversación, qué falló y
 * cómo debió responder. No cambia nada todavía: deja una lección propuesta que
 * aprueba quien administra. En teléfono queda lo justo para corregir.
 */
export function CorrectDrawer({
  target,
  onClose,
  onCorrected,
  onMarkedOk,
  onAddedToAnswer,
}: {
  target: CorrectionTarget | null
  onClose: () => void
  onCorrected?: (lesson: LessonItem) => void
  onMarkedOk?: (reviewItemId: string) => void
  onAddedToAnswer?: (reviewItemId: string, answerTitle: string) => void
}) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const receptionName = useReceptionName()
  const canWrite = usePermission("agent.write")
  const who = target?.agent ? agentName(target.agent, receptionName) : null
  const notFound = target?.reason === "no_encontro"
  const conversationPath = target?.reviewItemId
    ? `/api/agent/learning/review/${target.reviewItemId}/conversation`
    : target?.traceId
      ? `/api/agent/learning/answers/${target.traceId}/conversation`
      : null
  const conversationQuery = useQuery({
    queryKey: ["answer-conversation", conversationPath],
    queryFn: () => apiFetch<{ data: AnswerConversation }>(conversationPath ?? ""),
    enabled: conversationPath !== null,
    retry: false,
  })
  const answersQuery = useQuery({
    queryKey: ["agent-knowledge-published"],
    queryFn: () => apiFetch<{ data: KnowledgeEntry[] }>("/api/agent/knowledge?status=publicada&limit=100"),
    enabled: notFound && canWrite,
    retry: false,
  })
  const answers = answersQuery.data?.data ?? []
  const messages = conversationQuery.data?.data.messages ?? []
  const lessonKinds = conversationQuery.data?.data.lessonKinds
  const team = messages.find((message) => message.role === "equipo")
  const teamText = team?.body ?? target?.teamReply ?? null

  const correct = useMutation({
    retry: false,
    mutationFn: (input: { failure: CorrectionFailure; correctedReply: string; question: string }) =>
      apiFetch<{ data: LessonItem }>("/api/agent/learning/corrections", {
        method: "POST",
        body: JSON.stringify({
          ...(target?.reviewItemId ? { reviewItemId: target.reviewItemId } : { traceId: target?.traceId }),
          failure: input.failure,
          ...(input.correctedReply ? { correctedReply: input.correctedReply } : {}),
          ...(input.question ? { question: input.question } : {}),
        }),
      }),
  })
  const addToAnswer = useMutation({
    retry: false,
    mutationFn: (entryId: string) =>
      apiFetch(`/api/agent/learning/review/${target?.reviewItemId}/add-to-answer`, { method: "POST", body: JSON.stringify({ entryId }) }),
  })
  const form = useAppForm({
    defaultValues: { failure: "" as CorrectionFailure | "", correctedReply: "", question: "", existingId: "", asksQuestion: false },
    validators: { onSubmit: correctionSchema },
    onSubmit: async ({ value }) => {
      const official = lessonKinds ? lessonKinds[value.failure as CorrectionFailure] === "respuesta_oficial" : false
      if (value.asksQuestion && value.existingId && target?.reviewItemId) {
        await addToAnswer.mutateAsync(value.existingId)
        refresh()
        onAddedToAnswer?.(target.reviewItemId, answers.find((entry) => entry.id === value.existingId)?.title ?? "")
        onClose()
        return
      }
      const response = await correct.mutateAsync({
        failure: value.failure as CorrectionFailure,
        correctedReply: value.correctedReply.trim(),
        question: value.asksQuestion && official ? value.question.trim() : "",
      })
      refresh()
      onCorrected?.(response.data)
      onClose()
    },
  })
  useEffect(() => {
    if (!target) return
    // Lo que escribió el equipo nunca viene puesto: puede no responder a esto.
    form.reset({
      failure: target.reason === "no_encontro" ? "falto_dato" : "",
      correctedReply: "",
      question: target.query ?? "",
      existingId: "",
      asksQuestion: target.reason === "no_encontro",
    })
  }, [target, form])
  // El error del envío no va arriba del cajón: se dice junto a «Enviar corrección».
  const { error: submitError, ...surface } = useFormSurface(form, {
    fieldMap: (key) => (key === "entryId" ? "existingId" : undefined),
  })
  const failure = useStore(form.store, (state) => state.values.failure)
  const text = useStore(form.store, (state) => state.values.correctedReply)
  const existingId = useStore(form.store, (state) => state.values.existingId)

  const refresh = () => {
    for (const key of ["agent-learning", "agent-overview", "agent-panel", "agent-knowledge"]) void queryClient.invalidateQueries({ queryKey: [key] })
  }
  const markOk = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/agent/learning/review/${target?.reviewItemId}/ok`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      refresh()
      if (target?.reviewItemId) onMarkedOk?.(target.reviewItemId)
      onClose()
    },
  })

  const kind = failure && lessonKinds ? lessonKinds[failure] : undefined
  // «No debió responder» no necesita una respuesta alternativa: la regla es pasar el caso.
  const needsText = failure !== "no_debio_responder"
  const official = kind === "respuesta_oficial"
  const adding = notFound && official && existingId !== ""
  const usedTeam = teamText !== null && text === teamText
  // Lo que falló al enviar o al darla por buena, junto a esas acciones (el pie propio).
  const actionError = submitError ?? (markOk.isError ? submitErrorMessage(markOk.error) : null)

  const data = target?.basis.filter((item) => item.kind !== "leccion") ?? []
  const lessons = target?.basis.filter((item) => item.kind === "leccion") ?? []
  const replyLabel = `${who ?? receptionName} respondió`

  return (
    <FormDrawer
      {...surface}
      open={target !== null}
      onClose={() => {
        correct.reset()
        addToAnswer.reset()
        markOk.reset()
        onClose()
      }}
      title={who ? `Corregir una respuesta de ${who}` : "Corregir una respuesta"}
      description={target?.context}
      cancelLabel="Cancelar"
      hideSubmit
    >
      <div className="flex flex-col gap-4">
      {target ? (
        <>
          <section aria-label="La conversación" className="flex flex-col gap-2 text-sm">
            {messages.length > 0 ? (
              messages.map((message) =>
                message.role === "escribio" ? (
                  <p key={message.id} className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-3 py-2.5 font-semibold">
                    <span className="sr-only">Escribió: </span>
                    {message.body}
                  </p>
                ) : message.role === "antes" ? (
                  <p key={message.id} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-agent-soft px-3 py-2.5 text-muted-foreground">
                    <span className="sr-only">Antes: </span>
                    {message.body}
                  </p>
                ) : message.role === "respondio" ? (
                  <div key={message.id} className="flex max-w-[85%] flex-col gap-1 self-end">
                    <span className="self-end text-xs font-bold text-primary-soft-foreground">{replyLabel}</span>
                    <p className="[overflow-wrap:anywhere] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary-soft px-3 py-2.5">{message.body}</p>
                  </div>
                ) : (
                  <TeamMessage key={message.id} label={`Tu equipo escribió después · ${reviewWhen(message.at)}`} body={message.body} onUse={() => form.setFieldValue("correctedReply", message.body)} />
                ),
              )
            ) : (
              // Mientras llega la conversación (o si no se pudo leer), lo que ya se sabe de esta respuesta.
              <>
                {target.question ? (
                  <p className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-3 py-2.5 font-semibold">
                    <span className="sr-only">Escribió: </span>
                    {target.question}
                  </p>
                ) : null}
                <div className="flex max-w-[85%] flex-col gap-1 self-end">
                  <span className="self-end text-xs font-bold text-primary-soft-foreground">{replyLabel}</span>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary-soft px-3 py-2.5">{target.reply || "—"}</p>
                </div>
                {target.teamReply ? (
                  <TeamMessage label="Tu equipo escribió después" body={target.teamReply} onUse={() => form.setFieldValue("correctedReply", target.teamReply ?? "")} />
                ) : null}
              </>
            )}
          </section>

          {notFound ? null : (
            <section aria-labelledby="corregir-basado" className="flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm">
              <h3 id="corregir-basado" className="text-xs font-bold text-muted-foreground">
                En qué se basó
              </h3>
              {data.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {data.map((item) => (
                    <li key={`${item.kind}-${item.label}-${item.detail ?? ""}`}>
                      {item.label}
                      {item.detail ? `: ${item.detail}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No consultó ninguna fuente: respondió con lo que había en la conversación.</p>
              )}
              {isMobile ? null : (
                <>
                  {target.checks ? <p className="text-muted-foreground">{checksLine(target.checks)}</p> : null}
                  {lessons.length > 0 ? (
                    <p>
                      {lessons.length === 1 ? "Aplicó una lección tuya: " : "Aplicó lecciones tuyas: "}
                      {lessons.map((item) => `«${item.detail ?? item.label}»`).join(", ")}.
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No usó ninguna lección tuya. Cuando usa una, aparece aquí.</p>
                  )}
                </>
              )}
            </section>
          )}

          {target.why && !isMobile ? (
            <section aria-labelledby="corregir-porque" className="flex flex-col gap-1 rounded-xl bg-warning-soft px-3.5 py-3 text-sm">
              <h3 id="corregir-porque" className="text-xs font-bold text-warning">
                Por qué está aquí
              </h3>
              <p>{target.why}</p>
            </section>
          ) : null}

          <form.AppField name="failure">
            {(field) => (
              <field.Group legend="¿Qué falló?">
                {(control) => (
                  <div className={isMobile ? "grid grid-cols-2 gap-1.5" : "flex flex-wrap gap-1.5"} aria-describedby={control.describedBy}>
                    {FAILURE_OPTIONS.map((option, index) => {
                      const selected = field.state.value === option.value
                      return (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-pressed={selected}
                          className={cn(
                            "min-h-11 sm:min-h-9",
                            isMobile ? "rounded-xl" : "rounded-full",
                            // Número impar de opciones: la última ocupa la fila entera en teléfono.
                            isMobile && index === FAILURE_OPTIONS.length - 1 && FAILURE_OPTIONS.length % 2 === 1 ? "col-span-2" : "",
                            selected ? "border-primary bg-primary-soft font-bold text-primary-soft-foreground ring-1 ring-primary hover:bg-primary-soft" : "",
                          )}
                          onClick={() => {
                            field.handleChange(option.value)
                            field.handleBlur()
                          }}
                        >
                          {option.label}
                        </Button>
                      )
                    })}
                  </div>
                )}
              </field.Group>
            )}
          </form.AppField>

          {notFound && official && answers.length > 0 ? (
            <form.AppField name="existingId">
              {(field) => (
                <field.SelectField
                  id="corregir-existente"
                  label="¿Ya tienes una respuesta para esto?"
                  description="Si eliges una, esta forma de preguntar se suma a esa respuesta y no se crea otra."
                  options={[{ value: "", label: "No, escribir una nueva" }, ...answers.map((entry) => ({ value: entry.id, label: entry.title }))]}
                />
              )}
            </form.AppField>
          ) : null}

          {adding ? null : (
            <>
              {notFound && official ? (
                <form.AppField name="question">
                  {(field) => <field.TextField id="corregir-pregunta" label="La pregunta" maxLength={QUESTION_CHARS} />}
                </form.AppField>
              ) : null}
              <form.AppField name="correctedReply">
                {(field) => (
                  <field.TextareaField
                    id="corregir-respuesta"
                    label={<span className="font-bold">{needsText ? "¿Cómo debió responder?" : "¿Qué debió hacer? (opcional)"}</span>}
                    description={usedTeam ? "Puse lo que escribió tu equipo. Revisa que responda a esto." : undefined}
                    rows={isMobile ? 3 : 4}
                    maxLength={CORRECTED_REPLY_CHARS}
                    placeholder={needsText ? "Escribe la respuesta correcta." : "Si lo dejas vacío, la regla será pasar el caso a una persona."}
                  />
                )}
              </form.AppField>
            </>
          )}

          <div className={SURFACE_ACTIONS}>
            <SubmitButton type="submit" className="min-h-11 w-full" pending={surface.isSubmitting} disabled={markOk.isPending}>
              {adding ? "Sumar a esa respuesta" : "Enviar corrección"}
            </SubmitButton>
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            {isMobile || !target.reviewItemId ? null : (
              <Button
                type="button"
                variant="ghost"
                className="min-h-10 w-full"
                disabled={markOk.isPending || surface.isSubmitting}
                onClick={() => markOk.mutate()}
              >
                Estuvo bien, quitar de la lista
              </Button>
            )}
            <p aria-live="polite" className="text-center text-sm text-muted-foreground">
              {adding
                ? "Esta forma de preguntar se suma a esa respuesta. Su texto no cambia."
                : `${learnsAs(kind, who ?? receptionName)} Nada cambia hasta que se apruebe.`}
            </p>
          </div>
        </>
      ) : null}
      </div>
    </FormDrawer>
  )
}

/** Lo que el equipo escribió después: se puede usar como punto de partida, pero nunca viene puesto. */
function TeamMessage({ label, body, onUse }: { label: string; body: string; onUse: () => void }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      <span className="text-xs font-bold text-muted-foreground">{label}</span>
      <p className="[overflow-wrap:anywhere] whitespace-pre-wrap rounded-2xl rounded-br-md border bg-card px-3 py-2.5">{body}</p>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onUse}>
        Usar este texto
      </Button>
    </div>
  )
}
