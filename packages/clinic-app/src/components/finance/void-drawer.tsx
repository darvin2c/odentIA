/** Confirmación de una anulación en Finanzas: siempre en cajón y siempre con motivo. */
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useEffect } from "react"
import { z } from "zod"
import { cashFormMessage } from "../../lib/finance-cash"

const MAX_REASON = 2000

const voidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo de la anulación.")
    .max(MAX_REASON, `Escribe el motivo en ${MAX_REASON} caracteres como mucho.`),
})

/**
 * `onConfirm` hace la anulación y devuelve su promesa (`mutateAsync`): si la
 * rechaza, el motivo del rechazo se dice junto a los botones, con las palabras
 * de caja (`cashFormMessage`), y el motivo escrito se conserva.
 */
export function VoidDrawer({
  open,
  title,
  description,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  onClose: () => void
  onConfirm: (reason: string) => Promise<unknown>
}) {
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: voidSchema },
    onSubmit: async ({ value }) => {
      await onConfirm(value.reason.trim())
    },
  })
  const surface = useFormSurface(form, { formMessage: cashFormMessage })

  // Cada apertura empieza con el motivo en blanco.
  useEffect(() => {
    if (open) form.reset()
  }, [open, form])

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      title={title}
      description={description}
      submitLabel="Anular"
      cancelLabel="No anular"
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <form.AppField name="reason">
        {(field) => <field.TextareaField label="Motivo" maxLength={MAX_REASON} />}
      </form.AppField>
    </FormDrawer>
  )
}
