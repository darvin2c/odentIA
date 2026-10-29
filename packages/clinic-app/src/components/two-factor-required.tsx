import { Button, Field, FieldDescription, FieldError, FieldLabel, Input } from "@odentia/ui"
import { RECOMMENDED_AUTHENTICATORS, SubmitButton, totpDigits } from "@odentia/ui-patterns"
import { useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { authClient } from "../lib/auth-client"
import { panelUrl, tenantUrl } from "../lib/host"
import { productUi } from "../product/product-ui"

/**
 * La clínica pide verificación en dos pasos a su equipo (ADR 0107) y esta
 * sesión no la cumple: en vez de la aplicación, la API responde
 * `TWO_FACTOR_REQUIRED` (aún no la tiene: se activa en Mi perfil y se vuelve
 * aquí) o `TWO_FACTOR_CODE_REQUIRED` (la tiene, pero entró sin el código, por
 * ejemplo con Google: se escribe aquí). Sus otras clínicas no cambian.
 */
export function TwoFactorRequiredPage({ org, need }: { org: { name: string; slug: string }; need: "activar" | "codigo" }) {
  const href = useRouterState({ select: (state) => state.location.href })
  const [leaving, setLeaving] = useState(false)
  const back = tenantUrl(org.slug, href, productUi().product)
  return (
    <main className="flex min-h-svh justify-center bg-background px-4 py-14">
      <div className="flex w-full max-w-md flex-col gap-6">
        <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-primary-soft font-bold text-primary-soft-foreground">
            {org.name.trim().charAt(0).toUpperCase()}
          </span>
          {org.name}
        </p>
        {need === "codigo" ? (
          <CodeStep orgName={org.name} />
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              <h1 className="font-heading text-2xl font-extrabold tracking-tight text-balance">{org.name} pide verificación en dos pasos</h1>
              <p className="text-[15px] text-muted-foreground">
                Para proteger los datos de sus pacientes, el equipo entra con su contraseña y un código de una app del teléfono. Lo activas una sola vez y tarda un par de minutos.
              </p>
            </div>
            <section aria-labelledby="apps" className="flex flex-col gap-2 rounded-xl bg-muted p-4 text-sm">
              <h2 id="apps" className="font-bold">
                Instala una de estas en tu teléfono
              </h2>
              <ul className="flex list-disc flex-col gap-1 pl-4 font-medium">
                {RECOMMENDED_AUTHENTICATORS.map((app) => (
                  <li key={app}>{app}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Gratis, en Android y iPhone, y guardan copia en tu cuenta: si cambias de teléfono no pierdes el acceso. Si ya usas otra app de códigos, también sirve.
              </p>
            </section>
            <Button size="lg" render={<a href={panelUrl(`/profile?edit=two-factor&next=${encodeURIComponent(back)}`)} />}>
              Activarla ahora
            </Button>
          </>
        )}
        <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          <span>Tus otras clínicas no cambian: solo esta la pide.</span>
          <a href={panelUrl("/?cambiar=1")} className="font-semibold text-primary">
            Ir a otra de mis clínicas
          </a>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 font-semibold"
            disabled={leaving}
            onClick={() => {
              setLeaving(true)
              void authClient.signOut().finally(() => window.location.assign(panelUrl("/login")))
            }}
          >
            Cerrar sesión
          </Button>
        </div>
      </div>
    </main>
  )
}

/** Ya la tiene: el código de su app (o uno de respaldo) para esta sesión, y se recarga la clínica. */
function CodeStep({ orgName }: { orgName: string }) {
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState("")
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
    // Con la sesión abierta, Better Auth comprueba el código de esta misma sesión.
    const result = await authClient
      .$fetch(recovery ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp", {
        method: "POST",
        body: { code: recovery ? value.trim() : value },
      })
      .catch(() => null)
    if (!result || result.error) {
      setPending(false)
      setError(
        !result
          ? "No pudimos conectar. Revisa tu conexión e inténtalo de nuevo."
          : result.error.status === 403 && result.error.message
            ? result.error.message
            : recovery
            ? "Ese código no existe o ya se usó."
            : "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático.",
      )
      return
    }
    window.location.reload()
  }

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <h1 className="font-heading text-2xl font-extrabold tracking-tight text-balance">
          {recovery ? "Escribe un código de respaldo" : "Escribe el código de tu app"}
        </h1>
        <p className="text-[15px] text-muted-foreground">
          {orgName} pide verificación en dos pasos y esta vez entraste sin el código (por ejemplo, con Google). Escríbelo para seguir.
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(code)
        }}
      >
        <Field>
          <FieldLabel htmlFor="clinic-code">{recovery ? "Código de respaldo" : "Código de 6 dígitos"}</FieldLabel>
          <Input
            id="clinic-code"
            key={recovery ? "recovery" : "totp"}
            inputMode={recovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={recovery ? 32 : 6}
            autoFocus
            value={code}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "clinic-code-error" : "clinic-code-help"}
            onChange={(event) => {
              const value = recovery ? event.target.value : totpDigits(event.target.value)
              setCode(value)
              if (error) setError(null)
              if (!recovery && value.length === 6) void submit(value)
            }}
            className={recovery ? "font-mono" : "h-12 font-mono text-2xl tracking-[0.4em]"}
          />
          {error ? (
            <FieldError id="clinic-code-error">{error}</FieldError>
          ) : (
            <FieldDescription id="clinic-code-help">{recovery ? "Con guion o sin él." : "Al escribir el sexto número sigues solo."}</FieldDescription>
          )}
        </Field>
        <SubmitButton type="submit" size="lg" pending={pending}>
          Seguir
        </SubmitButton>
      </form>
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
    </>
  )
}
