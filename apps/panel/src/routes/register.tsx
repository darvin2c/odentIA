import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Field, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui";
import { AuthCard, SubmitButton, fieldErrorMessages } from "@odentia/ui-patterns";
import { z } from "zod";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.email === "string" ? { email: search.email } : {}),
    ...(typeof search.invitationId === "string" ? { invitationId: search.invitationId } : {}),
  }),
  component: RegisterPage,
});

const registration = z.object({
  name: z.string().min(1, "Ingresa tu nombre"),
  email: z.string().email("Correo inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres"),
});

function RegisterPage() {
  const navigate = useNavigate();
  const { email: initialEmail, invitationId } = useSearch({ from: "/register" });
  const form = useForm({
    defaultValues: { name: "", email: initialEmail ?? "", password: "" },
    validators: { onSubmit: registration },
    onSubmit: async ({ value }) => {
      const { error: signUpError } = await authClient.signUp.email({
        name: value.name,
        email: value.email,
        password: value.password,
      });
      if (signUpError) {
        toast.error(signUpError.message ?? "No se pudo registrar la cuenta.");
        return;
      }
      await navigate(
        invitationId
          ? { to: "/accept-invitation/$invitationId", params: { invitationId } }
          : { to: "/verify-email-sent" },
      );
    },
  });

  return (
    <AuthCard
      title="Crea tu cuenta"
      description="Regístrate en odentIA"
      footer={<>¿Ya tienes cuenta? <Link to="/login" className="underline">Inicia sesión</Link></>}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup className="gap-4">
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="name">Nombre</FieldLabel>
                <Input
                  id="name"
                  autoComplete="name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
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
                <FieldError>
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
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
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
    </AuthCard>
  );
}
