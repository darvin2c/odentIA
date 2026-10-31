import { Button } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

const MAX_LENGTH = 4000

const addendumSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Escribe la corrección.")
    .max(MAX_LENGTH, `Escribe como mucho ${MAX_LENGTH} caracteres.`),
})

/**
 * Corrección inmutable sobre una atención finalizada (POST {text}, máx. 4000).
 * Vista de lectura con botón propio: la adenda se añade (append-only) en un
 * FormDrawer hermano, nunca se edita el contenido original.
 */
export function EncounterAddendumDrawer({
  patientId,
  encounterId,
  onSaved,
}: {
  patientId: string
  encounterId: string
  onSaved?: () => void
}) {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/patients/${patientId}/encounters/${encounterId}/addenda`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
  })
  const form = useAppForm({
    defaultValues: { text: "" },
    validators: { onSubmit: addendumSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value.text.trim())
      form.reset({ text: "" })
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] })
      void queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      onSaved?.()
    },
  })
  const surface = useFormSurface(form)
  const length = useStore(form.store, (state) => state.values.text.length)

  if (!canWrite) return null

  const handleClose = () => {
    // Durante el guardado no se cierra: el error y el texto se conservan.
    if (surface.isSubmitting) return
    form.reset({ text: "" })
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          form.reset({ text: "" })
          setOpen(true)
        }}
      >
        Agregar corrección
      </Button>
      <FormDrawer
        {...surface}
        open={open}
        onClose={handleClose}
        title="Agregar corrección (adenda)"
        description="Corrección posterior al cierre. Las adendas son inmutables: no se pueden editar ni eliminar."
        submitLabel={surface.isSubmitting ? "Guardando…" : "Guardar corrección"}
      >
        <form.AppField name="text">
          {(field) => (
            <field.TextareaField
              label="Corrección"
              description={`${length}/${MAX_LENGTH} · Las adendas son inmutables: no se pueden editar ni eliminar.`}
              maxLength={MAX_LENGTH}
              rows={4}
              disabled={surface.isSubmitting}
              placeholder="Corrección posterior al cierre…"
            />
          )}
        </form.AppField>
      </FormDrawer>
    </>
  )
}
