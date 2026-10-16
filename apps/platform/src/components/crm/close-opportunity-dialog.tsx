import { cn, Field, FieldLabel, FieldLegend, FieldSet, RadioGroup, RadioGroupItem, Textarea } from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { CLOSE_REASON_LABEL, LOST_REASONS, type OpportunityDetail } from "../../lib/crm"

export interface CloseTarget {
  id: string
  title: string
  /** null: se pregunta (al soltar la tarjeta en «Decidió»). */
  outcome: "won" | "lost" | null
}

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
  const ids = useId()
  const [outcome, setOutcome] = useState<"won" | "lost" | null>(null)
  const [reason, setReason] = useState<string>("")
  const [note, setNote] = useState("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia una vez por apertura
  useEffect(() => {
    setOutcome(target?.outcome ?? null)
    setReason(target?.outcome === "won" ? "acepto" : "")
    setNote("")
    close.reset()
  }, [target?.id, target?.outcome])
  const close = useMutation({
    mutationFn: () =>
      apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${target!.id}/close`, {
        method: "POST",
        body: JSON.stringify({ outcome, reason, note: note.trim() || null }),
      }),
    onSuccess: (result) => onClosed(result.data),
  })
  const won = outcome === "won"
  const error = close.error instanceof ApiError ? (close.error.shape.message ?? close.error.message) : close.error ? "No se pudo cerrar la oportunidad." : null
  return (
    <ConfirmDialog
      open={target !== null}
      title={outcome === null ? `¿Qué decidió? ${target?.title ?? ""}` : won ? `Ganada: ${target?.title ?? ""}` : `Perdida: ${target?.title ?? ""}`}
      description={
        outcome === null
          ? "Pasa a «Decidió». Si aceptó o rechazó un presupuesto en la aplicación, ya se cerró sola."
          : won
            ? "Pasa a «Decidió» como ganada. Si aceptó un presupuesto en la aplicación, ya se cerró sola."
            : "Pasa a «Decidió» como perdida, con su motivo. Su tarea se cierra sola."
      }
      confirmLabel={outcome === null ? "Cerrar" : won ? "Marcar ganada" : "Marcar perdida"}
      variant={outcome === "lost" ? "destructive" : "default"}
      pending={close.isPending}
      confirmDisabled={!outcome || !reason}
      onConfirm={() => close.mutate()}
      onClose={onClose}
    >
      {target?.outcome === null ? (
        <FieldSet>
          <FieldLegend variant="label">¿Cómo terminó?</FieldLegend>
          <RadioGroup
            className="flex flex-wrap gap-2"
            value={outcome ?? ""}
            onValueChange={(next) => {
              const value = next === "won" ? "won" : "lost"
              setOutcome(value)
              setReason(value === "won" ? "acepto" : "")
            }}
          >
            {(["won", "lost"] as const).map((key) => (
              <FieldLabel
                key={key}
                className={cn(
                  "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
                  outcome === key && "border-primary bg-primary-soft",
                )}
              >
                <RadioGroupItem value={key} />
                {key === "won" ? "Ganada" : "Perdida"}
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>
      ) : null}
      {outcome === "lost" ? (
        <FieldSet>
          <FieldLegend variant="label">¿Por qué se perdió?</FieldLegend>
          <RadioGroup className="flex flex-wrap gap-2" value={reason} onValueChange={(next) => setReason(String(next))}>
            {LOST_REASONS.map((key) => (
              <FieldLabel
                key={key}
                className={cn(
                  "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
                  reason === key && "border-primary bg-primary-soft",
                )}
              >
                <RadioGroupItem value={key} />
                {CLOSE_REASON_LABEL[key]}
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${ids}-nota`}>{reason === "otro" ? "Cuéntalo en una frase" : "Nota (opcional)"}</FieldLabel>
        <Textarea
          id={`${ids}-nota`}
          rows={2}
          maxLength={500}
          value={note}
          placeholder={won ? "Lo aceptó por teléfono" : "Le quedaba más cerca otra clínica"}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  )
}
