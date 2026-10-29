import { Button, Checkbox, Field, FieldDescription, FieldError, FieldGroup, FieldLabel, Input } from "@odentia/ui"
import { AuthSplit, SubmitButton, totpDigits } from "@odentia/ui-patterns"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { authClient } from "../lib/auth-client"
import { AuthLegal, RecoverAside, WelcomeAside } from "../lib/auth-screens"
import { safeNext } from "../lib/safe-next"

export const Route = createFileRoute("/two-factor")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(String(search.enlace) === "1" ? { enlace: 1 as const } : {}),
  }),
  component: TwoFactorPage,
})

/**
 * Segundo paso del login cuando la cuenta tiene la verificación en dos pasos
 * (ADR 0106; incluye el retorno del admin: `?next=` al dominio admin). El
 * código de la app, o uno de respaldo, y recordar el navegador 30 días. Sin
 * sesión pendiente, Better Auth responde error y se vuelve a entrar.
 */
function TwoFactorPage() {
  const navigate = useNavigate()
  const { next, enlace } = useSearch({ from: "/two-factor" })
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState("")
  const [trust, setTrust] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(value: string) {
    if (pending) return
    if (recovery ? value.trim().length < 4 : value.length < 6) {
      setError(recovery ? "Escribe uno de tus códigos de respaldo." : "Escribe los 6 dígitos.")
      return
    }
    setPending(true)
    setError(null)
    const target = safeNext(next)
    try {
      const result = recovery
        ? await authClient.twoFactor.verifyBackupCode({ code: value.trim(), trustDevice: trust })
        : await authClient.twoFactor.verifyTotp({ code: value, trustDevice: trust })
      if (result.error) {
        setPending(false)
        setError(
          recovery
            ? "Ese código no existe o ya se usó."
            : "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático.",
        )
        return
      }
    } catch {
      setPending(false)
      setError("No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.")
      return
    }
    if (target) {
      window.location.assign(target)
      return
    }
    const { data: orgs } = await authClient.organization.list()
    await navigate({ to: orgs && orgs.length > 0 ? "/" : "/onboarding" })
  }

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
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(code)
        }}
      >
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="code">{recovery ? "Código de respaldo" : "Código de 6 dígitos"}</FieldLabel>
            <Input
              id="code"
              key={recovery ? "recovery" : "totp"}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "code-error" : "code-help"}
              inputMode={recovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              maxLength={recovery ? 32 : 6}
              autoFocus
              value={code}
              onChange={(event) => {
                const value = recovery ? event.target.value : totpDigits(event.target.value)
                setCode(value)
                if (error) setError(null)
                if (!recovery && value.length === 6) void submit(value)
              }}
              className={recovery ? "font-mono" : "h-12 font-mono text-2xl tracking-[0.4em]"}
            />
            {error ? (
              <FieldError id="code-error">{error}</FieldError>
            ) : (
              <FieldDescription id="code-help">{recovery ? "Con guion o sin él." : "Al escribir el sexto número entras solo."}</FieldDescription>
            )}
          </Field>
          <div className="flex items-start gap-2.5 text-sm">
            <Checkbox id="trust" className="mt-0.5" checked={trust} onCheckedChange={(checked) => setTrust(checked === true)} />
            <label htmlFor="trust" className="flex flex-col gap-0.5">
              <span className="font-medium">Recordar este dispositivo 30 días</span>
              <span className="text-muted-foreground">Solo si es tu teléfono o tu computadora. En un equipo compartido de recepción, déjalo sin marcar.</span>
            </label>
          </div>
          <SubmitButton type="submit" pending={pending} className="w-full">
            Entrar
          </SubmitButton>
        </FieldGroup>
      </form>
      <div className="flex flex-col gap-2 text-sm">
        <Button
          type="button"
          variant="link"
          className="h-auto self-start p-0"
          onClick={() => {
            setRecovery((value) => !value)
            setCode("")
            setError(null)
          }}
        >
          {recovery ? "Usar el código de la app" : "Usar un código de respaldo"}
        </Button>
        <p className="text-muted-foreground">¿Perdiste el teléfono y los códigos? Pide al propietario de tu clínica que restablezca tu verificación.</p>
      </div>
    </AuthSplit>
  )
}
