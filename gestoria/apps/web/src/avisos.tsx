import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  canOfferInstall,
  isAppleMobile,
  isInstalled,
  notificationPermission,
  offerInstall,
  PushBlockedError,
  pushSupport,
  subscribeInstall,
  subscribePermission,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BellRing, Share } from "lucide-react"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { ApiError, api } from "./lib/api"
import { device, dismissInstallCard, installCardDismissed, type PushChoices } from "./lib/avisos"
import { FormAlert } from "./piezas"
import { ErrorBlock, StoreHeader, useStoreContext } from "./tiendas"

/**
 * Los avisos al celular (lienzo «gestorIA como odentIA», tablero 15): gestorIA se instala desde el
 * navegador y avisa con la app cerrada. Aquí, cómo está este celular y qué le llega a cada
 * persona; la tarjeta para instalar y activar va en la pantalla de entrada (`InstallCard`).
 */

/** Cómo está este celular. */
type DeviceState =
  | "cargando"
  | "apagado"
  | "activado"
  | "bloqueado"
  | "no-compatible"
  | "instalar-en-iphone"
  | "no-disponible"
  | "sin-revisar"

/** Cómo está este celular y lo que se puede hacer con él. Lo comparten la tarjeta y Configuración. */
function useThisDevice() {
  const [state, setState] = useState<DeviceState>("cargando")
  const [busy, setBusy] = useState<"activando" | "apagando" | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const read = useCallback(async () => {
    const support = pushSupport()
    if (support !== "listo") return setState(support)
    // Sin claves en el servidor no se pide el permiso del navegador para nada.
    if (!(await device.available())) return setState("no-disponible")
    if (notificationPermission() === "denied") return setState("bloqueado")
    setState((await device.active()) ? "activado" : "apagado")
  }, [])

  useEffect(() => {
    let alive = true
    const load = () =>
      read()
        .then(() => alive && setProblem(null))
        .catch(() => {
          if (!alive) return
          // Sin saber cómo está, no se dice «apagado»: se revisa otra vez al volver la red.
          setState("sin-revisar")
          setProblem(
            "No pudimos revisar si este celular recibe tus avisos. Lo revisamos otra vez cuando vuelva la conexión.",
          )
        })
    void load()
    // Si la persona los permite en el navegador con la página abierta, se revisa solo.
    const stop = subscribePermission(() => void load())
    const back = () => void load()
    window.addEventListener("online", back)
    return () => {
      alive = false
      stop()
      window.removeEventListener("online", back)
    }
  }, [read])

  const turn = async (on: boolean) => {
    setBusy(on ? "activando" : "apagando")
    setProblem(null)
    try {
      if (!on) {
        await device.disable()
        setState("apagado")
        return
      }
      const result = await device.enable()
      if (result === "granted") setState("activado")
      else if (result === "denied") setState("bloqueado")
      else if (result === "no-disponible") setState("no-disponible")
      // `default`: cerró la pregunta sin decidir; queda apagado y puede volver a intentar.
    } catch (error) {
      setProblem(
        error instanceof PushBlockedError
          ? "El navegador no dejó activar los avisos aquí. Pasa en una ventana privada o de invitado: ábrelo en una ventana normal y vuelve a intentar."
          : error instanceof ApiError && error.status === 409
            ? error.message
            : on
              ? "No pudimos activar los avisos. Revisa la conexión y vuelve a intentar."
              : "No pudimos apagar los avisos. Vuelve a intentar.",
      )
    } finally {
      setBusy(null)
    }
  }
  return { state, busy, problem, turn }
}

/** Cómo se desbloquean, según el celular. */
function unblockText(): string {
  return isAppleMobile()
    ? "Este celular los tiene bloqueados. Ábrelos en Ajustes › Notificaciones › gestorIA."
    : "El navegador los tiene bloqueados. Toca el ícono a la izquierda de la dirección › Notificaciones › Permitir."
}

/** En iPhone y iPad los avisos llegan solo a gestorIA agregada a la pantalla de inicio. */
function IphoneSteps() {
  return (
    <p className="text-sm text-muted-foreground">
      Agrega gestorIA a tu pantalla de inicio: en Safari, toca Compartir{" "}
      <Share aria-label="(el cuadrado con la flecha)" className="inline size-4 align-text-bottom" />{" "}
      y luego Agregar a inicio. Ábrela desde ese ícono y activa los avisos.
    </p>
  )
}

/* ---------------------------------------------------------------- la tarjeta */

/**
 * La tarjeta para instalar gestorIA y activar los avisos en este celular (tablero 15). Va en la
 * pantalla de entrada de la tienda; se ve mientras este celular no los recibe y nadie dijo «Ahora
 * no» en él (vuelve a ofrecerse a la semana). Después de instalar, la misma tarjeta pide el último
 * paso. En iPhone dice antes que hay que agregarla a la pantalla de inicio.
 */
export function InstallCard() {
  const { store } = useStoreContext()
  const { state, busy, problem, turn } = useThisDevice()
  const installable = useSyncExternalStore(subscribeInstall, canOfferInstall, () => false)
  const [later, setLater] = useState(installCardDismissed)
  const [installing, setInstalling] = useState(false)

  if (!store.permissions.includes("avisos.recibir") || later) return null
  if (!["apagado", "instalar-en-iphone", "sin-revisar"].includes(state) && !problem) return null

  const offerApp = installable && !isInstalled()
  const lastStep = isInstalled() && state === "apagado"
  const notNow = () => {
    dismissInstallCard()
    setLater(true)
  }
  return (
    <section
      aria-labelledby="tarjeta-avisos"
      className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-start"
    >
      <BellRing aria-hidden className="size-5 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h2 id="tarjeta-avisos" className="text-sm font-semibold">
          {lastStep ? "Último paso: activa los avisos" : "Recibe los avisos en este celular"}
        </h2>
        {state === "instalar-en-iphone" ? (
          <IphoneSteps />
        ) : (
          <p className="text-sm text-muted-foreground">
            {offerApp
              ? "Instala gestorIA: queda con su ícono, como una app, y te avisa aunque esté cerrada. No cuesta nada."
              : "Te avisa aunque gestorIA esté cerrada: los pagos por confirmar, lo que no se entregó y lo que te toca. No cuesta nada."}
          </p>
        )}
        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {state === "instalar-en-iphone" ? null : offerApp ? (
            <Button
              type="button"
              disabled={installing}
              onClick={async () => {
                setInstalling(true)
                try {
                  await offerInstall()
                } finally {
                  setInstalling(false)
                }
              }}
            >
              Instalar gestorIA
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy !== null || state === "sin-revisar"}
              onClick={() => void turn(true)}
            >
              {busy === "activando" ? "Activando…" : "Activar los avisos"}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={notNow}>
            Ahora no
          </Button>
        </div>
      </div>
    </section>
  )
}

/* ---------------------------------------------- Configuración › Avisos al celular */

const CHOICES_KEY = (storeId: string) => ["avisos", storeId] as const

/**
 * Configuración › Avisos al celular (tablero 15): cómo está este celular, con «Apagar en este
 * celular», y qué le llega a la persona, entre lo que su rol puede resolver. Lo que elige vale en
 * todos sus celulares; cada celular se activa una vez. Cada interruptor guarda al momento.
 */
export function DeviceNoticesPage() {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const thisDevice = useThisDevice()
  const choices = useQuery({
    queryKey: CHOICES_KEY(store.id),
    queryFn: () => api<PushChoices>(`/api/tiendas/${store.id}/avisos`),
  })
  const save = useMutation({
    mutationFn: (kinds: string[]) =>
      api<PushChoices>(`/api/tiendas/${store.id}/avisos`, { method: "PATCH", body: { kinds } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(CHOICES_KEY(store.id), saved)
      toast.success("Guardado: vale en todos tus celulares")
    },
  })
  // El celular recién activado o apagado cambia cuántos los reciben.
  useEffect(() => {
    if (thisDevice.state === "activado" || thisDevice.state === "apagado")
      void queryClient.invalidateQueries({ queryKey: CHOICES_KEY(store.id) })
  }, [thisDevice.state, queryClient, store.id])

  const kinds = choices.data?.kinds ?? []
  const shown = (kind: string, on: boolean) =>
    save.isPending && save.variables ? save.variables.includes(kind) : on
  const toggle = (kind: string, on: boolean) => {
    const next = kinds
      .filter((one) => (one.kind === kind ? on : shown(one.kind, one.on)))
      .map((one) => one.kind)
    save.mutate(next)
  }
  const { state, busy, problem, turn } = thisDevice

  return (
    <>
      <StoreHeader title="Avisos al celular" />
      <section
        aria-labelledby="este-celular"
        className="elevated flex max-w-xl flex-col gap-3 rounded-xl border bg-card p-5"
      >
        <h2 id="este-celular" className="text-sm font-semibold">
          {state === "activado"
            ? "Activados en este celular"
            : state === "cargando"
              ? "Revisando este celular…"
              : "Apagados en este celular"}
        </h2>
        <div aria-live="polite" className="flex flex-col gap-2 text-sm text-muted-foreground">
          {state === "instalar-en-iphone" ? <IphoneSteps /> : null}
          {state === "bloqueado" ? <p>{unblockText()}</p> : null}
          {state === "no-compatible" ? (
            <p>Este navegador no puede recibir avisos. Usa Chrome, Edge o Safari actualizados.</p>
          ) : null}
          {state === "no-disponible" ? (
            <p>Los avisos al celular todavía no están disponibles en gestorIA.</p>
          ) : null}
          {state === "apagado" ? (
            <p>
              Actívalos para enterarte aunque gestorIA esté cerrada. Se activa una vez en cada
              celular.
            </p>
          ) : null}
          {busy === "activando" ? <p>Activando… el navegador puede tardar unos segundos.</p> : null}
        </div>
        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}
        {state === "activado" ? (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={busy !== null}
            onClick={() => void turn(false)}
          >
            {busy === "apagando" ? "Apagando…" : "Apagar en este celular"}
          </Button>
        ) : state === "apagado" || state === "sin-revisar" ? (
          <Button
            type="button"
            className="self-start"
            disabled={busy !== null || state === "sin-revisar"}
            onClick={() => void turn(true)}
          >
            Activar en este celular
          </Button>
        ) : null}
      </section>

      {choices.isError ? (
        <ErrorBlock error={choices.error} onRetry={() => void choices.refetch()} />
      ) : (
        <section className="elevated max-w-xl rounded-xl border bg-card p-5">
          <FieldSet>
            <FieldLegend>Qué te llega</FieldLegend>
            <FieldDescription>
              Solo ves los avisos que tu rol puede resolver. Lo que elijas vale en todos tus
              celulares; cada celular se activa una vez.
            </FieldDescription>
            {choices.isPending ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : (
              <FieldGroup className="gap-4">
                {kinds.map((one) => (
                  <Field key={one.kind} orientation="horizontal">
                    <Switch
                      id={`aviso-${one.kind}`}
                      checked={shown(one.kind, one.on)}
                      disabled={save.isPending}
                      onCheckedChange={(on) => toggle(one.kind, on)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`aviso-${one.kind}`}>{one.label}</FieldLabel>
                      <FieldDescription>{one.hint}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </FieldGroup>
            )}
            <FormAlert error={save.error} />
            {!store.permissions.includes("reportes.ver") ? (
              <p className="text-sm text-muted-foreground">
                El Dueño y el Administrador reciben además «Lo de dinero».
              </p>
            ) : null}
          </FieldSet>
        </section>
      )}
    </>
  )
}
