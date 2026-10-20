import { FormDrawer, ImageAdjust, type ImageAdjustValue, renderAdjustedImage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { API_URL } from "../../lib/auth-client"
import { orgSlugFromHostname } from "../../lib/host"

/**
 * La foto del paciente con «Ajustar imagen» (tablero 6): se encuadra, se ve
 * cómo queda y se sube ya recortada a 512 px. «Cancelar» deja la anterior.
 */
export function AvatarDrawer({
  patientId,
  name,
  open,
  onOpenChange,
}: {
  patientId: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState<ImageAdjustValue | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      if (!value) throw new Error("Elige una imagen y encuádrala.")
      const { blob, ext } = await renderAdjustedImage(value)
      const form = new FormData()
      form.append("file", blob, `avatar.${ext}`)
      const slug = orgSlugFromHostname(window.location.hostname)
      const response = await fetch(`${API_URL}/api/patients/${patientId}/avatar`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? `No se pudo guardar la foto (${response.status}).`)
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient-avatar", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
      ])
      setValue(null)
      onOpenChange(false)
    },
  })
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (save.isPending) return
        setValue(null)
        save.reset()
        onOpenChange(false)
      }}
      title="Foto del paciente"
      description="Elige un archivo, arrástralo o toma la foto, y encuádrala antes de guardar."
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
      isDirty={value !== null}
      isSubmitting={save.isPending}
      submitDisabled={!value}
      submitLabel="Guardar"
      error={save.isError ? save.error.message : null}
    >
      {open ? <ImageAdjust shape="person" name={name} disabled={save.isPending} onChange={setValue} /> : null}
    </FormDrawer>
  )
}
