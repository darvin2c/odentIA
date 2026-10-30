import { Button, FieldGroup, Input } from "@odentia/ui"
import {
  AuthSplit,
  SubmitButton,
  submitForm,
  totpDigits,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { authError, authFailureOf, authFormMessage } from "../lib/auth-error"
import { AuthAlert, AuthLegal, RecoverAside, WelcomeAside } from "../lib/auth-screens"
import { safeNext } from "../lib/safe-next"

export const Route = createFileRoute("/two-factor")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(String(search.enlace) === "1" ? { enlace: 1 as const } : {}),
  }),
  component: TwoFactorPage,
})

const WRONG_TOTP =
  "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático."
const WRONG_BACKUP = "Ese código no existe o ya se usó."

/** El código según el modo: 6 dígitos de la app o uno de respaldo. */
function codeSchema(recovery: boolean) {
  return z.object({
    code: recovery
      ? z.string().trim().min(4, "Escribe uno de tus códigos de respaldo.")
      : z.string().regex(/^\d{6}$/, "Escribe los 6 dígitos."),
    trust: z.boolean(),
  })
}

/**
 * Segundo paso del login cuando la cuenta tiene la verificación en dos pasos
 * (ADR 0107; incluye el retorno del admin: `?next=` al dominio admin). El
 * código de la app, o uno de respaldo, y recordar el navegador 30 días. Sin
 * sesión pendiente, Better Auth responde error y se vuelve a entrar. Solo un
 * código equivocado se dice en el campo; el paso vencido, el bloqueo temporal
 * o la cuenta bloqueada, junto al botón (escribir otro código no los arregla).
 */
function TwoFactorPage() {
  const navigate = useNavigate()
  const { next, enlace } = useSearch({ from: "/two-factor" })
  const [recovery, setRecovery] = useState(false)
  // El paso pendiente venció: hay que volver a entrar con la contraseña.
  const [expired, setExpired] = useState(false)

  const form = useAppForm({
    defaultValues: { code: "", trust: false as boolean },
    validators: { onSubmit: codeSchema(recovery) },
    onSubmit: async ({ value }) => {
      setExpired(false)
      const target = safeNext(next)
      const result = recovery
        ? await authClient.twoFactor.verifyBackupCode({ code: value.code.trim(), trustDevice: value.trust })
        : await authClient.twoFactor.verifyTotp({ code: value.code, trustDevice: value.trust })
      if (result.error) {
        if (authFailureOf(result.error).code === "INVALID_TWO_FACTOR_COOKIE") setExpired(true)
        throw authError(result.error, {
          fields: { INVALID_CODE: "code", INVALID_BACKUP_CODE: "code" },
          messages: { INVALID_CODE: recovery ? WRONG_BACKUP : WRONG_TOTP, INVALID_BACKUP_CODE: WRONG_BACKUP },
        })
      }
      if (target) {
        window.location.assign(target)
        return
      }
      // Ya entró: si no se pueden leer sus clínicas, la portada decide.
      const orgs = await authClient.organization
        .list()
        .then(({ data }) => data)
        .catch(() => null)
      await navigate({ to: orgs && orgs.length === 0 ? "/onboarding" : "/" })
    },
  })
  const onSubmit = useFormSubmit(form, { formMessage: authFormMessage })
  const submitError = useFormSubmitError(form)

  return (
    <AuthSplit
      title={recovery ? "Escribe un código de respaldo" : enlace ? "Un paso más" : "Escribe el código de tu app"}
      description={
        recovery
          ? "Uno de los 10 que guardaste al activar la verificación. Cada código sirve una sola vez."
          : enlace
            ? "El enlace confirmó tu correo. Tu cuenta pide además el código de tu app de autenticación."
            : "Tu contraseña es correcta. Abre tu app de autenticación y escribe el código."
      }
      aside={enlace ? <RecoverAside /> : <WelcomeAside />}
      legal={<AuthLegal />}
      footer={
        <Link to="/login" className="underline">
          Volver a entrar
        </Link>
      }
    >
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <form.AppField name="code">
            {(field) => (
              <field.Control
                label={recovery ? "Código de respaldo" : "Código de 6 dígitos"}
                id="code"
                description={recovery ? "Con guion o sin él." : "Al escribir el sexto número entras solo."}
              >
                {(control) => (
                  <Input
                    {...control.props}
                    key={recovery ? "recovery" : "totp"}
                    inputMode={recovery ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    maxLength={recovery ? 32 : 6}
                    autoFocus
                    value={field.state.value}
                    onChange={(event) => {
                      const value = recovery ? event.target.value : totpDigits(event.target.value)
                      field.handleChange(value)
                      if (!recovery && value.length === 6 && !form.state.isSubmitting)
                        void submitForm(form, { formMessage: authFormMessage })
                    }}
                    className={recovery ? "font-mono" : "h-12 font-mono text-2xl tracking-[0.4em]"}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="trust">
            {(field) => (
              <field.CheckboxField
                id="trust"
                label="Recordar este dispositivo 30 días"
                description="Solo si es tu teléfono o tu computadora. En un equipo compartido de recepción, déjalo sin marcar."
              />
            )}
          </form.AppField>
          {submitError ? (
            <AuthAlert>
              {submitError}
              {expired ? (
                <>
                  {" "}
                  <Link to="/login" search={next ? { next } : {}} className="font-semibold underline">
                    Volver a entrar
                  </Link>
                </>
              ) : null}
            </AuthAlert>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                Entrar
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
      <div className="flex flex-col gap-2 text-sm">
        <Button
          type="button"
          variant="link"
          className="h-auto self-start p-0"
          onClick={() => {
            setRecovery((value) => !value)
            setExpired(false)
            form.reset({ code: "", trust: form.state.values.trust })
          }}
        >
          {recovery ? "Usar el código de la app" : "Usar un código de respaldo"}
        </Button>
        <p className="text-muted-foreground">¿Perdiste el teléfono y los códigos? Pide al propietario de tu clínica que restablezca tu verificación.</p>
      </div>
    </AuthSplit>
  )
}
