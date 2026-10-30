import { Button, toast } from "@odentia/ui"
import {
  FormDrawer,
  ImageAdjust,
  type ImageAdjustValue,
  renderAdjustedImage,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { orgSlugFromHostname } from "../../lib/host"

/** Sin imagen no hay logo que guardar: se dice junto a «Ajustar imagen». */
const logoSchema = z.object({
  file: z.custom<ImageAdjustValue | null>((value) => value !== null, "Elige el logo y recórtalo."),
})

/**
 * El logo de la clínica (decisión 19): lo ven las personas al abrir el
 * registro y su enlace. Se guarda solo, con su confirmación: no es parte del
 * «Guardar» de los datos. Antes de subirlo se recorta con «Ajustar imagen»
 * (tablero 6 del lienzo de Pacientes): sin tocar el recuadro queda entero.
 * El dato se llama `file`, como en el cuerpo de la subida: lo que rechace el
 * servidor (formato, peso) se dice junto a la imagen.
 */
export function ClinicLogoSettings({ logo, name }: { logo: string | null; name: string }) {
  const id = useId()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = async () => {
    setError(null)
    await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
  }
  const form = useAppForm({
    defaultValues: { file: null as ImageAdjustValue | null },
    validators: { onSubmit: logoSchema },
    onSubmit: async ({ value }) => {
      if (!value.file) return
      const { blob, ext } = await renderAdjustedImage(value.file)
      const body = new FormData()
      body.append("file", blob, `logo.${ext}`)
      const slug = orgSlugFromHostname(window.location.hostname)
      const response = await fetch(`${API_URL}/api/org-profile/logo`, {
        method: "PUT",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body,
      })
      if (!response.ok) {
        const parsed = (await response.json().catch(() => null)) as { error?: ApiError["shape"] } | null
        throw new ApiError(response.status, parsed?.error ?? {})
      }
      await done()
      form.reset()
      setOpen(false)
      toast.success("Logo guardado")
    },
  })
  const surface = useFormSurface(form)
  const uploading = useStore(form.store, (state) => state.isSubmitting)
  const remove = useMutation({
    mutationFn: () => apiFetch("/api/org-profile/logo", { method: "DELETE" }),
    onSuccess: async () => {
      await done()
      toast.success("Logo quitado")
    },
    onError: (cause) => setError(submitErrorMessage(cause)),
  })
  const busy = uploading || remove.isPending
  return (
    <section aria-labelledby={`${id}-title`} className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="font-heading text-base font-medium">
          Logo
        </h2>
        <p className="text-sm text-muted-foreground">Lo ven tus pacientes al abrir el registro y su enlace.</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {logo ? (
          <img src={logo} alt={`Logo de ${name}`} className="size-16 rounded-lg border bg-white object-contain" />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
            Sin logo
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
            {logo ? "Cambiar el logo" : "Subir el logo"}
          </Button>
          {logo ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => remove.mutate()}>
              {remove.isPending ? "Quitando…" : "Quitar el logo"}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <FormDrawer
        {...surface}
        open={open}
        onClose={() => {
          form.reset()
          setOpen(false)
        }}
        title="Logo de la clínica"
        description="Elige el archivo o arrástralo y deja solo el logo, sin márgenes de sobra."
        submitLabel="Guardar"
      >
        {open ? (
          <form.AppField name="file">
            {(field) => (
              <field.Group legend={<span className="sr-only">Logo de {name}</span>}>
                {(control) => (
                  <ImageAdjust
                    shape="logo"
                    name={name}
                    disabled={uploading}
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
        ) : null}
      </FormDrawer>
    </section>
  )
}
