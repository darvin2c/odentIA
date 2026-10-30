import { Button } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

const MAX_LENGTH = 4000

const noteSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, "Escribe la nota clínica.")
    .max(MAX_LENGTH, `Escribe como mucho ${MAX_LENGTH} caracteres.`),
})

export function QuickNoteDrawer({
  patientId,
  encounterId,
  onSaved,
}: {
  patientId: string
  encounterId?: string
  onSaved?: () => void
}) {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (note: string) =>
      apiFetch(`/api/patients/${patientId}/notes`, {
        method: "POST",
        body: JSON.stringify({
          note,
          ...(encounterId ? { encounterId } : {}),
        }),
      }),
  })
  const form = useAppForm({
    defaultValues: { note: "" },
    validators: { onSubmit: noteSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value.note.trim())
      form.reset({ note: "" })
      setOpen(false)
      for (const key of ["patient-notes", "timeline", "patient-summary", "encounter"])
        void queryClient.invalidateQueries({ queryKey: [key, patientId] })
      onSaved?.()
    },
  })
  const surface = useFormSurface(form)
  const length = useStore(form.store, (state) => state.values.note.length)
  if (!canWrite) return null
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          form.reset({ note: "" })
          setOpen(true)
        }}
      >
        Nota clínica
      </Button>
      <FormDrawer
        {...surface}
        open={open}
        onClose={() => {
          if (!surface.isSubmitting) setOpen(false)
        }}
        title="Nota clínica"
        description="Para lo clínico que ocurre fuera de una atención. Es inmutable: una corrección va en otra nota. Lo administrativo (una llamada, un acuerdo) va en las notas de la persona, en su Resumen; los diagnósticos, en la atención."
        submitLabel={surface.isSubmitting ? "Guardando…" : "Guardar nota"}
      >
        <div className="flex flex-col gap-4">
          <form.AppField name="note">
            {(field) => (
              <field.TextareaField
                label="Nota clínica"
                description={`${length}/${MAX_LENGTH}`}
                maxLength={MAX_LENGTH}
                rows={5}
                disabled={surface.isSubmitting}
              />
            )}
          </form.AppField>
        </div>
      </FormDrawer>
    </>
  )
}
