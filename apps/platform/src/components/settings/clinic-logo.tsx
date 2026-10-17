import { Button, Field, FieldDescription, FieldLabel, Input, toast } from "@odentia/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { orgSlugFromHostname } from "../../lib/host"

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"]
const MAX_BYTES = 2 * 1024 * 1024

/**
 * El logo de la clínica (decisión 19): lo ven las personas al abrir el
 * registro y su enlace. Se guarda solo, con su confirmación: no es parte del
 * «Guardar» de los datos.
 */
export function ClinicLogoSettings({ logo, name }: { logo: string | null; name: string }) {
  const id = useId()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const done = async () => {
    setError(null)
    if (input.current) input.current.value = ""
    await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
  }
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append("file", file)
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
      toast.success("Logo guardado")
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "No se pudo guardar el logo."),
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
      <h2 id={`${id}-title`} className="font-heading text-base font-medium">
        Logo
      </h2>
      <div className="flex flex-wrap items-center gap-4">
        {logo ? (
          <img src={logo} alt={`Logo de ${name}`} className="size-16 rounded-lg border bg-white object-contain" />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
            Sin logo
          </div>
        )}
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor={`${id}-file`}>{logo ? "Cambiar el logo" : "Subir el logo"}</FieldLabel>
          <Input
            ref={input}
            id={`${id}-file`}
            type="file"
            accept={ACCEPTED.join(",")}
            disabled={busy}
            aria-describedby={`${id}-help`}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              if (!ACCEPTED.includes(file.type)) return setError("Elige una imagen PNG, JPG o WebP.")
              if (file.size > MAX_BYTES) return setError("El logo no puede superar 2 MB.")
              upload.mutate(file)
            }}
          />
          <FieldDescription id={`${id}-help`}>
            Lo ven tus pacientes al abrir el registro y su enlace. PNG, JPG o WebP, hasta 2 MB.
          </FieldDescription>
        </Field>
        {logo ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => remove.mutate()}>
            {remove.isPending ? "Quitando…" : "Quitar el logo"}
          </Button>
        ) : null}
      </div>
      {upload.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Subiendo el logo…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
