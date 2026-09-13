import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Field, FieldError, FieldGroup, FieldLabel, Input } from "@odentia/ui";
import { SubmitButton, fieldErrorMessages } from "@odentia/ui-patterns";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "../lib/auth-client";
import { AuthCard } from "@odentia/ui-patterns";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const form = useForm({
    defaultValues: { email: "" },
    validators: { onSubmit: z.object({ email: z.string().email("Correo inválido") }) },
    onSubmit: async ({ value }) => {
      await authClient.requestPasswordReset({
        email: value.email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      setSent(true);
    },
  });

  return (
    <AuthCard
      title="Recupera tu contraseña"
      description="Te enviaremos un enlace para restablecerla"
      footer={<Link to="/login" className="underline">Volver a iniciar sesión</Link>}
    >
      {sent ? (
        <p className="text-sm">Si el correo existe, ya enviamos el enlace de recuperación.</p>
      ) : (
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
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting}>
                Enviar enlace
              </SubmitButton>
            )}
          </form.Subscribe>
          </FieldGroup>
        </form>
      )}
    </AuthCard>
  );
}
