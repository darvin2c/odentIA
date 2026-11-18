import { Button, Checkbox, Field, FieldError, FieldGroup, FieldLabel, Input } from "@odentia/ui"
import { PasswordInput, SubmitButton } from "@odentia/ui-patterns"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { MailCheck } from "lucide-react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import {
  accountErrorText,
  authClient,
  authFetch,
  forgetToken,
  safeNext,
  TERMS_VERSION,
} from "./lib/cuenta"
import { AuthAlert, AuthLayout } from "./marca"

/**
 * La entrada de gestorIA con la cuenta única (lienzo B, tablero 9): entrar, crear la cuenta,
 * verificar el correo, recuperar el acceso y el segundo paso. Por detrás es la misma cuenta de
 * odentIA, latidIA y vistIA: quien ya la tiene entra con su contraseña; quien llega nuevo se
 * registra aquí y no ve otra marca. Las direcciones (`/login`, `/forgot-password`,
 * `/two-factor`) son las que usa la cuenta al volver de un enlace.
 */

const emailSchema = z.string().trim().email("Escribe un correo válido, como nombre@tienda.com")

type Fields = Record<string, string>

function useFormState() {
  const [errors, setErrors] = useState<Fields>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return { errors, setErrors, problem, setProblem, pending, setPending }
}

export function LoginPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { next?: string; bloqueada?: string }
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [unverified, setUnverified] = useState(false)
  const [resent, setResent] = useState(false)
  const form = useFormState()
  const next = safeNext(search.next)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const errors: Fields = {}
    if (!emailSchema.safeParse(email).success)
      errors.email = "Escribe un correo válido, como nombre@tienda.com"
    if (!password) errors.password = "Escribe tu contraseña"
    form.setErrors(errors)
    form.setProblem(null)
    setUnverified(false)
    if (Object.keys(errors).length > 0) return
    form.setPending(true)
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password })
      if (result.error) {
        const code = (result.error as { code?: string }).code
        if (code === "EMAIL_NOT_VERIFIED") setUnverified(true)
        else
          form.setProblem(
            accountErrorText({ code, message: result.error.message, status: result.error.status }),
          )
        return
      }
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        await navigate({ to: "/two-factor", search: next ? { next } : {} })
        return
      }
      forgetToken()
      if (next) window.location.assign(next)
      else await navigate({ to: "/" })
    } catch {
      form.setProblem("No hay conexión con tu cuenta. Revisa tu internet e inténtalo de nuevo.")
    } finally {
      form.setPending(false)
    }
  }

  return (
    <AuthLayout
      title="Entra a tu tienda"
      description="Con tu cuenta del Grupo Sallca: si ya usas odentIA, latidIA o vistIA, es la misma."
      footer={
        <>
          ¿Aún no tienes cuenta?{" "}
          <Link
            to="/register"
            search={next ? { next } : {}}
            className="font-medium text-primary underline"
          >
            Crear una cuenta
          </Link>
        </>
      }
    >
      {search.bloqueada === "1" ? (
        <AuthAlert>Tu cuenta está bloqueada. Escribe a soporte para revisarla.</AuthAlert>
      ) : null}
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <Field data-invalid={form.errors.email ? true : undefined}>
            <FieldLabel htmlFor="email">Correo</FieldLabel>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={form.errors.email ? true : undefined}
              aria-describedby={form.errors.email ? "email-error" : undefined}
            />
            {form.errors.email ? (
              <FieldError id="email-error">{form.errors.email}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={form.errors.password ? true : undefined}>
            <div className="flex items-baseline justify-between gap-3">
              <FieldLabel htmlFor="password">Contraseña</FieldLabel>
              <Link
                to="/forgot-password"
                search={email ? { email } : {}}
                className="text-sm font-medium text-primary underline"
              >
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
            <PasswordInput
              id="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              invalid={Boolean(form.errors.password)}
              describedBy={form.errors.password ? "password-error" : undefined}
            />
            {form.errors.password ? (
              <FieldError id="password-error">{form.errors.password}</FieldError>
            ) : null}
          </Field>
          {unverified ? (
            <AuthAlert>
              <span className="flex flex-col gap-2">
                <span>
                  Tu correo aún no está verificado. Abre el enlace que te enviamos
                  {resent ? " de nuevo" : ""}.
                </span>
                <button
                  type="button"
                  className="self-start font-semibold underline"
                  onClick={async () => {
                    const { error } = await authClient.sendVerificationEmail({
                      email: email.trim(),
                      callbackURL: `${window.location.origin}/`,
                    })
                    if (error) form.setProblem(accountErrorText(error))
                    else setResent(true)
                  }}
                >
                  Reenviar el enlace
                </button>
              </span>
            </AuthAlert>
          ) : null}
          {form.problem ? <AuthAlert>{form.problem}</AuthAlert> : null}
          <SubmitButton type="submit" pending={form.pending} className="h-11 w-full text-base">
            Entrar
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}

export function RegisterPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { next?: string }
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [accepted, setAccepted] = useState(false)
  const form = useFormState()
  const next = safeNext(search.next)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const errors: Fields = {}
    if (!name.trim()) errors.name = "Escribe tu nombre"
    if (!emailSchema.safeParse(email).success)
      errors.email = "Escribe un correo válido, como nombre@tienda.com"
    if (password.length < 8) errors.password = "Usa al menos 8 caracteres"
    if (!accepted) errors.terms = "Acepta los términos para crear tu cuenta"
    form.setErrors(errors)
    form.setProblem(null)
    if (Object.keys(errors).length > 0) return
    form.setPending(true)
    const [firstName = "", ...rest] = name.trim().split(/\s+/)
    try {
      const result = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
        firstName,
        lastName: rest.join(" "),
        termsVersion: TERMS_VERSION,
        callbackURL: `${window.location.origin}${next ?? "/"}`,
      })
      if (result.error) {
        const code = (result.error as { code?: string }).code
        if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_COMPROMISED")
          form.setErrors({ password: accountErrorText({ code }) })
        else
          form.setProblem(
            accountErrorText({ code, message: result.error.message, status: result.error.status }),
          )
        return
      }
      await navigate({ to: "/verify-email-sent", search: { email: email.trim() } })
    } catch {
      form.setProblem("No hay conexión con tu cuenta. Revisa tu internet e inténtalo de nuevo.")
    } finally {
      form.setPending(false)
    }
  }

  return (
    <AuthLayout
      title="Crea tu cuenta"
      description="Una sola cuenta para todas las apps del Grupo Sallca. Después creas tu tienda."
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link
            to="/login"
            search={next ? { next } : {}}
            className="font-medium text-primary underline"
          >
            Entrar
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <Field data-invalid={form.errors.name ? true : undefined}>
            <FieldLabel htmlFor="name">Tu nombre</FieldLabel>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={form.errors.name ? true : undefined}
              aria-describedby={form.errors.name ? "name-error" : undefined}
            />
            {form.errors.name ? <FieldError id="name-error">{form.errors.name}</FieldError> : null}
          </Field>
          <Field data-invalid={form.errors.email ? true : undefined}>
            <FieldLabel htmlFor="email">Correo</FieldLabel>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={form.errors.email ? true : undefined}
              aria-describedby={form.errors.email ? "email-error" : undefined}
            />
            {form.errors.email ? (
              <FieldError id="email-error">{form.errors.email}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={form.errors.password ? true : undefined}>
            <FieldLabel htmlFor="password">Contraseña</FieldLabel>
            <PasswordInput
              id="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              invalid={Boolean(form.errors.password)}
              describedBy={form.errors.password ? "password-error" : undefined}
              requirements={[
                { label: "Al menos 8 caracteres", met: password ? password.length >= 8 : null },
              ]}
            />
            {form.errors.password ? (
              <FieldError id="password-error">{form.errors.password}</FieldError>
            ) : null}
          </Field>
          <Field orientation="horizontal" data-invalid={form.errors.terms ? true : undefined}>
            <Checkbox
              id="terms"
              checked={accepted}
              onCheckedChange={(value) => {
                setAccepted(value === true)
                if (value === true) form.setErrors(({ terms: _, ...rest }) => rest)
              }}
              aria-invalid={form.errors.terms ? true : undefined}
              aria-describedby={form.errors.terms ? "terms-error" : undefined}
            />
            <FieldLabel htmlFor="terms" className="font-normal">
              <span>
                Acepto los{" "}
                <a
                  className="text-primary underline"
                  href="https://odentia32.com/terminos"
                  target="_blank"
                  rel="noreferrer"
                >
                  Términos
                </a>{" "}
                y el{" "}
                <a
                  className="text-primary underline"
                  href="https://odentia32.com/privacidad"
                  target="_blank"
                  rel="noreferrer"
                >
                  Aviso de privacidad
                </a>{" "}
                del Grupo Sallca.
              </span>
            </FieldLabel>
          </Field>
          {form.errors.terms ? <FieldError id="terms-error">{form.errors.terms}</FieldError> : null}
          {form.problem ? <AuthAlert>{form.problem}</AuthAlert> : null}
          <SubmitButton type="submit" pending={form.pending} className="h-11 w-full text-base">
            Crear mi cuenta
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}

export function VerifyEmailSentPage() {
  const search = useSearch({ strict: false }) as { email?: string }
  const [resent, setResent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <AuthLayout
      title={
        <span className="flex flex-col gap-3">
          <MailCheck className="size-10 rounded-xl bg-primary-soft p-2 text-primary" aria-hidden />
          Revisa tu correo
        </span>
      }
      description={
        <>
          Te enviamos un enlace
          {search.email ? (
            <>
              {" "}
              a <strong className="text-foreground">{search.email}</strong>
            </>
          ) : null}
          . Ábrelo para verificar tu correo y entrar.
        </>
      }
      footer={
        <Link to="/login" className="font-medium text-primary underline">
          Volver a entrar
        </Link>
      }
    >
      {search.email ? (
        <Button
          variant="outline"
          onClick={async () => {
            setProblem(null)
            const { error } = await authClient.sendVerificationEmail({
              email: search.email ?? "",
              callbackURL: `${window.location.origin}/`,
            })
            if (error) setProblem(accountErrorText(error))
            else setResent(true)
          }}
        >
          {resent ? "Te lo enviamos de nuevo" : "Reenviar el enlace"}
        </Button>
      ) : null}
      {problem ? <AuthAlert>{problem}</AuthAlert> : null}
    </AuthLayout>
  )
}

export function ForgotPasswordPage() {
  const search = useSearch({ strict: false }) as { email?: string; vencido?: string }
  const [email, setEmail] = useState(search.email ?? "")
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useFormState()

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    form.setProblem(null)
    if (!emailSchema.safeParse(email).success) {
      form.setErrors({ email: "Escribe un correo válido, como nombre@tienda.com" })
      return
    }
    form.setErrors({})
    form.setPending(true)
    try {
      const { error } = await authFetch("/access-link/request", {
        method: "POST",
        body: { email: email.trim(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      })
      if (error) form.setProblem(accountErrorText(error))
      else setSentTo(email.trim())
    } finally {
      form.setPending(false)
    }
  }

  if (sentTo)
    return (
      <AuthLayout
        title={
          <span className="flex flex-col gap-3">
            <MailCheck
              className="size-10 rounded-xl bg-primary-soft p-2 text-primary"
              aria-hidden
            />
            Revisa tu correo
          </span>
        }
        description={
          <>
            Si hay una cuenta con <strong className="text-foreground">{sentTo}</strong>, le enviamos
            un enlace para entrar. Al abrirlo eliges tu nueva contraseña.
          </>
        }
        footer={
          <Link to="/login" className="font-medium text-primary underline">
            Volver a entrar
          </Link>
        }
      >
        <span />
      </AuthLayout>
    )

  return (
    <AuthLayout
      title="Recupera tu acceso"
      description="Te enviamos un enlace que te deja dentro; ahí eliges tu nueva contraseña."
      footer={
        <Link to="/login" className="font-medium text-primary underline">
          Volver a entrar
        </Link>
      }
    >
      {search.vencido === "1" ? <AuthAlert>El enlace ya venció. Pide uno nuevo.</AuthAlert> : null}
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <Field data-invalid={form.errors.email ? true : undefined}>
            <FieldLabel htmlFor="email">Correo</FieldLabel>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={form.errors.email ? true : undefined}
              aria-describedby={form.errors.email ? "email-error" : undefined}
            />
            {form.errors.email ? (
              <FieldError id="email-error">{form.errors.email}</FieldError>
            ) : null}
          </Field>
          {form.problem ? <AuthAlert>{form.problem}</AuthAlert> : null}
          <SubmitButton type="submit" pending={form.pending} className="h-11 w-full text-base">
            Enviarme el enlace
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}

export function TwoFactorPage() {
  const search = useSearch({ strict: false }) as { next?: string }
  const [code, setCode] = useState("")
  const [backup, setBackup] = useState(false)
  const form = useFormState()
  const next = safeNext(search.next)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const clean = code.replace(/\s/g, "")
    if (!clean) {
      form.setErrors({
        code: backup ? "Escribe uno de tus códigos de respaldo" : "Escribe el código de 6 dígitos",
      })
      return
    }
    form.setErrors({})
    form.setPending(true)
    try {
      const result = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: clean })
        : await authClient.twoFactor.verifyTotp({ code: clean })
      if (result.error) {
        form.setProblem(
          accountErrorText({ ...result.error, code: (result.error as { code?: string }).code }),
        )
        return
      }
      forgetToken()
      window.location.assign(next ?? "/")
    } finally {
      form.setPending(false)
    }
  }

  return (
    <AuthLayout
      title="Un paso más"
      description={
        backup
          ? "Escribe uno de los códigos de respaldo que guardaste al activar los dos pasos."
          : "Escribe el código de 6 dígitos de tu app de autenticación."
      }
      footer={
        <button
          type="button"
          className="font-medium text-primary underline"
          onClick={() => {
            setBackup((v) => !v)
            setCode("")
            form.setProblem(null)
            form.setErrors({})
          }}
        >
          {backup ? "Usar el código de mi app" : "Usar un código de respaldo"}
        </button>
      }
    >
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <Field data-invalid={form.errors.code ? true : undefined}>
            <FieldLabel htmlFor="code">{backup ? "Código de respaldo" : "Código"}</FieldLabel>
            <Input
              id="code"
              autoComplete="one-time-code"
              inputMode={backup ? "text" : "numeric"}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={form.errors.code ? true : undefined}
              aria-describedby={form.errors.code ? "code-error" : undefined}
            />
            {form.errors.code ? <FieldError id="code-error">{form.errors.code}</FieldError> : null}
          </Field>
          {form.problem ? <AuthAlert>{form.problem}</AuthAlert> : null}
          <SubmitButton type="submit" pending={form.pending} className="h-11 w-full text-base">
            Entrar
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}
