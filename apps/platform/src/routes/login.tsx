import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Field, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui";
import { AuthCard, SubmitButton, fieldErrorMessages } from "@odentia/ui-patterns";
import { z } from "zod";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const credentials = z.object({
  email: z.string().email("Correo inválido"),
  password: z.string().min(1, "Ingresa tu contraseña"),
});

function LoginPage() {
  const navigate = useNavigate();
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: credentials },
    onSubmit: async ({ value }) => {
      const { error: signInError } = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      if (signInError) {
        toast.error(
          signInError.code === "EMAIL_NOT_VERIFIED"
            ? "Tu correo aún no está verificado. Revisa tu bandeja y abre el enlace."
            : "Credenciales inválidas. Revisa tu correo y contraseña.",
        );
        return;
      }
      const { data: orgs } = await authClient.organization.list();
      await navigate({ to: orgs && orgs.length > 0 ? "/app/branches" : "/onboarding" });
    },
  });

  return (
    <AuthCard
      title="Inicia sesión"
      description="Accede a tu espacio de odentIA"
      footer={
        <>
          ¿Sin cuenta? <Link to="/register" className="underline">Regístrate</Link>
          {" · "}
          <Link to="/forgot-password" className="underline">Olvidé mi contraseña</Link>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup className="gap-4">
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
                  autoComplete="current-password"
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
                Ingresar
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
