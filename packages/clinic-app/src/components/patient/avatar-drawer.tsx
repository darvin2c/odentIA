import { Button, toast } from "@odentia/ui"
import {
  FormDrawer,
  ImageAdjust,
  type ImageAdjustValue,
  renderAdjustedImage,
  setSubmitErrors,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import { apiFetch, apiUpload } from "../../lib/api"

/** Sin imagen no hay foto que guardar: se dice junto a «Ajustar imagen». */
const avatarSchema = z.object({
  file: z.custom<ImageAdjustValue | null>((value) => value !== null, "Elige una imagen y encuádrala."),
})

/**
 * La foto del paciente con «Ajustar imagen» (tablero 6): se encuadra, se ve
 * cómo queda y se sube ya recortada a 512 px. «Cancelar» deja la anterior.
 * El dato se llama `file`, como en el cuerpo de la subida: lo que rechace el
 * servidor (formato, peso) se dice junto a la imagen. «Quitar foto» deja sus
 * iniciales; va lejos de «Guardar» y solo aparece si tiene una y no se está
 * encuadrando otra, que se perdería sin avisar.
 */
export function AvatarDrawer({
  patientId,
  name,
  hasPhoto,
  open,
  onOpenChange,
}: {
  patientId: string
  name: string
  hasPhoto: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const form = useAppForm({
    defaultValues: { file: null as ImageAdjustValue | null },
    validators: { onSubmit: avatarSchema },
    onSubmit: async ({ value }) => {
      if (!value.file) return
      const { blob, ext } = await renderAdjustedImage(value.file)
      const body = new FormData()
      body.append("file", blob, `avatar.${ext}`)
      await apiUpload(`/api/patients/${patientId}/avatar`, body)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient-avatar", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
        // La página de la persona trae la clave de la foto: sin esto, la
        // primera foto no se ve hasta recargar.
        queryClient.invalidateQueries({ queryKey: ["person"] }),
      ])
      onOpenChange(false)
    },
  })
  const surface = useFormSurface(form)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const framing = useStore(form.store, (state) => state.values.file !== null)
  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/patients/${patientId}/avatar`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["person"] }),
      ])
      toast.success("Foto quitada")
      onOpenChange(false)
    },
    onError: (cause) => setSubmitErrors(form, { form: submitErrorMessage(cause) }),
  })
  const submitting = saving || remove.isPending
  useEffect(() => {
    if (!open) form.reset()
  }, [open, form])
  return (
    <FormDrawer
      {...surface}
      isSubmitting={submitting}
      open={open}
      onClose={() => {
        if (!submitting) onOpenChange(false)
      }}
      title="Foto del paciente"
      description="Elige un archivo, arrástralo o toma la foto, y encuádrala antes de guardar."
      submitLabel="Guardar"
    >
      {open ? (
        <>
          <form.AppField name="file">
            {(field) => (
              <field.Group legend={<span className="sr-only">Foto de {name}</span>}>
                {(control) => (
                  <ImageAdjust
                    shape="person"
                    name={name}
                    disabled={submitting}
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => {
                      field.handleChange(next)
                      if (next) field.handleBlur()
                    }}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
          {hasPhoto && !framing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 self-start"
              disabled={submitting}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Quitando…" : "Quitar foto"}
            </Button>
          ) : null}
        </>
      ) : null}
    </FormDrawer>
  )
}
