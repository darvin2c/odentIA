import { Button, cn, useIsMobile } from "@odentia/ui"
import { FormDrawer, SubmitButton, submitErrorMessage, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import {
  ANSWER_CHECK_LABEL,
  type AnswerBasisItem,
  type AnswerCheck,
  agentName,
  type CorrectionFailure,
  FAILURE_OPTIONS,
  type LessonItem,
} from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"

const CORRECTED_REPLY_CHARS = 2000

/**
 * Lo que pide `POST /api/agent/learning/corrections`, con sus mismas palabras.
 * «No debió responder» no necesita una respuesta alternativa: la regla es pasar el caso.
 */
const correctionSchema = z
  .object({ failure: z.custom<CorrectionFailure | "">((value) => typeof value === "string"), correctedReply: z.string() })
  .superRefine((value, ctx) => {
    if (!FAILURE_OPTIONS.some((option) => option.value === value.failure)) {
      ctx.addIssue({ code: "custom", path: ["failure"], message: "Elige qué falló" })
    }
    const text = value.correctedReply.trim()
    if (!text && value.failure !== "no_debio_responder") {
      ctx.addIssue({ code: "custom", path: ["correctedReply"], message: "Escribe cómo debió responder" })
    }
    if (text.length > CORRECTED_REPLY_CHARS) {
      ctx.addIssue({ code: "custom", path: ["correctedReply"], message: `La respuesta admite hasta ${CORRECTED_REPLY_CHARS} caracteres` })
    }
  })

/** La respuesta que se corrige: una entrada de «Por revisar» o una respuesta marcada desde la Bandeja. */
export interface CorrectionTarget {
  reviewItemId?: string
  traceId?: string
  /** El agente que respondió, cuando se sabe: va en el antetítulo. */
  agent?: string
  question: string
  reply: string
  /** Lo que respondió el equipo después, si lo hubo: punto de partida de la corrección. */
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

/**
 * Corregir una respuesta del agente: qué falló y cómo debió responder. No
 * cambia nada todavía: deja una lección propuesta que aprueba quien administra.
 * En teléfono queda lo justo para corregir: la respuesta, en qué se basó, qué
 * falló y cómo debió responder.
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
  const isMobile = useIsMobile()
  const receptionName = useReceptionName()
  const who = target?.agent ? agentName(target.agent, receptionName) : null
  const correct = useMutation({
    retry: false,
    mutationFn: (input: { failure: CorrectionFailure; correctedReply: string }) =>
      apiFetch<{ data: LessonItem }>("/api/agent/learning/corrections", {
        method: "POST",
        body: JSON.stringify({
          ...(target?.reviewItemId ? { reviewItemId: target.reviewItemId } : { traceId: target?.traceId }),
          failure: input.failure,
          ...(input.correctedReply ? { correctedReply: input.correctedReply } : {}),
        }),
      }),
  })
  const form = useAppForm({
    defaultValues: { failure: "" as CorrectionFailure | "", correctedReply: "" },
    validators: { onSubmit: correctionSchema },
    onSubmit: async ({ value }) => {
      const response = await correct.mutateAsync({ failure: value.failure as CorrectionFailure, correctedReply: value.correctedReply.trim() })
      refresh()
      onCorrected?.(response.data)
      onClose()
    },
  })
  useEffect(() => {
    if (!target) return
    form.reset({ failure: "", correctedReply: target.teamReply ?? "" })
  }, [target, form])
  // El error del envío no va arriba del cajón: se dice junto a «Enviar corrección».
  const { error: submitError, ...surface } = useFormSurface(form)
  const failure = useStore(form.store, (state) => state.values.failure)
  const text = useStore(form.store, (state) => state.values.correctedReply)

  const refresh = () => {
    for (const key of ["agent-learning", "agent-overview"]) void queryClient.invalidateQueries({ queryKey: [key] })
  }
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
  // Lo que falló al enviar o al darla por buena, junto a esas acciones (el pie propio).
  const actionError = submitError ?? (markOk.isError ? submitErrorMessage(markOk.error) : null)

  const data = target?.basis.filter((item) => item.kind !== "leccion") ?? []
  const lessons = target?.basis.filter((item) => item.kind === "leccion") ?? []

  return (
    <FormDrawer
      {...surface}
      open={target !== null}
      onClose={() => {
        correct.reset()
        markOk.reset()
        onClose()
      }}
      title={who ? `Corregir una respuesta de ${who}` : "Corregir una respuesta"}
      headerContent={
        target ? (
          <p className="font-heading text-lg leading-snug font-semibold text-foreground">{target.question || "Respuesta del agente"}</p>
        ) : undefined
      }
      cancelLabel="Cancelar"
      hideSubmit
    >
      <div className="flex flex-col gap-4">
      {target ? (
        <>
          {isMobile ? (
            <section aria-label="La respuesta" className="flex flex-col gap-0.5 rounded-2xl rounded-bl-md bg-primary-soft px-3 py-2.5 text-sm">
              <h3 className="text-xs font-bold text-primary-soft-foreground">{who ?? receptionName} respondió</h3>
              <p className="whitespace-pre-wrap">{target.reply}</p>
            </section>
          ) : (
            <section aria-label="La respuesta" className="flex flex-col gap-2 text-sm">
              {target.question ? (
                <p className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-3 py-2.5">
                  <span className="sr-only">Preguntó: </span>
                  {target.question}
                </p>
              ) : null}
              <div className="flex max-w-[85%] flex-col gap-1 self-end">
                <span className="self-end text-xs font-bold text-primary-soft-foreground">Agente</span>
                <p className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary-soft px-3 py-2.5">{target.reply}</p>
              </div>
            </section>
          )}

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

          <form.AppField name="correctedReply">
            {(field) => (
              <field.TextareaField
                id="corregir-respuesta"
                label={<span className="font-bold">{needsText ? "¿Cómo debió responder?" : "¿Qué debió hacer? (opcional)"}</span>}
                description={target.teamReply && text === target.teamReply ? "Puse lo que respondió tu equipo. Cámbialo si quieres." : undefined}
                rows={isMobile ? 3 : 4}
                maxLength={CORRECTED_REPLY_CHARS}
                placeholder={needsText ? "Escribe la respuesta correcta." : "Si lo dejas vacío, la regla será pasar el caso a una persona."}
              />
            )}
          </form.AppField>

          <div className={SURFACE_ACTIONS}>
            <SubmitButton type="submit" className="min-h-11 w-full" pending={surface.isSubmitting} disabled={markOk.isPending}>
              Enviar corrección
            </SubmitButton>
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            {isMobile ? null : (
              <>
                {target.reviewItemId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-10 w-full"
                    disabled={markOk.isPending || surface.isSubmitting}
                    onClick={() => markOk.mutate()}
                  >
                    Estuvo bien, quitar de la lista
                  </Button>
                ) : null}
                <p className="text-center text-sm text-muted-foreground">
                  Con tu corrección se propone qué aprender. Nada cambia hasta que se apruebe.
                </p>
              </>
            )}
          </div>
        </>
      ) : null}
      </div>
    </FormDrawer>
  )
}
