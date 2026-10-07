import { Field, FieldError, FieldGroup, FieldLabel, Input, Separator, toast } from "@odentia/ui"
import { AuthSplit, fieldErrorMessages, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { GoogleAuthButton } from "../lib/google-auth"

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.email === "string" ? { email: search.email } : {}),
    ...(typeof search.invitationId === "string" ? { invitationId: search.invitationId } : {}),
  }),
  component: RegisterPage,
})
const registration = z.object({
  firstName: z.string().min(1, "Ingresa tu nombre"),
  lastName: z.string().min(1, "Ingresa tus apellidos"),
  email: z.string().email("Correo inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres"),
})

function RegisterPage() {
  const navigate = useNavigate()
  const { email: initialEmail, invitationId } = useSearch({ from: "/register" })
  const form = useForm({
    defaultValues: { firstName: "", lastName: "", email: initialEmail ?? "", password: "" },
    validators: { onSubmit: registration },
    onSubmit: async ({ value }) => {
      const { error: signUpError } = await authClient.signUp.email({
        name: `${value.firstName} ${value.lastName}`.trim(),
        firstName: value.firstName,
        lastName: value.lastName,
        email: value.email,
        password: value.password,
        callbackURL: invitationId
          ? `${window.location.origin}/accept-invitation/${encodeURIComponent(invitationId)}`
          : `${window.location.origin}/`,
      })
      if (signUpError) {
        toast.error(signUpError.message ?? "No se pudo registrar la cuenta.")
        return
      }
      await navigate(
        invitationId
          ? { to: "/accept-invitation/$invitationId", params: { invitationId } }
          : { to: "/verify-email-sent" },
      )
    },
  })

  return (
    <AuthSplit
      title="Crea tu cuenta"
      description="Regístrate en odentIA"
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="underline">
            Inicia sesión
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <GoogleAuthButton
          label="Regístrate con Google"
          callbackURL={invitationId ? `/accept-invitation/${invitationId}` : "/"}
        />
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
          <form.Field name="firstName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="firstName">Nombre</FieldLabel>
                <Input
                  id="firstName"
                  autoComplete="given-name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="lastName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="lastName">Apellidos</FieldLabel>
                <Input
                  id="lastName"
                  autoComplete="family-name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="email">Correo</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="password">Contraseña</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting}>
                Registrarme
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}
