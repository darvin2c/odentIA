import { Field, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui"
import { AuthCard, ErrorState, fieldErrorMessages, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { z } from "zod"
import { authClient } from "../lib/auth-client"

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const navigate = useNavigate()
  const { token } = useSearch({ from: "/reset-password" })
  const form = useForm({
    defaultValues: { password: "" },
    validators: { onSubmit: z.object({ password: z.string().min(8, "Mínimo 8 caracteres") }) },
    onSubmit: async ({ value }) => {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: value.password,
        token,
      })
      if (resetError) {
        toast.error("El enlace es inválido o expiró. Solicita uno nuevo.")
        return
      }
      await navigate({ to: "/login" })
    },
  })

  return (
    <AuthCard title="Restablece tu contraseña">
      {!token ? (
        <ErrorState message="Falta el token de recuperación." />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup className="gap-4">
            <form.Field name="password">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="password">Nueva contraseña</FieldLabel>
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
                  Guardar contraseña
                </SubmitButton>
              )}
            </form.Subscribe>
          </FieldGroup>
        </form>
      )}
      <Link to="/login" className="text-center text-sm underline">
        Volver a iniciar sesión
      </Link>
    </AuthCard>
  )
}
