import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ChevronDown, Share } from "lucide-react"
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react"
import { useReceptionName } from "../lib/agent-names"
import { appWords } from "../lib/product-words"
import {
  canOfferInstall,
  devicePushActive,
  devicePushAvailable,
  disableDevicePush,
  enableDevicePush,
  isAppleMobile,
  isInstalled,
  notificationPermission,
  offerInstall,
  PushBlockedError,
  pushSupport,
  subscribeInstall,
  subscribePermission,
} from "../lib/pwa"

/** Lo que llega, dicho una vez junto al interruptor. Sin nombres: se ve con el teléfono bloqueado. */
const whatArrives = (agent: string) =>
  `Te avisa aunque no tengas la clínica abierta: cuando alguien te escribe o ${agent} te pasa a alguien (en el horario de atención), y si WhatsApp o ${agent} dejan de funcionar. El aviso no dice el nombre de la persona. No lo actives en la tablet que le pasas al paciente.`

type State = "cargando" | "apagado" | "activado" | "bloqueado" | "no-compatible" | "instalar-en-iphone" | "no-disponible"

/**
 * «Recibir avisos en este equipo», arriba de «Avisos» (ADR 0177). Es de este
 * equipo y de esta clínica: quien trabaja en dos clínicas los activa en cada una.
 * El navegador pide el permiso solo después del toque. Debajo, instalar la app
 * cuando el navegador lo ofrece, o cómo hacerlo en iPhone.
 */
export function DeviceNotices() {
  const brand = appWords().name
  const agent = useReceptionName()
  const [state, setState] = useState<State>("cargando")
  const [busy, setBusy] = useState<"activando" | "apagando" | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const helpId = useId()
  const installable = useSyncExternalStore(subscribeInstall, canOfferInstall, () => false)

  const read = useCallback(async () => {
    const support = pushSupport()
    if (support !== "listo") return setState(support)
    // Sin claves en el servidor no se pide el permiso del navegador para nada.
    if (!(await devicePushAvailable())) return setState("no-disponible")
    if (notificationPermission() === "denied") return setState("bloqueado")
    setState((await devicePushActive()) ? "activado" : "apagado")
  }, [])

  useEffect(() => {
    let alive = true
    const load = () =>
      read().catch(() => {
        if (!alive) return
        setState("apagado")
        setProblem("No pudimos revisar si este equipo recibe tus avisos. Revisa la conexión y abre otra vez los avisos.")
      })
    void load()
    // Si la persona los permite en el navegador con la campana abierta, el interruptor se suelta solo.
    const stop = subscribePermission(() => void load())
    return () => {
      alive = false
      stop()
    }
  }, [read])

  const toggle = async (on: boolean) => {
    setBusy(on ? "activando" : "apagando")
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
    } catch (error) {
      setProblem(
        error instanceof PushBlockedError
          ? "Este navegador no deja recibir avisos aquí (pasa en una ventana privada o de invitado). Ábrelo en una ventana normal y vuelve a intentar."
          : on
            ? "No pudimos activar los avisos. Revisa la conexión y vuelve a intentar."
            : "No pudimos apagar los avisos. Vuelve a intentar.",
      )
    } finally {
      setBusy(null)
    }
  }

  const switchable = state === "apagado" || state === "activado"

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
            <p id={helpId} className="text-xs text-muted-foreground" aria-live="polite">
              {busy === "activando"
                ? "Activando… el navegador puede tardar unos segundos."
                : state === "activado"
                  ? `Activado en este equipo. ${whatArrives(agent)}`
                  : state === "bloqueado"
                    ? isAppleMobile()
                      ? `El equipo los tiene bloqueados. Ábrelos en Ajustes › Notificaciones › ${brand}.`
                      : "El navegador los tiene bloqueados. Toca el ícono a la izquierda de la dirección › Notificaciones › Permitir."
                    : state === "no-compatible"
                      ? "Este navegador no puede recibir avisos. Usa Chrome, Edge o Safari actualizados."
                      : state === "no-disponible"
                        ? `Los avisos en el equipo todavía no están disponibles en ${brand}.`
                        : whatArrives(agent)}
            </p>
          </div>
          {state === "no-compatible" || state === "no-disponible" ? null : (
            <Switch
              id={`${helpId}-switch`}
              aria-describedby={helpId}
              className="mt-1"
              checked={state === "activado" || busy === "activando"}
              disabled={!switchable || busy !== null}
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
