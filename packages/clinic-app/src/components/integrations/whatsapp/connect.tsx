import { Button } from "@odentia/ui"
import { useEffect, useId, useRef, useState } from "react"
import type { ConnectResult } from "../../../lib/whatsapp"
import { FacebookSignupButton, useFacebookSignupAvailable } from "../../whatsapp/facebook-signup"
import { WhatsAppConnectSteps } from "./connect-steps"
import { appWords } from "../../../lib/product-words"

/**
 * Conectar un número de WhatsApp. Con el botón de Facebook disponible, dos
 * caminos lado a lado: el botón (recomendado) y la propia app de Meta de la
 * clínica, cuyos tres pasos se abren solo al elegirla, para que nadie empiece
 * por el camino largo sin querer. Sin el botón, los tres pasos van abiertos.
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
  const { available, loading } = useFacebookSignupAvailable()
  const [ownApp, setOwnApp] = useState(false)
  const steps = useRef<HTMLDivElement>(null)
  // Al elegir la propia app, el foco va a sus pasos.
  useEffect(() => {
    if (ownApp) steps.current?.querySelector<HTMLElement>("h2")?.focus()
  }, [ownApp])
  const showSteps = !loading && (!available || ownApp)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby={headingId} className="@container elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-5">
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
              Tu número y tu cuenta siguen siendo tuyos: {appWords().name} solo recibe permiso para enviar y recibir por ese número. Al
              conectar, atiende el agente, responde tu equipo desde la Bandeja y salen los recordatorios y avisos.
            </p>
          </div>
          {onCancel ? (
            <Button type="button" variant="ghost" className="min-h-11 shrink-0 sm:min-h-9" onClick={onCancel}>
              Cancelar
            </Button>
          ) : null}
        </div>
        {available ? (
          // Dos columnas solo si la tarjeta tiene ancho: con un panel abierto al lado, una debajo de la otra.
          <div className="grid gap-3 @2xl:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-xl border p-4">
              <span className="self-start rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary-soft-foreground">
                Recomendado · 5 minutos
              </span>
              <h3 className="text-[15px] font-semibold">Con tu Facebook</h3>
              <p className="text-sm text-muted-foreground">
                Entras con el Facebook de quien administra la clínica, eliges el número y vuelves conectado, sin copiar ningún dato. Ten
                a mano el teléfono de ese número para recibir un código.
              </p>
              {/* Lleva al panel, que abre la ventana de Meta y vuelve aquí con `?conectado=`. */}
              <div className="mt-auto pt-1">
                <FacebookSignupButton />
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border p-4">
              <span className="self-start rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                30 a 45 minutos · sin programar
              </span>
              <h3 className="text-[15px] font-semibold">Con tu propia app de Meta</h3>
              <p className="text-sm text-muted-foreground">
                Para cuando el botón no está disponible o la clínica prefiere tener su app. Te guiamos paso a paso: creas la app en Meta
                y pegas aquí cuatro datos.
              </p>
              <div className="mt-auto pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  aria-expanded={ownApp}
                  onClick={() => setOwnApp(true)}
                  disabled={ownApp}
                >
                  {ownApp ? "Pasos abiertos abajo" : "Usar mi propia app"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {showSteps ? (
        <div ref={steps}>
          <WhatsAppConnectSteps
            title={available ? "Con tu propia app de Meta" : "Conectar con los datos de mi app de Meta"}
            connection={null}
            created={null}
            step={1}
            onCreated={onCreated}
          />
        </div>
      ) : null}
    </div>
  )
}
