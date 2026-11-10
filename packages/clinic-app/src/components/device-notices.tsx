import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { getRouteApi } from "@tanstack/react-router"
import { ChevronDown, Share } from "lucide-react"
import { useEffect, useId, useState, useSyncExternalStore } from "react"
import {
  canOfferInstall,
  devicePushActive,
  disableDevicePush,
  enableDevicePush,
  isAppleMobile,
  isInstalled,
  notificationPermission,
  offerInstall,
  pushSupport,
  subscribeInstall,
} from "../lib/pwa"
import { useReceptionName } from "../lib/agent-names"
import { appWords } from "../lib/product-words"

const orgRouteApi = getRouteApi("/_org")

/** Lo que llega, dicho una vez junto al interruptor. Sin nombres: se ve con el teléfono bloqueado. */
const whatArrives = (agent: string) =>
  `Te avisamos cuando alguien nuevo te espera en Inicio (con la clínica abierta) y si WhatsApp o ${agent} dejan de funcionar. El aviso no dice el nombre de la persona.`

type State = "cargando" | "apagado" | "activado" | "bloqueado" | "no-compatible" | "instalar-en-iphone" | "no-disponible"

/**
 * «Recibir avisos en este equipo», arriba de «Avisos» (ADR 0176). Es de este
 * equipo y de esta clínica: quien trabaja en dos clínicas los activa en cada una.
 * El navegador pide el permiso solo después del toque. Debajo, instalar la app
 * cuando el navegador lo ofrece, o cómo hacerlo en iPhone.
 */
export function DeviceNotices() {
  const { org } = orgRouteApi.useRouteContext()
  const brand = appWords().name
  const agent = useReceptionName()
  const [state, setState] = useState<State>("cargando")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const helpId = useId()
  const installable = useSyncExternalStore(subscribeInstall, canOfferInstall, () => false)

  useEffect(() => {
    let alive = true
    const support = pushSupport()
    if (support !== "listo") {
      setState(support)
      return
    }
    if (notificationPermission() === "denied") {
      setState("bloqueado")
      return
    }
    devicePushActive()
      .then((active) => alive && setState(active ? "activado" : "apagado"))
      .catch(() => alive && setState("apagado"))
    return () => {
      alive = false
    }
  }, [])

  const toggle = async (on: boolean) => {
    setBusy(true)
    setProblem(null)
    try {
      if (!on) {
        await disableDevicePush()
        setState("apagado")
        return
      }
      const result = await enableDevicePush()
      if (result === "granted") setState("activado")
      else if (result === "denied") setState("bloqueado")
      else if (result === "no-disponible") setState("no-disponible")
      // `default`: cerró la pregunta sin decidir; queda apagado y puede volver a intentar.
    } catch {
      setProblem(on ? "No pudimos activar los avisos. Revisa la conexión y vuelve a intentar." : "No pudimos apagar los avisos. Vuelve a intentar.")
    } finally {
      setBusy(false)
    }
  }

  const switchable = state === "apagado" || state === "activado"
  const label = `Recibir avisos de ${org.name} en este equipo`

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 sm:px-5">
      {state === "instalar-en-iphone" ? (
        <IphoneInstall brand={brand} />
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${helpId}-switch`} className="text-sm font-semibold">
              Recibir avisos en este equipo
            </label>
            <p id={helpId} className="text-xs text-muted-foreground">
              {state === "activado"
                ? "Activado en este equipo. No lo actives en la tablet que le pasas al paciente."
                : state === "bloqueado"
                  ? isAppleMobile()
                    ? `El equipo los tiene bloqueados. Ábrelos en Ajustes › Notificaciones › ${brand}.`
                    : "El navegador los tiene bloqueados. Toca el candado junto a la dirección › Notificaciones › Permitir, y vuelve aquí."
                  : state === "no-compatible"
                    ? "Este navegador no puede recibir avisos. Usa Chrome, Edge o Safari actualizados."
                    : state === "no-disponible"
                      ? "Los avisos en el equipo todavía no están disponibles en esta clínica."
                      : whatArrives(agent)}
            </p>
          </div>
          {state === "no-compatible" || state === "no-disponible" ? null : (
            <Switch
              id={`${helpId}-switch`}
              aria-label={label}
              aria-describedby={helpId}
              className="mt-1"
              checked={state === "activado"}
              disabled={!switchable || busy}
              onCheckedChange={(on) => void toggle(on)}
            />
          )}
        </div>
      )}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {installable && !isInstalled() ? (
        <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => void offerInstall()}>
          Instalar en este equipo
        </Button>
      ) : null}
    </div>
  )
}

/** En iPhone y iPad los avisos llegan solo a la app agregada al inicio desde Safari. */
function IphoneInstall({ brand }: { brand: string }) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-2 text-left text-sm font-semibold sm:min-h-8">
        Para recibir avisos en el iPhone, agrégalo a tu inicio
        <ChevronDown aria-hidden className="size-4 shrink-0" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Ábrelo en Safari.</li>
          <li>
            Toca Compartir <Share aria-label="(el cuadrado con la flecha)" className="inline size-3.5 align-text-bottom" /> y
            luego «Agregar a inicio».
          </li>
          <li>Abre {brand} desde el ícono, entra con tu cuenta y vuelve aquí para activar los avisos.</li>
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
