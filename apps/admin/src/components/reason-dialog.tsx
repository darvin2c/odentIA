/**
 * Confirmación con motivo obligatorio (reversar, devolver, anular): el motivo
 * es su propio formulario y el rechazo del servidor se dice dentro del
 * diálogo (el del motivo, junto al campo; lo demás, junto a los botones).
 */
import { ConfirmDialog, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { z } from "zod"

const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo")
    .max(2000, "Escribe el motivo en 2000 caracteres como mucho"),
})

export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  placeholder,
  id,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  placeholder: string
  /** Id del campo del motivo. */
  id: string
  /** Hace la acción con el motivo ya recortado; si lanza, el error queda en el diálogo. */
  onConfirm: (reason: string) => Promise<unknown>
  onClose: () => void
}) {
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: reasonSchema },
    onSubmit: async ({ value, formApi }) => {
      await onConfirm(value.reason.trim())
      formApi.reset()
      onClose()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  return (
    <ConfirmDialog
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      pending={pending}
      error={error}
      onConfirm={() => void submitForm(form)}
      onClose={() => {
        form.reset()
        onClose()
      }}
    >
      <form.AppField name="reason">
        {(field) => <field.TextareaField id={id} label="Motivo" placeholder={placeholder} maxLength={2000} />}
      </form.AppField>
    </ConfirmDialog>
  )
}
