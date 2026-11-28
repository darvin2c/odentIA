import { Button, Field, FieldError, FieldGroup, FieldLabel } from "@odentia/ui"
import {
  AuthSplit,
  clearSubmitErrors,
  PasswordInput,
  PersonAvatar,
  SubmitButton,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSurface,
} from "@odentia/ui-patterns"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { MailCheck } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { ApiError } from "./lib/api"
import {
  accountErrorText,
  authClient,
  authFetch,
  forgetToken,
  forgetUser,
  readRememberedUser,
  rememberUser,
  safeNext,
  TERMS_VERSION,
} from "./lib/cuenta"

/**
 * La entrada de gestorIA con la cuenta única (lienzo B, tablero 9): entrar, crear la cuenta,
 * verificar el correo, recuperar el acceso y el segundo paso. Por detrás es la misma cuenta de
 * odentIA, latidIA y vistIA: quien ya la tiene entra con su contraseña; quien llega nuevo se
 * registra aquí y no ve otra marca. Las direcciones (`/login`, `/forgot-password`,
 * `/two-factor`) son las que usa la cuenta al volver de un enlace. La pantalla es la misma de
 * las clínicas (`AuthSplit`), con la marca de gestorIA (lienzo «Una cuenta, todas las apps»,
 * tablero 5). Los formularios son los comunes (`useAppForm`): cada error en su campo y lo que no
 * es de ninguno, junto al botón.
 */

/** Un aviso dentro de un formulario de la entrada: junto al botón, no en uno que se va. */
function AuthAlert({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
  )
}

/** La línea bajo «Entrar»: la cuenta no es solo de gestorIA. */
function SameAccount() {
  return (
    <p className="text-center text-xs text-muted-foreground">
      Tu cuenta es la misma en todas tus apps.
    </p>
  )
}

const EMAIL_PROBLEM = "Escribe un correo válido, como nombre@tienda.com"
const NO_CONNECTION = "No hay conexión con tu cuenta. Revisa tu internet e inténtalo de nuevo."
const email = z.string().trim().email(EMAIL_PROBLEM)

/** Lo que la cuenta respondió, para decirlo junto al botón (o en su campo, con `field`). */
function accountProblem(
  error: { code?: string; message?: string; status?: number } | null | undefined,
  field?: string,
): Error {
  const text = accountErrorText(error)
  return field ? new ApiError(400, error?.code ?? "", text, { [field]: text }) : new Error(text)
}

/** Llama a la cuenta; sin red, lo dice con sus palabras (no como un envío sin confirmar). */
async function reachAccount<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch {
    throw new Error(NO_CONNECTION)
  }
}

/**
 * La contraseña con «¿Olvidaste tu contraseña?» junto a la etiqueta (en el teclado va después del
 * campo): pinta su propio `Field` con el estado de `form.AppField`, como la entrada de las clínicas.
 */
function LoginPassword({ autoFocus, forgotEmail }: { autoFocus: boolean; forgotEmail: string }) {
  const field = useFieldContext<string>()
  const { control, errors, errorId } = useFieldControl({ id: "password", hasDescription: false })
  return (
    <Field data-invalid={control.invalid || undefined}>
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-2">
        <FieldLabel htmlFor={control.id} className="col-start-1 row-start-1">
          Contraseña
        </FieldLabel>
        <div className="col-span-2 row-start-2">
          <PasswordInput
            id={control.id}
            value={field.state.value}
            onChange={(next) => field.handleChange(next)}
            onBlur={control.onBlur}
            autoComplete="current-password"
            autoFocus={autoFocus}
            invalid={control.invalid}
            describedBy={control.describedBy}
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
          search={forgotEmail ? { email: forgotEmail } : {}}
          className="col-start-2 row-start-1 text-sm font-medium text-primary underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>
    </Field>
  )
}

const loginSchema = z.object({ email, password: z.string().min(1, "Escribe tu contraseña") })
// Con la persona recordada el correo no se muestra: no se valida lo que no se puede corregir.
const knownLoginSchema = z.object({
  email: z.string(),
  password: z.string().min(1, "Escribe tu contraseña"),
})

export function LoginPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { next?: string; bloqueada?: string }
  // Quien entró la última vez desde este navegador: su correo entero y solo la contraseña.
  const [known, setKnown] = useState(readRememberedUser)
  const [unverified, setUnverified] = useState(false)
  const [resent, setResent] = useState(false)
  const [resendProblem, setResendProblem] = useState<string | null>(null)
  const next = safeNext(search.next)

  const form = useAppForm({
    defaultValues: { email: known?.email ?? "", password: "" },
    validators: { onSubmit: known ? knownLoginSchema : loginSchema },
    onSubmit: async ({ value }) => {
      setUnverified(false)
      setResendProblem(null)
      const result = await reachAccount(() =>
        authClient.signIn.email({ email: value.email.trim(), password: value.password }),
      )
      if (result.error) {
        const code = (result.error as { code?: string }).code
        if (code === "EMAIL_NOT_VERIFIED") {
          setUnverified(true)
          return
        }
        throw accountProblem({ code, message: result.error.message, status: result.error.status })
      }
      const signed = result.data as {
        twoFactorRedirect?: boolean
        user?: { name: string; email: string }
      } | null
      if (signed?.user) rememberUser({ name: signed.user.name, email: signed.user.email })
      if (signed?.twoFactorRedirect) {
        await navigate({ to: "/two-factor", search: next ? { next } : {} })
        return
      }
      forgetToken()
      if (next) window.location.assign(next)
      else await navigate({ to: "/" })
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form)

  /** Otra persona en este navegador: deja de recordar a la anterior y pide el correo. */
  function otherAccount() {
    forgetUser()
    setKnown(null)
    form.reset({ email: "", password: "" })
    clearSubmitErrors(form)
    setUnverified(false)
    setResendProblem(null)
    // El botón desaparece: el foco pasa al correo, que es lo que sigue (WCAG 2.4.3).
    window.requestAnimationFrame(() => document.getElementById("email")?.focus())
  }

  return (
    <AuthSplit
      title="Entra a tu tienda"
      footer={
        known ? null : (
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
        )
      }
    >
      {search.bloqueada === "1" ? (
        <AuthAlert>Tu cuenta está bloqueada. Escribe a soporte para revisarla.</AuthAlert>
      ) : null}
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          {known ? (
            <div className="flex items-center gap-3">
              <PersonAvatar name={known.name} className="size-10" decorative />
              <div className="flex min-w-0 flex-col">
                <span className="font-semibold [overflow-wrap:anywhere]">{known.name}</span>
                {/* El correo entero: cortado, dos cuentas parecidas se confunden. */}
                <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {known.email}
                </span>
              </div>
              {/* El gestor de contraseñas necesita el usuario aunque no se escriba. */}
              <input
                type="email"
                name="email"
                autoComplete="username"
                value={known.email}
                readOnly
                hidden
              />
            </div>
          ) : (
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label="Correo"
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                />
              )}
            </form.AppField>
          )}
          <form.Subscribe selector={(state) => state.values.email}>
            {(typed) => (
              <form.AppField name="password">
                {() => <LoginPassword autoFocus={Boolean(known)} forgotEmail={typed} />}
              </form.AppField>
            )}
          </form.Subscribe>
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
                    const { error: sendError } = await authClient.sendVerificationEmail({
                      email: form.state.values.email.trim(),
                      callbackURL: `${window.location.origin}/`,
                    })
                    if (sendError) setResendProblem(accountErrorText(sendError))
                    else setResent(true)
                  }}
                >
                  Reenviar el enlace
                </button>
              </span>
            </AuthAlert>
          ) : null}
          {(error ?? resendProblem) ? <AuthAlert>{error ?? resendProblem}</AuthAlert> : null}
          <SubmitButton type="submit" pending={isSubmitting} className="w-full">
            Entrar
          </SubmitButton>
          {known ? (
            <Button type="button" variant="outline" className="w-full" onClick={otherAccount}>
              Entrar con otra cuenta
            </Button>
          ) : null}
          <SameAccount />
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

const registerSchema = z.object({
  name: z.string().trim().min(1, "Escribe tu nombre"),
  email,
  password: z.string().min(8, "Usa al menos 8 caracteres"),
  accepted: z.boolean().refine((value) => value, "Acepta los términos para crear tu cuenta"),
})

export function RegisterPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { next?: string }
  const next = safeNext(search.next)
  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "", accepted: false },
    validators: { onSubmit: registerSchema },
    onSubmit: async ({ value }) => {
      const [firstName = "", ...rest] = value.name.trim().split(/\s+/)
      const result = await reachAccount(() =>
        authClient.signUp.email({
          name: value.name.trim(),
          email: value.email.trim(),
          password: value.password,
          firstName,
          lastName: rest.join(" "),
          termsVersion: TERMS_VERSION,
          callbackURL: `${window.location.origin}${next ?? "/"}`,
        }),
      )
      if (result.error) {
        const code = (result.error as { code?: string }).code
        if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_COMPROMISED")
          throw accountProblem({ code }, "password")
        throw accountProblem({ code, message: result.error.message, status: result.error.status })
      }
      await navigate({ to: "/verify-email-sent", search: { email: value.email.trim() } })
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form)

  return (
    <AuthSplit
      title="Crea tu cuenta"
      description="Tu cuenta es la misma en todas tus apps. Después creas tu tienda."
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
          <form.AppField name="name">
            {(field) => <field.TextField label="Tu nombre" id="name" autoComplete="name" />}
          </form.AppField>
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                label="Correo"
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
              />
            )}
          </form.AppField>
          <form.AppField name="password">
            {(field) => (
              <field.PasswordField
                label="Contraseña"
                id="password"
                autoComplete="new-password"
                requirements={[
                  {
                    label: "Al menos 8 caracteres",
                    met: field.state.value ? field.state.value.length >= 8 : null,
                  },
                ]}
              />
            )}
          </form.AppField>
          <form.AppField name="accepted">
            {(field) => (
              <field.CheckboxField
                id="terms"
                label={
                  <span className="font-normal">
                    Acepto los{" "}
                    <a
                      className="text-primary underline"
                      href="https://gestoria24.com/terminos"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Términos
                    </a>{" "}
                    y el{" "}
                    <a
                      className="text-primary underline"
                      href="https://gestoria24.com/privacidad"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Aviso de privacidad
                    </a>{" "}
                    del Grupo Sallca.
                  </span>
                }
              />
            )}
          </form.AppField>
          {error ? <AuthAlert>{error}</AuthAlert> : null}
          <SubmitButton type="submit" pending={isSubmitting} className="w-full">
            Crear mi cuenta
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

export function VerifyEmailSentPage() {
  const search = useSearch({ strict: false }) as { email?: string }
  const [resent, setResent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <AuthSplit
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
    </AuthSplit>
  )
}

export function ForgotPasswordPage() {
  const search = useSearch({ strict: false }) as { email?: string; vencido?: string }
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { email: search.email ?? "" },
    validators: { onSubmit: z.object({ email }) },
    onSubmit: async ({ value }) => {
      const { error } = await authFetch("/access-link/request", {
        method: "POST",
        body: {
          email: value.email.trim(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })
      if (error) throw accountProblem(error)
      setSentTo(value.email.trim())
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form)

  if (sentTo)
    return (
      <AuthSplit
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
      </AuthSplit>
    )

  return (
    <AuthSplit
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
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                label="Correo"
                id="email"
                type="email"
                inputMode="email"
                autoComplete="username"
              />
            )}
          </form.AppField>
          {error ? <AuthAlert>{error}</AuthAlert> : null}
          <SubmitButton type="submit" pending={isSubmitting} className="w-full">
            Enviarme el enlace
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

export function TwoFactorPage() {
  const search = useSearch({ strict: false }) as { next?: string }
  const [backup, setBackup] = useState(false)
  const next = safeNext(search.next)
  const form = useAppForm({
    defaultValues: { code: "" },
    validators: {
      onSubmit: z.object({
        code: z
          .string()
          .refine(
            (value) => value.replace(/\s/g, "") !== "",
            backup ? "Escribe uno de tus códigos de respaldo" : "Escribe el código de 6 dígitos",
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      const clean = value.code.replace(/\s/g, "")
      const result = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: clean })
        : await authClient.twoFactor.verifyTotp({ code: clean })
      if (result.error)
        throw accountProblem({
          ...result.error,
          code: (result.error as { code?: string }).code,
        })
      // Con el segundo paso, la cuenta dice quién es recién aquí: la entrada la recuerda igual.
      const user = (result.data as { user?: { name: string; email: string } } | null)?.user
      if (user) rememberUser({ name: user.name, email: user.email })
      forgetToken()
      window.location.assign(next ?? "/")
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form)

  return (
    <AuthSplit
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
            form.reset()
            clearSubmitErrors(form)
          }}
        >
          {backup ? "Usar el código de mi app" : "Usar un código de respaldo"}
        </button>
      }
    >
      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <form.AppField name="code">
            {(field) => (
              <field.TextField
                label={backup ? "Código de respaldo" : "Código"}
                id="code"
                autoComplete="one-time-code"
                inputMode={backup ? "text" : "numeric"}
                autoFocus
              />
            )}
          </form.AppField>
          {error ? <AuthAlert>{error}</AuthAlert> : null}
          <SubmitButton type="submit" pending={isSubmitting} className="w-full">
            Entrar
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}
