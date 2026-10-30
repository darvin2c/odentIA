import { Button, Input } from "@odentia/ui"
import {
  RECOMMENDED_AUTHENTICATORS,
  SubmitButton,
  submitForm,
  totpDigits,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useRouterState } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { z } from "zod"
import { ApiError } from "../lib/api"
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

const totpSchema = z.object({ code: z.string().length(6, "Escribe los 6 dígitos.") })
const backupSchema = z.object({ code: z.string().trim().min(4, "Escribe uno de tus códigos de respaldo.") })

/** Ya la tiene: el código de su app (o uno de respaldo) para esta sesión, y se recarga la clínica. */
function CodeStep({ orgName }: { orgName: string }) {
  const [recovery, setRecovery] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const form = useAppForm({
    defaultValues: { code: "" },
    validators: { onSubmit: recovery ? backupSchema : totpSchema },
    onSubmit: async ({ value }) => {
      // Con la sesión abierta, Better Auth comprueba el código de esta misma sesión.
      const result = await authClient
        .$fetch(recovery ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp", {
          method: "POST",
          body: { code: recovery ? value.code.trim() : value.code },
        })
        .catch(() => null)
      if (!result) throw new Error("No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.")
      if (result.error) {
        const { status, message } = result.error
        // Lo que no es el código (límite de intentos, bloqueo, el servidor) se dice junto a «Seguir».
        if (status === 429) throw new Error("Hiciste muchos intentos seguidos. Espera un minuto y vuelve a intentarlo.")
        if (status >= 500) throw new Error("No pudimos comprobar el código ahora. Inténtalo de nuevo en un momento.")
        if (status === 403 && message) throw new Error(message)
        const wrong = recovery
          ? "Ese código no existe o ya se usó."
          : "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático."
        // Better Auth responde 401 a un código equivocado: como rechazo (400) va a su campo y no se lee como sesión vencida.
        throw new ApiError(400, { code: "INVALID_CODE", message: wrong, fields: { code: wrong } })
      }
      window.location.reload()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)

  async function send() {
    if (form.state.isSubmitting) return
    const ok = await submitForm(form, { root: formRef.current })
    // Tras un código rechazado queda seleccionado: se escribe el nuevo encima.
    if (!ok) requestAnimationFrame(() => inputRef.current?.select())
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
        ref={formRef}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <form.AppField name="code">
          {(field) => (
            <field.Control
              id="clinic-code"
              label={recovery ? "Código de respaldo" : "Código de 6 dígitos"}
              description={recovery ? "Con guion o sin él." : "Al escribir el sexto número sigues solo."}
            >
              {(control) => (
                <Input
                  {...control.props}
                  ref={inputRef}
                  key={recovery ? "recovery" : "totp"}
                  inputMode={recovery ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  maxLength={recovery ? 32 : 6}
                  autoFocus
                  value={field.state.value}
                  onChange={(event) => {
                    const value = recovery ? event.target.value : totpDigits(event.target.value)
                    field.handleChange(value)
                    if (!recovery && value.length === 6) void send()
                  }}
                  className={recovery ? "font-mono" : "h-12 font-mono text-2xl tracking-[0.4em]"}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
          form.reset({ code: "" })
        }}
      >
        {recovery ? "Usar el código de la app" : "Usar un código de respaldo"}
      </Button>
    </>
  )
}
