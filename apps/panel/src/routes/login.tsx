import { Field, FieldError, FieldGroup, FieldLabel, Input, Separator } from "@odentia/ui"
import { AuthSplit, fieldErrorMessages, PasswordInput, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
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

const credentials = z.object({
  email: z.string().email("Escribe un correo válido, como nombre@clinica.com"),
  password: z.string().min(1, "Escribe tu contraseña"),
})

const twoFactorRedirect = z.looseObject({ twoFactorRedirect: z.boolean().optional() })

type LoginProblem = "credentials" | "unverified" | "too-many" | "network" | null

/**
 * Entrar (lienzo «Acceso a odentIA», tablero 2, y «Entrar: dos fondos»,
 * prueba 2): saluda según la hora y, si este navegador recuerda a la persona,
 * la llama por su nombre, muestra su clínica y solo pide la contraseña. Los
 * errores quedan junto al campo y dicen qué hacer.
 */
function LoginPage() {
  const navigate = useNavigate()
  const { next, oauth2fa, bloqueada } = useSearch({ from: "/login" })
  const [known, setKnown] = useState<RememberedUser | null>(() => readRememberedUser())
  const [problem, setProblem] = useState<LoginProblem>(null)
  const hello = greeting()

  const form = useForm({
    defaultValues: { email: known?.email ?? "", password: "" },
    validators: { onSubmit: credentials },
    onSubmit: async ({ value }) => {
      setProblem(null)
      let code: string | undefined
      let status: number | undefined
      let needsTwoFactor = false
      let signedUser: { name: string; email: string; firstName?: string | null } | undefined
      try {
        const result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        })
        code = result.error?.code
        status = result.error?.status
        if (result.error) {
          setProblem(
            code === "EMAIL_NOT_VERIFIED"
              ? "unverified"
              : status === 429
                ? "too-many"
                : "credentials",
          )
          return
        }
        const redirect = twoFactorRedirect.safeParse(result.data)
        needsTwoFactor = redirect.success && redirect.data.twoFactorRedirect === true
        signedUser = (result.data as { user?: typeof signedUser } | null)?.user
      } catch {
        setProblem("network")
        return
      }
      if (needsTwoFactor) {
        await navigate({ to: "/two-factor", search: next ? { next } : {} })
        return
      }
      const { data: orgs } = await authClient.organization.list()
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
      await navigate({ to: orgs && orgs.length > 0 ? "/" : "/onboarding" })
    },
  })

  const notMe = () => {
    forgetUser()
    setKnown(null)
    setProblem(null)
    form.reset({ email: "", password: "" })
  }

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
      {bloqueada === 1 ? (
        <AuthAlert>Tu cuenta está bloqueada. Escribe a soporte para revisarla.</AuthAlert>
      ) : null}
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
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
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
            <form.Field name="email">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="email">Correo</FieldLabel>
                  <Input
                    id="email"
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    aria-describedby={field.state.meta.errors.length ? "email-error" : undefined}
                    type="email"
                    inputMode="email"
                    autoComplete="username"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError id="email-error">
                    {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                  </FieldError>
                </Field>
              )}
            </form.Field>
          )}
          <form.Field name="password">
            {(field) => {
              const fieldError = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  {/* Rejilla: el enlace se ve junto a la etiqueta pero en el teclado va después del campo. */}
                  <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-2">
                    <FieldLabel htmlFor="password" className="col-start-1 row-start-1">
                      Contraseña
                    </FieldLabel>
                    <div className="col-span-2 row-start-2">
                      <PasswordInput
                        id="password"
                        value={field.state.value}
                        onChange={(v) => {
                          field.handleChange(v)
                          if (problem === "credentials") setProblem(null)
                        }}
                        autoComplete="current-password"
                        autoFocus={!!known}
                        invalid={!!fieldError || problem === "credentials"}
                        describedBy={fieldError || problem ? "password-error" : undefined}
                      />
                    </div>
                    <FieldError id="password-error" className="col-span-2 row-start-3">
                      {fieldError ?? null}
                    </FieldError>
                    <Link
                      to="/forgot-password"
                      search={() => ({ email: form.getFieldValue("email") || undefined })}
                      className="col-start-2 row-start-1 text-sm font-medium text-primary underline"
                    >
                      ¿Olvidaste tu contraseña?
                    </Link>
                  </div>
                </Field>
              )
            }}
          </form.Field>
          <LoginProblemNotice problem={problem} email={form.getFieldValue("email")} />
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

/** Qué pasó al entrar y cómo seguir; el correo sin verificar trae el reenvío ahí mismo. */
function LoginProblemNotice({ problem, email }: { problem: LoginProblem; email: string }) {
  const [wait, setWait] = useState(0)
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (wait <= 0) return
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(t)
  }, [wait])

  if (!problem) return null
  if (problem === "credentials")
    return (
      <AuthAlert id="password-error">
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
      <AuthAlert>
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
  if (problem === "network")
    return (
      <AuthAlert>
        No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.
      </AuthAlert>
    )
  return (
    <AuthAlert>
      <span className="flex flex-col gap-2">
        <span>
          Tu correo aún no está verificado. Abre el enlace que te enviamos{sent ? " de nuevo" : ""}.
        </span>
        <button
          type="button"
          className="self-start font-semibold underline disabled:no-underline disabled:opacity-60"
          disabled={wait > 0}
          onClick={async () => {
            await authClient.sendVerificationEmail({
              email,
              callbackURL: `${window.location.origin}/`,
            })
            setSent(true)
            setWait(60)
          }}
        >
          {wait > 0 ? `Reenviar en ${countdown(wait)}` : "Reenviar el enlace"}
        </button>
      </span>
    </AuthAlert>
  )
}
