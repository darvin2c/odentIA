import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Field, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui";
import { AuthCard, SubmitButton, fieldErrorMessages } from "@odentia/ui-patterns";
import { z } from "zod";
import { authClient } from "../lib/auth-client";
import { BASE_DOMAIN } from "../lib/host";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
  }),
  component: LoginPage,
});

/** Solo redirige a URLs https del dominio base (panel o tenants). */
function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  try {
    const url = new URL(next);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== BASE_DOMAIN && !url.hostname.endsWith(`.${BASE_DOMAIN}`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const credentials = z.object({
  email: z.string().email("Correo inválido"),
  password: z.string().min(1, "Ingresa tu contraseña"),
});

function LoginPage() {
  const navigate = useNavigate();
  const { next } = useSearch({ from: "/login" });
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: credentials },
    onSubmit: async ({ value }) => {
      let signInError: { code?: string } | null;
      try {
        ({ error: signInError } = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        }));
      } catch {
        toast.error("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
        return;
      }
      if (signInError) {
        toast.error(
          signInError.code === "EMAIL_NOT_VERIFIED"
            ? "Tu correo aún no está verificado. Revisa tu bandeja y abre el enlace."
            : "Credenciales inválidas. Revisa tu correo y contraseña.",
        );
        return;
      }
      const { data: orgs } = await authClient.organization.list();
      const target = safeNext(next);
      if (target) {
        window.location.assign(target);
        return;
      }
      await navigate({ to: orgs && orgs.length > 0 ? "/" : "/onboarding" });
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
