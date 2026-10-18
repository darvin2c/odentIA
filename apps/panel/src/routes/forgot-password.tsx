import { Button, Field, FieldError, FieldGroup, FieldLabel, Input } from "@odentia/ui"
import { AuthSplit, fieldErrorMessages, SubmitButton } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute, Link, useSearch } from "@tanstack/react-router"
import { MailCheck, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { authClient } from "../lib/auth-client"
import { AuthAlert, AuthLegal, RecoverAside } from "../lib/auth-screens"
import { countdown } from "../lib/countdown"
import { readRememberedUser } from "../lib/welcome"

export const Route = createFileRoute("/forgot-password")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.email === "string" ? { email: search.email } : {}),
    ...(String(search.vencido) === "1" ? { vencido: 1 as const } : {}),
  }),
  component: ForgotPasswordPage,
})

const RESEND_SECONDS = 60

/** Pide el enlace de acceso; el servidor responde igual exista o no la cuenta. */
async function requestLink(email: string): Promise<string | null> {
  try {
    const { error } = await authClient.$fetch("/access-link/request", {
      method: "POST",
      body: { email, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    if (!error) return null
    if (error.status === 429) return "Ya te enviamos varios enlaces. Espera unos minutos."
    return error.message || "No pudimos enviarlo. Inténtalo de nuevo."
  } catch {
    return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo."
  }
}

/**
 * «¿Olvidaste tu contraseña?» (lienzo «Recuperar el acceso», pasos 1 y 2, y
 * «Enlace vencido»): pide un enlace que deja a la persona dentro de su
 * clínica, donde elige la nueva contraseña. El correo viene escrito desde la
 * pantalla de entrar.
 */
function ForgotPasswordPage() {
  const { email: fromLogin, vencido } = useSearch({ from: "/forgot-password" })
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const expired = vencido === 1 && !sentTo

  const form = useForm({
    defaultValues: { email: fromLogin ?? readRememberedUser()?.email ?? "" },
    validators: {
      onSubmit: z.object({
        email: z.string().email("Escribe un correo válido, como nombre@clinica.com"),
      }),
    },
    onSubmit: async ({ value }) => {
      setProblem(null)
      const message = await requestLink(value.email)
      if (message) setProblem(message)
      else setSentTo(value.email)
    },
  })

  if (sentTo) {
    return (
      <AuthSplit
        title={
          <span className="flex flex-col gap-3">
            <MailCheck className="size-10 rounded-xl bg-primary/10 p-2 text-primary" aria-hidden />
            Revisa tu correo
          </span>
        }
        description={
          <>
            Si hay una cuenta con <strong className="text-foreground">{sentTo}</strong>, ya tiene un
            enlace para entrar. Vence en 30 minutos.
          </>
        }
        aside={<RecoverAside />}
        legal={<AuthLegal />}
        footer={
          <Link to="/login" className="underline">
            Volver a entrar
          </Link>
        }
      >
        <SentActions email={sentTo} onChange={() => setSentTo(null)} />
      </AuthSplit>
    )
  }

  return (
    <AuthSplit
      title={
        expired ? (
          <span className="flex flex-col gap-3">
            <TriangleAlert
              className="size-10 rounded-xl bg-destructive/10 p-2 text-destructive"
              aria-hidden
            />
            Este enlace ya no sirve
          </span>
        ) : (
          "¿Olvidaste tu contraseña?"
        )
      }
      description={
        expired
          ? "Los enlaces duran 30 minutos y sirven una sola vez. Te mandamos otro ahora."
          : "Te enviamos un enlace para entrar. Adentro eliges una nueva."
      }
      aside={<RecoverAside />}
      legal={<AuthLegal />}
      footer={
        <Link to="/login" className="underline">
          Volver a entrar
        </Link>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
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
                  inputMode="email"
                  autoComplete="username"
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  aria-describedby={field.state.meta.errors.length ? "email-error" : undefined}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError id="email-error">
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          {problem ? <AuthAlert>{problem}</AuthAlert> : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                {expired ? "Enviarme otro enlace" : "Enviarme el enlace"}
              </SubmitButton>
            )}
          </form.Subscribe>
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

/** Reenviar espera 60 segundos; cambiar el correo vuelve con lo escrito. */
function SentActions({ email, onChange }: { email: string; onChange: () => void }) {
  const [wait, setWait] = useState(RESEND_SECONDS)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (wait <= 0) return
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(t)
  }, [wait])

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={wait > 0 || sending}
          onClick={async () => {
            setSending(true)
            const message = await requestLink(email)
            setSending(false)
            setNotice(message ?? "Te enviamos otro enlace. Solo sirve el último.")
            setWait(RESEND_SECONDS)
          }}
        >
          {wait > 0 ? `Reenviar en ${countdown(wait)}` : "Reenviar"}
        </Button>
        <Button type="button" variant="outline" onClick={onChange}>
          Cambiar correo
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        ¿No llega? Revisa Spam o Promociones. Si lo abres en el celular, entras en el celular.
      </p>
    </div>
  )
}
