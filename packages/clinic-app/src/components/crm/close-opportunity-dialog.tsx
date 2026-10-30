import { cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { ConfirmDialog, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { CLOSE_REASON_LABEL, LOST_REASONS, type OpportunityDetail } from "../../lib/crm"

export interface CloseTarget {
  id: string
  title: string
  /** null: se pregunta (al soltar la tarjeta en «Decidió»). */
  outcome: "won" | "lost" | null
}

interface CloseValues {
  outcome: "won" | "lost" | ""
  reason: string
  note: string
}

const closeSchema = z
  .object({
    outcome: z.enum(["won", "lost", ""]),
    reason: z.string(),
    note: z.string().max(500, "Escribe como mucho 500 caracteres."),
  })
  .superRefine((value, ctx) => {
    if (!value.outcome) ctx.addIssue({ code: "custom", path: ["outcome"], message: "Elige si se ganó o se perdió." })
    if (value.outcome === "lost" && !value.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Elige por qué se perdió." })
    }
  })

function initialValues(target: CloseTarget | null): CloseValues {
  return { outcome: target?.outcome ?? "", reason: target?.outcome === "won" ? "acepto" : "", note: "" }
}

const CHIP = "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal"

/**
 * La única forma de cerrar una oportunidad (ADR 0028): desde la tarjeta del
 * tablero, «Mover a… Decidió», el arrastre a «Decidió» o la oportunidad
 * abierta. Perdida pide un motivo de la lista (precio, eligió otra clínica, no
 * responde, ya no lo necesita, otro); ganada solo admite una nota. Aceptar o
 * rechazar un presupuesto la cierra sola, sin pasar por aquí.
 */
export function CloseOpportunityDialog({
  target,
  onClose,
  onClosed,
}: {
  target: CloseTarget | null
  onClose: () => void
  onClosed: (detail: OpportunityDetail) => void
}) {
  const close = useMutation({
    mutationFn: (input: { id: string; body: { outcome: "won" | "lost"; reason: string; note: string | null } }) =>
      apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${input.id}/close`, {
        method: "POST",
        body: JSON.stringify(input.body),
      }),
  })
  const form = useAppForm({
    defaultValues: initialValues(target),
    validators: { onSubmit: closeSchema },
    onSubmit: async ({ value }) => {
      if (!target || !value.outcome) return
      const result = await close.mutateAsync({
        id: target.id,
        body: { outcome: value.outcome, reason: value.reason, note: value.note.trim() || null },
      })
      onClosed(result.data)
    },
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia una vez por apertura
  useEffect(() => {
    form.reset(initialValues(target))
  }, [target?.id, target?.outcome])
  const outcome = useStore(form.store, (state) => state.values.outcome)
  const reason = useStore(form.store, (state) => state.values.reason)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const error = useFormSubmitError(form)
  const won = outcome === "won"
  return (
    <ConfirmDialog
      open={target !== null}
      title={!outcome ? `¿Qué decidió? ${target?.title ?? ""}` : won ? `Ganada: ${target?.title ?? ""}` : `Perdida: ${target?.title ?? ""}`}
      description={
        !outcome
          ? "Pasa a «Decidió». Si aceptó o rechazó un presupuesto en la aplicación, ya se cerró sola."
          : won
            ? "Pasa a «Decidió» como ganada. Si aceptó un presupuesto en la aplicación, ya se cerró sola."
            : "Pasa a «Decidió» como perdida, con su motivo. Su tarea se cierra sola."
      }
      confirmLabel={!outcome ? "Cerrar" : won ? "Marcar ganada" : "Marcar perdida"}
      variant={outcome === "lost" ? "destructive" : "default"}
      pending={pending}
      error={error}
      onConfirm={() => void submitForm(form)}
      onClose={onClose}
    >
      {target?.outcome === null ? (
        <form.AppField name="outcome">
          {(field) => (
            <field.Group legend="¿Cómo terminó?">
              {(control) => (
                <RadioGroup
                  id={control.id}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  className="flex flex-wrap gap-2"
                  value={field.state.value}
                  onValueChange={(next) => {
                    const value = next === "won" ? "won" : "lost"
                    field.handleChange(value)
                    form.setFieldValue("reason", value === "won" ? "acepto" : "")
                  }}
                >
                  {(["won", "lost"] as const).map((key) => (
                    <FieldLabel key={key} className={cn(CHIP, field.state.value === key && "border-primary bg-primary-soft")}>
                      <RadioGroupItem value={key} />
                      {key === "won" ? "Ganada" : "Perdida"}
                    </FieldLabel>
                  ))}
                </RadioGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
      ) : null}
      {outcome === "lost" ? (
        <form.AppField name="reason">
          {(field) => (
            <field.Group legend="¿Por qué se perdió?">
              {(control) => (
                <RadioGroup
                  id={control.id}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  className="flex flex-wrap gap-2"
                  value={field.state.value}
                  onValueChange={(next) => field.handleChange(String(next))}
                >
                  {LOST_REASONS.map((key) => (
                    <FieldLabel key={key} className={cn(CHIP, field.state.value === key && "border-primary bg-primary-soft")}>
                      <RadioGroupItem value={key} />
                      {CLOSE_REASON_LABEL[key]}
                    </FieldLabel>
                  ))}
                </RadioGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
      ) : null}
      <form.AppField name="note">
        {(field) => (
          <field.TextareaField
            label={reason === "otro" ? "Cuéntalo en una frase" : "Nota (opcional)"}
            rows={2}
            maxLength={500}
            placeholder={won ? "Lo aceptó por teléfono" : "Le quedaba más cerca otra clínica"}
          />
        )}
      </form.AppField>
    </ConfirmDialog>
  )
}
