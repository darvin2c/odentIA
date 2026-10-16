import { Field, FieldError, FieldGroup, FieldLabel, Input, Separator, toast } from "@odentia/ui"
import { AuthSplit, fieldErrorMessages, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { GoogleAuthButton } from "../lib/google-auth"
import { BASE_DOMAIN } from "../lib/host"

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(search.oauth2fa === "1" ? { oauth2fa: "1" as const } : {}),
  }),
  component: LoginPage,
})

/** Solo redirige a URLs https del dominio base (panel, tenants, admin) o loopback en dev. */
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

const credentials = z.object({
  email: z.string().email("Correo inválido"),
  password: z.string().min(1, "Ingresa tu contraseña"),
})

const twoFactorRedirect = z.looseObject({ twoFactorRedirect: z.boolean().optional() })

function LoginPage() {
  const navigate = useNavigate()
  const { next, oauth2fa } = useSearch({ from: "/login" })
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: credentials },
    onSubmit: async ({ value }) => {
      let signInError: { code?: string } | null
      let needsTwoFactor = false
      try {
        const result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        })
        signInError = result.error
        const redirect = twoFactorRedirect.safeParse(result.data)
        needsTwoFactor = redirect.success && redirect.data.twoFactorRedirect === true
      } catch {
        toast.error("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.")
        return
      }
      if (signInError) {
        toast.error(
          signInError.code === "EMAIL_NOT_VERIFIED"
            ? "Tu correo aún no está verificado. Revisa tu bandeja y abre el enlace."
            : "Credenciales inválidas. Revisa tu correo y contraseña.",
        )
        return
      }
      if (needsTwoFactor) {
        await navigate({ to: "/two-factor", search: next ? { next } : {} })
        return
      }
      const { data: orgs } = await authClient.organization.list()
      const target = safeNext(next)
      if (target) {
        window.location.assign(target)
        return
      }
      await navigate({ to: orgs && orgs.length > 0 ? "/" : "/onboarding" })
    },
  })

  return (
    <AuthSplit
      title="Inicia sesión"
      description="Accede a tu espacio de odentIA"
      footer={
        <>
          ¿Sin cuenta?{" "}
          <Link to="/register" className="underline">
            Regístrate
          </Link>
          {" · "}
          <Link to="/forgot-password" className="underline">
            Olvidé mi contraseña
          </Link>
        </>
      }
    >
      {oauth2fa === "1" ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Tu cuenta exige segundo factor: Google no lo completa. Ingresa con correo y contraseña y luego tu código.
        </p>
      ) : null}
      <div className="flex flex-col gap-4">
        <GoogleAuthButton label="Continuar con Google" callbackURL={safeNext(next) ?? "/"} />
        <div className="flex items-center gap-3" role="separator">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">o</span>
          <Separator className="flex-1" />
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <FieldGroup className="gap-4">
          <form.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="email">Correo</FieldLabel>
                <Input
                  id="email"
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  aria-describedby={field.state.meta.errors.length ? "email-error" : undefined}
                  type="email"
                  autoComplete="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError id="email-error">
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="password">Contraseña</FieldLabel>
                <Input
                  id="password"
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  aria-describedby={field.state.meta.errors.length ? "password-error" : undefined}
                  type="password"
                  autoComplete="current-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError id="password-error">
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting}>
                Ingresar
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}
