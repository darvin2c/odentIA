import { Alert, AlertDescription, AlertTitle, Button } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fromFacebook, readSessionEvent, type SessionEvent } from "./signup-events"

/**
 * «Conectar con Facebook» de WhatsApp (Embedded Signup de Meta, versión 4).
 *
 * La clínica entra con su Facebook en una ventana de Meta y vuelve con un
 * código; el servidor hace el resto. Este archivo solo abre la ventana, escucha
 * cómo terminó y lo dice con palabras.
 *
 * Documentación leída el 2026-10-13:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions
 *
 * NO SE HA PROBADO CONTRA META: la app de odentIA todavía no existe, así que la
 * ventana real nunca se abrió desde aquí. Por confirmar en la primera prueba:
 * que `extras: {}` basta (la guía de la versión 4 lo dice así; el ejemplo de la
 * guía de implementación pone `extras: { setup: {} }`), el orden en que llegan
 * el código y el aviso con el número, y el comportamiento con ventanas
 * emergentes bloqueadas.
 */

/** El SDK se pide a Meta solo cuando alguien pulsa el botón, nunca al abrir la página. */
const SDK_URL = "https://connect.facebook.net/en_US/sdk.js"
const SDK_SCRIPT_ID = "odentia-facebook-sdk"

/**
 * Un navegador solo deja abrir una ventana emergente poco después de un clic.
 * Si el SDK tardó más que esto en cargar, se pide un segundo clic en vez de
 * arriesgar una ventana bloqueada.
 */
const CLICK_STILL_VALID_MS = 4000
/** El código vive 30 segundos: no se espera más que esto al aviso que trae el número. */
const WAIT_FOR_NUMBER_MS = 8000
/** Si Meta respondió «sin permiso» casi al instante, lo más probable es que la ventana no se abriera. */
const POPUP_BLOCKED_MS = 1500

interface SignupConfig {
  enabled: boolean
  appId: string | null
  configId: string | null
  graphVersion: string | null
}

/** Un paso que el servidor no pudo completar en Meta después de guardar la conexión. */
export interface FacebookSignupPendingStep {
  step: string
  /** Qué falta y qué no funciona mientras tanto. */
  title: string
  /** Qué respondió Meta la última vez y qué hacer; `null` si aún no se intentó. */
  problem: string | null
}

/** La conexión tal como la devuelve el servidor al conectar, volver a conectar o reintentar. */
export interface FacebookSignupConnection {
  id: string
  channel: string
  provider: string
  displayName: string
  externalId: string | null
  status: string
  /** La cuenta que Meta reconoció. */
  account: { name: string | null; number: string | null } | null
  /** Cómo quedó la solicitud de los mensajes de la clínica. */
  templates: { canManage: boolean; requested: number; error: string | null } | null
  health: {
    quality: "alta" | "media" | "baja" | null
    dailyLimit: number | null
    unlimited: boolean
    number: string | null
    name: string | null
    checkedAt: string
  } | null
  /** Con algo en `pending`, la conexión necesita atención. */
  signup: {
    grantedAt: string
    subscribedAt: string | null
    registeredAt: string | null
    pending: FacebookSignupPendingStep[]
  } | null
  createdAt: string
  updatedAt: string
}

export interface FacebookSignupButtonProps {
  /** Se conectó, o se volvió a conectar: la conexión que devolvió el servidor. */
  onConnected: (connection: FacebookSignupConnection) => void
  /** Volver a conectar esta conexión (hecha con el botón) en vez de crear otra. */
  reconnectConnectionId?: string
}

/** Lo que el SDK de Meta expone y aquí se usa. */
interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: {
      config_id: string
      response_type: "code"
      override_default_response_type: true
      extras: Record<string, unknown>
    },
  ): void
}

type FacebookWindow = Window & { FB?: FacebookSdk; fbAsyncInit?: () => void }

let sdkLoading: Promise<FacebookSdk> | null = null

/** Carga el SDK una vez por página y lo inicia con la app de odentIA. */
function loadFacebookSdk(config: { appId: string; graphVersion: string }): Promise<FacebookSdk> {
  const host = window as FacebookWindow
  if (host.FB) return Promise.resolve(host.FB)
  sdkLoading ??= new Promise<FacebookSdk>((resolve, reject) => {
    const fail = () => {
      // Un intento fallido no deja el botón roto: el siguiente clic vuelve a pedirlo.
      sdkLoading = null
      document.getElementById(SDK_SCRIPT_ID)?.remove()
      reject(new Error("No se pudo cargar el SDK de Meta"))
    }
    host.fbAsyncInit = () => {
      const sdk = host.FB
      if (!sdk) return fail()
      sdk.init({ appId: config.appId, autoLogAppEvents: true, xfbml: true, version: config.graphVersion })
      resolve(sdk)
    }
    const script = document.createElement("script")
    script.id = SDK_SCRIPT_ID
    script.src = SDK_URL
    script.async = true
    script.defer = true
    script.crossOrigin = "anonymous"
    script.onerror = fail
    document.head.appendChild(script)
  })
  return sdkLoading
}

type Phase = "idle" | "loading" | "ready" | "window" | "saving"

type Outcome =
  | { kind: "connected"; connection: FacebookSignupConnection }
  | { kind: "problem"; title: string; text: string }

const NOTHING_CONNECTED = "No se conectó nada. Puedes volver a intentarlo."

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/** La cuenta que encontró Meta, con las palabras que entregue. */
function accountWords(connection: FacebookSignupConnection): string {
  const parts = [connection.account?.number ?? connection.health?.number, connection.account?.name ?? connection.health?.name]
  const said = parts.filter((part): part is string => Boolean(part?.trim()))
  return said.length > 0 ? said.join(" · ") : connection.displayName
}

/**
 * Lo que quedó pendiente de una conexión hecha con el botón, con «Reintentar».
 * Sirve tanto recién conectada como al abrirla después desde la lista.
 */
export function FacebookSignupPending({
  connection,
  onResolved,
}: {
  connection: Pick<FacebookSignupConnection, "id" | "signup">
  /** El reintento respondió: la conexión con lo que siga pendiente, si algo. */
  onResolved: (connection: FacebookSignupConnection) => void
}) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () =>
      apiFetch<{ data: FacebookSignupConnection }>(`/api/channels/whatsapp/signup/${connection.id}/retry`, { method: "POST" }),
    onSuccess: async ({ data }) => {
      await queryClient.invalidateQueries({ queryKey: ["connections"] })
      onResolved(data)
    },
  })
  const pending = connection.signup?.pending ?? []
  if (pending.length === 0) return null
  return (
    <Alert>
      <AlertTitle>{pending.length === 1 ? "Falta un paso para terminar de conectar" : "Faltan pasos para terminar de conectar"}</AlertTitle>
      <AlertDescription>
        <ul className="flex list-none flex-col gap-2 p-0">
          {pending.map((item) => (
            <li key={item.step} className="flex flex-col gap-0.5">
              <span className="text-foreground">{item.title}</span>
              {item.problem ? <span>{item.problem}</span> : null}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SubmitButton variant="outline" size="sm" pending={retry.isPending} onClick={() => retry.mutate()}>
            Reintentar
          </SubmitButton>
          {retry.isError ? (
            <span role="alert" className="text-sm text-destructive">
              {errorText(retry.error, "No pudimos reintentar. Vuelve a intentarlo en un momento.")}
            </span>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Botón «Conectar con Facebook». No se dibuja si la instalación no tiene la app
 * de odentIA configurada (`GET /api/channels/whatsapp/signup` → `enabled`).
 * Dice con palabras cada final: conectado, ventana cerrada sin terminar,
 * terminado sin número, error de Meta y permiso vencido.
 *
 * Al conectar entrega la conexión por `onConnected` y aquí solo dice con qué
 * cuenta quedó y, si el servidor dejó algún paso pendiente, cuál y cómo
 * reintentarlo. Lo demás (mensajes enviados a revisión, forma de pago) lo dice
 * la pantalla que lo usa, con esa misma respuesta.
 */
export function FacebookSignupButton({ onConnected, reconnectConnectionId }: FacebookSignupButtonProps) {
  const queryClient = useQueryClient()
  const config = useQuery({
    queryKey: ["whatsapp-signup"],
    queryFn: () => apiFetch<{ data: SignupConfig }>("/api/channels/whatsapp/signup"),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const [phase, setPhase] = useState<Phase>("idle")
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /** Un intento a la vez: lo que llegue de una ventana anterior se ignora. */
  const attempt = useRef(0)
  const session = useRef<{ code: string | null; event: SessionEvent | null; timer: ReturnType<typeof setTimeout> | null }>({
    code: null,
    event: null,
    timer: null,
  })
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected

  const save = useMutation({
    mutationFn: (input: { code: string; wabaId: string; phoneNumberId: string }) =>
      apiFetch<{ data: FacebookSignupConnection }>("/api/channels/whatsapp/signup", {
        method: "POST",
        body: JSON.stringify({ ...input, ...(reconnectConnectionId ? { reconnectConnectionId } : {}) }),
      }),
  })
  const saveRef = useRef(save.mutateAsync)
  saveRef.current = save.mutateAsync

  const stopWaiting = useCallback(() => {
    if (session.current.timer) clearTimeout(session.current.timer)
    session.current = { code: null, event: null, timer: null }
  }, [])

  const finish = useCallback(
    (next: Outcome) => {
      attempt.current += 1
      stopWaiting()
      setOutcome(next)
      setPhase("idle")
    },
    [stopWaiting],
  )

  /** Con el código y el número en la mano se envía de inmediato: el código vive 30 segundos. */
  const settle = useCallback(() => {
    const { code, event } = session.current
    if (event?.kind === "error") {
      return finish({
        kind: "problem",
        title: "Meta mostró un error",
        text: event.message
          ? `No se conectó nada. Meta dijo: «${event.message}». Corrígelo en la ventana de Meta y vuelve a intentarlo.`
          : "No se conectó nada. Vuelve a intentarlo en un momento.",
      })
    }
    if (event?.kind === "cancelled") {
      return finish({ kind: "problem", title: "Cerraste la ventana sin terminar", text: NOTHING_CONNECTED })
    }
    if (event?.kind === "no-number") {
      return finish({
        kind: "problem",
        title: "Terminaste sin elegir un número",
        text: "No se conectó nada. Vuelve a pulsar el botón y, en la ventana de Meta, agrega el número de WhatsApp de la clínica.",
      })
    }
    if (!code || event?.kind !== "finished") return
    const mine = attempt.current
    stopWaiting()
    setPhase("saving")
    saveRef
      .current({ code, wabaId: event.wabaId, phoneNumberId: event.phoneNumberId })
      .then(async ({ data }) => {
        await queryClient.invalidateQueries({ queryKey: ["connections"] })
        if (attempt.current !== mine) return
        finish({ kind: "connected", connection: data })
        onConnectedRef.current(data)
      })
      .catch((error: unknown) => {
        if (attempt.current !== mine) return
        const expired = error instanceof ApiError && error.shape.code === "SIGNUP_CODE_EXPIRED"
        finish({
          kind: "problem",
          title: expired ? "El permiso de Facebook venció" : "No se pudo conectar",
          text: errorText(
            error,
            expired
              ? "El permiso dura 30 segundos y se usa una sola vez. No se conectó nada: vuelve a pulsar «Conectar con Facebook»."
              : "No pudimos terminar de conectar. Vuelve a pulsar «Conectar con Facebook».",
          ),
        })
      })
  }, [finish, queryClient, stopWaiting])

  // Mientras la ventana de Meta está abierta se escucha lo que avisa; al cerrar el intento, no.
  useEffect(() => {
    if (phase !== "window") return
    const mine = attempt.current
    const onMessage = (event: MessageEvent) => {
      if (attempt.current !== mine || !fromFacebook(event.origin)) return
      const read = readSessionEvent(event.data)
      if (!read) return
      session.current.event = read
      settle()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [phase, settle])

  useEffect(
    () => () => {
      attempt.current += 1
      if (session.current.timer) clearTimeout(session.current.timer)
    },
    [],
  )

  const data = config.data?.data
  if (!data?.enabled || !data.appId || !data.configId || !data.graphVersion) return null
  const { appId, configId, graphVersion } = data

  function openWindow(sdk: FacebookSdk) {
    const mine = attempt.current
    const openedAt = Date.now()
    stopWaiting()
    setPhase("window")
    sdk.login(
      // El SDK exige una función normal, no una asíncrona.
      (response) => {
        if (attempt.current !== mine) return
        const code = response.authResponse?.code ?? null
        if (!code) {
          // Sin permiso: la persona cerró la ventana, o el navegador no la dejó abrir.
          if (session.current.event && session.current.event.kind !== "finished") return settle()
          const blocked = Date.now() - openedAt < POPUP_BLOCKED_MS
          return finish({
            kind: "problem",
            title: "Cerraste la ventana sin terminar",
            text: blocked
              ? `${NOTHING_CONNECTED} Si la ventana de Meta no llegó a abrirse, permite las ventanas emergentes de esta página.`
              : NOTHING_CONNECTED,
          })
        }
        session.current.code = code
        // El aviso con el número suele llegar antes; si no, se le espera poco: el código corre.
        session.current.timer = setTimeout(() => {
          if (attempt.current !== mine) return
          finish({
            kind: "problem",
            title: "Meta no dijo qué número elegiste",
            text: "No se conectó nada. Vuelve a pulsar «Conectar con Facebook» y termina la ventana de Meta hasta el final.",
          })
        }, WAIT_FOR_NUMBER_MS)
        settle()
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        // Versión 4: se elige al crear la configuración de «Facebook Login for Business»; aquí va vacío.
        extras: {},
      },
    )
  }

  function start() {
    setOutcome(null)
    const loaded = (window as FacebookWindow).FB
    // Ya cargado: la ventana se abre dentro del mismo clic, que es lo que el navegador permite sin reparos.
    if (loaded) return openWindow(loaded)
    attempt.current += 1
    const mine = attempt.current
    const clickedAt = Date.now()
    setPhase("loading")
    loadFacebookSdk({ appId, graphVersion })
      .then((sdk) => {
        if (attempt.current !== mine) return
        if (Date.now() - clickedAt > CLICK_STILL_VALID_MS) return setPhase("ready")
        openWindow(sdk)
      })
      .catch(() => {
        if (attempt.current !== mine) return
        finish({
          kind: "problem",
          title: "No pudimos abrir la ventana de Meta",
          text: "No se conectó nada. Revisa tu conexión, o si tu navegador bloquea facebook.com, y vuelve a intentarlo.",
        })
      })
  }

  const busy = phase === "loading" || phase === "window" || phase === "saving"
  const progress =
    phase === "loading"
      ? "Abriendo la ventana de Meta…"
      : phase === "ready"
        ? "La ventana de Meta está lista. Pulsa otra vez para abrirla."
        : phase === "window"
          ? "Sigue en la ventana de Meta. Esta página espera a que termines."
          : phase === "saving"
            ? "Terminando de conectar: guardamos la conexión y pedimos tus mensajes a WhatsApp…"
            : ""
  const label = reconnectConnectionId ? "Volver a conectar con Facebook" : "Conectar con Facebook"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={busy} onClick={start}>
          {label}
        </SubmitButton>
        {phase === "window" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => finish({ kind: "problem", title: "Cancelaste la conexión", text: NOTHING_CONNECTED })}
          >
            Cancelar
          </Button>
        ) : null}
      </div>
      {/* Siempre montado: un lector de pantalla anuncia cada cambio de paso. */}
      <p role="status" aria-live="polite" className={progress ? "text-sm text-muted-foreground" : "sr-only"}>
        {progress}
      </p>
      {outcome?.kind === "problem" ? (
        <Alert variant="destructive">
          <AlertTitle>{outcome.title}</AlertTitle>
          <AlertDescription>{outcome.text}</AlertDescription>
        </Alert>
      ) : null}
      {outcome?.kind === "connected" ? (
        <>
          <p role="status" className="text-sm font-medium text-success">
            {reconnectConnectionId ? "Conectado de nuevo" : "Conectado"}: {accountWords(outcome.connection)}.
          </p>
          <FacebookSignupPending
            connection={outcome.connection}
            onResolved={(connection) => {
              setOutcome({ kind: "connected", connection })
              onConnectedRef.current(connection)
            }}
          />
        </>
      ) : null}
    </div>
  )
}
