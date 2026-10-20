import { Button, toast } from "@odentia/ui"
import { FormDrawer, ImageAdjust, type ImageAdjustValue, renderAdjustedImage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { orgSlugFromHostname } from "../../lib/host"

/**
 * El logo de la clínica (decisión 19): lo ven las personas al abrir el
 * registro y su enlace. Se guarda solo, con su confirmación: no es parte del
 * «Guardar» de los datos. Antes de subirlo se recorta con «Ajustar imagen»
 * (tablero 6 del lienzo de Pacientes): sin tocar el recuadro queda entero.
 */
export function ClinicLogoSettings({ logo, name }: { logo: string | null; name: string }) {
  const id = useId()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<ImageAdjustValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = async () => {
    setError(null)
    await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
  }
  const upload = useMutation({
    mutationFn: async () => {
      if (!value) throw new Error("Elige el logo y recórtalo.")
      const { blob, ext } = await renderAdjustedImage(value)
      const form = new FormData()
      form.append("file", blob, `logo.${ext}`)
      const slug = orgSlugFromHostname(window.location.hostname)
      const response = await fetch(`${API_URL}/api/org-profile/logo`, {
        method: "PUT",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? "No se pudo guardar el logo.")
      }
    },
    onSuccess: async () => {
      await done()
      setValue(null)
      setOpen(false)
      toast.success("Logo guardado")
    },
  })
  const remove = useMutation({
    mutationFn: () => apiFetch("/api/org-profile/logo", { method: "DELETE" }),
    onSuccess: async () => {
      await done()
      toast.success("Logo quitado")
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? (cause.shape.message ?? "No se pudo quitar el logo.") : "No se pudo quitar el logo."),
  })
  const busy = upload.isPending || remove.isPending
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
        open={open}
        onClose={() => {
          if (upload.isPending) return
          setValue(null)
          upload.reset()
          setOpen(false)
        }}
        title="Logo de la clínica"
        description="Elige el archivo o arrástralo y deja solo el logo, sin márgenes de sobra."
        onSubmit={(event) => {
          event.preventDefault()
          upload.mutate()
        }}
        isDirty={value !== null}
        isSubmitting={upload.isPending}
        submitDisabled={!value}
        submitLabel="Guardar"
        error={upload.isError ? upload.error.message : null}
      >
        {open ? <ImageAdjust shape="logo" name={name} disabled={upload.isPending} onChange={setValue} /> : null}
      </FormDrawer>
    </section>
  )
}
