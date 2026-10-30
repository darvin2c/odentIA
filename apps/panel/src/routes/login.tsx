import { Field, FieldError, FieldGroup, FieldLabel, Input, Separator } from "@odentia/ui"
import {
  AuthSplit,
  PasswordInput,
  SubmitButton,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { AUTH_NETWORK, authError, authErrorMessage, authFailureOf, authFormMessage } from "../lib/auth-error"
import { AuthAlert, AuthLegal, WelcomeAside } from "../lib/auth-screens"
import { countdown } from "../lib/countdown"
import { GoogleAuthButton } from "../lib/google-auth"
import { safeNext } from "../lib/safe-next"
import {
  forgetUser,
  greeting,
  initials,
  type RememberedUser,
  readRememberedUser,
  rememberUser,
} from "../lib/welcome"
import { panelWords } from "../lib/brand"

export const Route = createFileRoute("/login")({
  // El saludo depende de la hora del equipo y de lo que recuerda este navegador.
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(String(search.oauth2fa) === "1" ? { oauth2fa: 1 as const } : {}),
    ...(String(search.bloqueada) === "1" ? { bloqueada: 1 as const } : {}),
  }),
  component: LoginPage,
})

const email = z.string().email("Escribe un correo válido, como nombre@clinica.com")
const password = z.string().min(1, "Escribe tu contraseña")
const credentials = z.object({ email, password })
// Con la persona recordada el correo no se muestra: no se valida lo que no se puede corregir.
const knownCredentials = z.object({ email: z.string(), password })

const twoFactorRedirect = z.looseObject({ twoFactorRedirect: z.boolean().optional() })

/** Lo que se dice con su propio aviso (enlaces, reenviar); lo demás va junto al botón. */
type LoginProblem = "credentials" | "unverified" | "too-many" | "blocked" | null

/** Id del aviso de cada problema, para el `aria-describedby` de los campos. */
const PROBLEM_ID = "login-problem"

/**
 * Entrar (lienzo «Acceso a odentIA», tablero 2, y «Entrar: dos fondos»,
 * prueba 2): saluda según la hora y, si este navegador recuerda a la persona,
 * la llama por su nombre, muestra su clínica y solo pide la contraseña. Los
 * errores quedan junto al campo y dicen qué hacer. Credenciales: un solo
 * mensaje neutro (no revela si la cuenta existe); la cuenta bloqueada se dice
 * porque el servidor solo lo responde tras validar la contraseña.
 */
function LoginPage() {
  const navigate = useNavigate()
  const { next, oauth2fa, bloqueada } = useSearch({ from: "/login" })
  const [known, setKnown] = useState<RememberedUser | null>(() => readRememberedUser())
  const [problem, setProblem] = useState<LoginProblem>(null)
  const hello = greeting()

  const form = useAppForm({
    defaultValues: { email: known?.email ?? "", password: "" },
    validators: { onSubmit: known ? knownCredentials : credentials },
    onSubmit: async ({ value }) => {
      setProblem(null)
      const result = await authClient.signIn.email({ email: value.email, password: value.password })
      if (result.error) {
        const { code, status } = authFailureOf(result.error)
        const kind: LoginProblem =
          code === "EMAIL_NOT_VERIFIED"
            ? "unverified"
            : code === "ACCOUNT_BLOCKED"
              ? "blocked"
              : status === 429 || code === "ACCOUNT_TEMPORARILY_LOCKED"
                ? "too-many"
                : status >= 500
                  ? null
                  : "credentials"
        if (kind) {
          setProblem(kind)
          return
        }
        throw authError(result.error)
      }
      const redirect = twoFactorRedirect.safeParse(result.data)
      if (redirect.success && redirect.data.twoFactorRedirect === true) {
        await navigate({ to: "/two-factor", search: next ? { next } : {} })
        return
      }
      const signedUser = (result.data as { user?: { name: string; email: string; firstName?: string | null } } | null)
        ?.user
      // Ya entró: si no se pueden leer sus clínicas, la portada decide.
      const orgs = await authClient.organization
        .list()
        .then(({ data }) => data)
        .catch(() => null)
      if (signedUser) {
        rememberUser({
          email: signedUser.email,
          name: signedUser.name,
          firstName: signedUser.firstName || signedUser.name.split(" ")[0] || "",
          clinic: orgs?.length === 1 ? orgs[0]?.name : undefined,
        })
      }
      const target = safeNext(next)
      if (target) {
        window.location.assign(target)
        return
      }
      await navigate({ to: orgs && orgs.length === 0 ? "/onboarding" : "/" })
    },
  })
  const onSubmit = useFormSubmit(form, { formMessage: authFormMessage })
  const submitError = useFormSubmitError(form)
  const typedEmail = useStore(form.store, (state) => state.values.email)

  const notMe = () => {
    forgetUser()
    setKnown(null)
    setProblem(null)
    form.reset({ email: "", password: "" })
  }

  // El aviso de credenciales habla del correo y de la contraseña: los dos quedan marcados.
  const credentialsWrong = problem === "credentials"

  return (
    <AuthSplit
      title={
        known ? (
          <span className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-base font-extrabold text-primary"
            >
              {initials(known.name)}
            </span>
            <span>
              {hello}, {known.firstName}.
            </span>
          </span>
        ) : (
          `${hello}.`
        )
      }
      description={
        known ? (known.clinic ?? "Qué bueno verte.") : `Qué bueno verte. Entra a tu ${panelWords.place.one}.`
      }
      aside={<WelcomeAside />}
      legal={<AuthLegal />}
      footer={
        known ? (
          <>
            {known.email} ·{" "}
            <button type="button" className="underline" onClick={notMe}>
              ¿No eres tú?
            </button>
          </>
        ) : (
          <>
            ¿Aún no tienes cuenta?{" "}
            <Link to="/register" className="font-medium text-foreground underline">
              Crear una cuenta
            </Link>
          </>
        )
      }
    >
      {bloqueada === 1 && problem !== "blocked" ? <AuthAlert>{BLOCKED_TEXT}</AuthAlert> : null}
      {oauth2fa === 1 ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Tu cuenta exige segundo factor: Google no lo completa. Entra con correo y contraseña y
          luego tu código.
        </p>
      ) : null}
      {known ? null : (
        <div className="flex flex-col gap-4">
          <GoogleAuthButton label="Continuar con Google" callbackURL={safeNext(next) ?? "/"} />
          <div className="flex items-center gap-3">
            <Separator className="flex-1" aria-hidden />
            <span className="text-xs text-muted-foreground">o con tu correo</span>
            <Separator className="flex-1" aria-hidden />
          </div>
        </div>
      )}
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          {known ? (
            // El gestor de contraseñas necesita el usuario aunque no se muestre.
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={known.email}
              readOnly
              hidden
            />
          ) : (
            <form.AppField name="email">
              {(field) => (
                <field.Control label="Correo" id="email">
                  {(control) => (
                    <Input
                      {...control.props}
                      aria-invalid={control.invalid || credentialsWrong || undefined}
                      aria-describedby={describedBy(control.describedBy, credentialsWrong)}
                      type="email"
                      inputMode="email"
                      autoComplete="username"
                      value={field.state.value}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        if (credentialsWrong) setProblem(null)
                      }}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          )}
          <form.AppField name="password">
            {() => (
              <LoginPassword
                autoFocus={!!known}
                credentialsWrong={credentialsWrong}
                onType={() => {
                  if (credentialsWrong) setProblem(null)
                }}
                forgotEmail={typedEmail}
              />
            )}
          </form.AppField>
          <LoginProblemNotice problem={problem} email={typedEmail} />
          {submitError ? <AuthAlert>{submitError}</AuthAlert> : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                Entrar
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

const BLOCKED_TEXT = "Tu cuenta está bloqueada. Escribe a soporte para revisarla."

/** Suma el aviso de credenciales a lo que ya describe el campo. */
function describedBy(own: string | undefined, credentialsWrong: boolean): string | undefined {
  return [own, credentialsWrong ? PROBLEM_ID : null].filter(Boolean).join(" ") || undefined
}

/**
 * La contraseña con «¿Olvidaste tu contraseña?» junto a la etiqueta (en el
 * teclado va después del campo): por eso pinta su propio `Field` con el
 * estado de `form.AppField`.
 */
function LoginPassword({
  autoFocus,
  credentialsWrong,
  onType,
  forgotEmail,
}: {
  autoFocus: boolean
  credentialsWrong: boolean
  onType: () => void
  forgotEmail: string
}) {
  const field = useFieldContext<string>()
  const { control, errors, errorId } = useFieldControl({ id: "password", hasDescription: false })
  return (
    <Field data-invalid={control.invalid || credentialsWrong || undefined}>
      {/* Rejilla: el enlace se ve junto a la etiqueta pero en el teclado va después del campo. */}
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-2">
        <FieldLabel htmlFor={control.id} className="col-start-1 row-start-1">
          Contraseña
        </FieldLabel>
        <div className="col-span-2 row-start-2">
          <PasswordInput
            id={control.id}
            value={field.state.value}
            onChange={(next) => {
              field.handleChange(next)
              onType()
            }}
            onBlur={control.onBlur}
            autoComplete="current-password"
            autoFocus={autoFocus}
            invalid={control.invalid || credentialsWrong}
            describedBy={describedBy(control.describedBy, credentialsWrong)}
          />
        </div>
        {control.invalid ? (
          <FieldError
            id={errorId}
            className="col-span-2 row-start-3"
            errors={errors.map((message) => ({ message }))}
          />
        ) : null}
        <Link
          to="/forgot-password"
          search={() => ({ email: forgotEmail || undefined })}
          className="col-start-2 row-start-1 text-sm font-medium text-primary underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>
    </Field>
  )
}

/** Qué pasó al entrar y cómo seguir; el correo sin verificar trae el reenvío ahí mismo. */
function LoginProblemNotice({ problem, email }: { problem: LoginProblem; email: string }) {
  const [wait, setWait] = useState(0)
  const [sent, setSent] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)
  useEffect(() => {
    if (wait <= 0) return
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(t)
  }, [wait])

  if (!problem) return null
  if (problem === "credentials")
    return (
      <AuthAlert id={PROBLEM_ID}>
        El correo o la contraseña no coinciden. Revísalos o{" "}
        <Link
          to="/forgot-password"
          search={{ email: email || undefined }}
          className="font-semibold underline"
        >
          recupera tu contraseña
        </Link>
        .
      </AuthAlert>
    )
  if (problem === "too-many")
    return (
      <AuthAlert id={PROBLEM_ID}>
        Hiciste varios intentos seguidos. Espera unos minutos o{" "}
        <Link
          to="/forgot-password"
          search={{ email: email || undefined }}
          className="font-semibold underline"
        >
          recupera tu contraseña
        </Link>
        .
      </AuthAlert>
    )
  if (problem === "blocked") return <AuthAlert id={PROBLEM_ID}>{BLOCKED_TEXT}</AuthAlert>
  return (
    <AuthAlert id={PROBLEM_ID}>
      <span className="flex flex-col gap-2">
        <span>
          Tu correo aún no está verificado. Abre el enlace que te enviamos{sent ? " de nuevo" : ""}.
        </span>
        <button
          type="button"
          className="self-start font-semibold underline disabled:no-underline disabled:opacity-60"
          disabled={wait > 0}
          onClick={async () => {
            setResendError(null)
            try {
              const { error } = await authClient.sendVerificationEmail({
                email,
                callbackURL: `${window.location.origin}/`,
              })
              if (error) {
                setResendError(authErrorMessage(error))
                return
              }
            } catch {
              setResendError(AUTH_NETWORK)
              return
            }
            setSent(true)
            setWait(60)
          }}
        >
          {wait > 0 ? `Reenviar en ${countdown(wait)}` : "Reenviar el enlace"}
        </button>
        {resendError ? <span>{resendError}</span> : null}
      </span>
    </AuthAlert>
  )
}
