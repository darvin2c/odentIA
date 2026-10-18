import { Checkbox, Field, FieldError, FieldGroup, FieldLabel, Input, Separator, toast } from "@odentia/ui"
import { AuthSplit, fieldErrorMessages, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { AuthLegal, RecoverAside, WelcomeAside } from "../lib/auth-screens"
import { BASE_DOMAIN } from "../lib/host"

export const Route = createFileRoute("/two-factor")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(String(search.enlace) === "1" ? { enlace: 1 as const } : {}),
  }),
  component: TwoFactorPage,
})

/** Mismo criterio que el login: dominio base https o loopback en dev. */
function safeNext(next: string | undefined): string | null {
  if (!next) return null
  try {
    const url = new URL(next)
    const host = url.hostname
    if (host === "localhost" || host === "127.0.0.1") {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null
      return url.href
    }
    if (url.protocol !== "https:") return null
    if (host !== BASE_DOMAIN && !host.endsWith(`.${BASE_DOMAIN}`)) return null
    return url.href
  } catch {
    return null
  }
}

const challenge = z.object({
  code: z.string().trim().min(4, "Ingresa el código").max(32),
})

/**
 * Segundo paso del login cuando la cuenta tiene TOTP (incluye el retorno del
 * admin: `?next=` al dominio admin). Sin sesión pendiente vuelve al login.
 */
function TwoFactorPage() {
  const navigate = useNavigate()
  const { next, enlace } = useSearch({ from: "/two-factor" })
  const form = useForm({
    defaultValues: { code: "", recovery: false },
    validators: {
      onSubmit: z.object({ code: challenge.shape.code, recovery: z.boolean() }),
    },
    onSubmit: async ({ value }) => {
      const target = safeNext(next)
      try {
        const result = value.recovery
          ? await authClient.twoFactor.verifyBackupCode({ code: value.code })
          : await authClient.twoFactor.verifyTotp({ code: value.code })
        if (result.error) {
          toast.error("Código incorrecto o caducado. Revisa tu app de autenticación.")
          return
        }
      } catch {
        toast.error("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.")
        return
      }
      if (target) {
        window.location.assign(target)
        return
      }
      const { data: orgs } = await authClient.organization.list()
      await navigate({ to: orgs && orgs.length > 0 ? "/" : "/onboarding" })
    },
  })

  return (
    <AuthSplit
      title={enlace ? "Un paso más" : "Verifica tu identidad"}
      description={
        enlace
          ? "El enlace confirmó tu correo. Tu cuenta pide además el código de tu app de autenticación."
          : "Escribe el código de tu app de autenticación."
      }
      aside={enlace ? <RecoverAside /> : <WelcomeAside />}
      legal={<AuthLegal />}
      footer={
        <Link to="/login" className="underline">
          Volver a entrar
        </Link>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <FieldGroup className="gap-4">
          <form.Field name="code">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="code">Código de 6 dígitos</FieldLabel>
                <Input
                  id="code"
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  aria-describedby={field.state.meta.errors.length ? "code-error" : undefined}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={32}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError id="code-error">
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="recovery">
            {(field) => (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  id="recovery"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked === true)}
                />
                <label htmlFor="recovery">Es un código de respaldo (de un solo uso)</label>
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                Entrar
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
      <div className="flex items-center gap-3">
        <Separator className="flex-1" aria-hidden />
      </div>
      <p className="text-xs text-muted-foreground">
        Perdiste tu app y tus códigos: pide a otro admin un reseteo de factor con tu identidad verificada.
      </p>
    </AuthSplit>
  )
}
