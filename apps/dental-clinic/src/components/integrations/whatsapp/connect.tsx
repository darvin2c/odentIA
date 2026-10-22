import { Button } from "@odentia/ui"
import { useId } from "react"
import type { ConnectResult } from "../../../lib/whatsapp"
import { FacebookSignupButton } from "../../whatsapp/facebook-signup"
import { WhatsAppConnectSteps } from "./connect-steps"

/**
 * Conectar un número de WhatsApp: una sola pantalla con los dos caminos.
 * Primero el botón de Facebook, que solo existe si la instalación lo tiene
 * habilitado; debajo, los datos de la app de Meta de la clínica en tres pasos.
 * Con cualquiera de los dos el número queda igual de conectado.
 */
export function WhatsAppConnect({
  another = false,
  onCreated,
  onCancel,
}: {
  /** La clínica ya tiene un número: este es otro. */
  another?: boolean
  onCreated: (result: ConnectResult) => void
  /** Solo al conectar otro número: dejar de ofrecerlo. */
  onCancel?: () => void
}) {
  const headingId = useId()
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby={headingId} className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden
            className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-sm font-bold text-primary-soft-foreground sm:flex"
          >
            WA
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={headingId} className="font-heading text-base font-semibold">
              {another ? "Conecta otro número de WhatsApp" : "Conecta el WhatsApp de la clínica"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Tu número y tu cuenta siguen siendo tuyos: odentIA solo recibe permiso para enviar y recibir por ese número. Al
              conectar, atiende el agente, responde tu equipo desde la Bandeja y salen los recordatorios y avisos.
            </p>
          </div>
          {onCancel ? (
            <Button type="button" variant="ghost" className="min-h-11 shrink-0 sm:min-h-9" onClick={onCancel}>
              Cancelar
            </Button>
          ) : null}
        </div>
        {/* El botón no se dibuja si la instalación no lo tiene: entonces su explicación tampoco. */}
        <div className="peer flex flex-col gap-3 empty:hidden">
          {/* Lleva al panel, que abre la ventana de Meta y vuelve aquí con `?conectado=`. */}
          <FacebookSignupButton />
        </div>
        <p className="text-sm text-muted-foreground peer-empty:hidden">
          Entras con el Facebook de quien administra la clínica, eliges el número y vuelves con él conectado, sin copiar ningún
          dato. Ten a mano el teléfono de ese número, para recibir un código. Si el número se usa hoy en la aplicación de
          WhatsApp de un teléfono, Meta puede pedir darlo de baja ahí antes de conectarlo.
        </p>
      </section>

      <WhatsAppConnectSteps title="Conectar con los datos de mi app de Meta" connection={null} created={null} step={1} onCreated={onCreated} />
    </div>
  )
}
