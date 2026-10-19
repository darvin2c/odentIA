import { Alert, AlertDescription, AlertTitle, Button } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fromFacebook, readSessionEvent, type SessionEvent } from "../../lib/whatsapp-signup-events"

/**
 * «Conectar con Facebook» de WhatsApp (Embedded Signup de Meta, versión 4).
 *
 * La ventana de Meta se abre siempre desde el panel (`app.<dominio>`), nunca
 * desde el subdominio de cada clínica: Meta solo devuelve el resultado a una
 * página cuyo dominio está en «Dominios permitidos para el SDK para
 * JavaScript», y esa lista no admite comodín (issue 166). La clínica llega
 * aquí por `/whatsapp/conectar?org=<slug>`; la organización la resuelve la API
 * con la membresía de quien conecta (`x-odentia-org`), nunca esta página.
 *
 * Este archivo solo abre la ventana, escucha cómo terminó, envía el código a
 * la misma operación de siempre (`POST /api/channels/whatsapp/signup`) y lo
 * dice con palabras.
 *
 * Documentación leída el 2026-10-13:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions
 *
 * NO SE HA PROBADO CONTRA META: la ventana real nunca se abrió desde aquí. Por
 * confirmar en la primera prueba: que `extras: {}` basta (la guía de la
 * versión 4 lo dice así; el ejemplo de la guía de implementación pone
 * `extras: { setup: {} }`), el orden en que llegan el código y el aviso con el
 * número, y el comportamiento con ventanas emergentes bloqueadas.
 */

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

export interface FacebookSignupConfig {
  appId: string
  configId: string
  graphVersion: string
}

/** Lo que esta página usa de la conexión que devuelve el servidor; lo demás lo muestra la clínica. */
export interface FacebookSignupConnection {
  id: string
  displayName: string
  account: { name: string | null; number: string | null } | null
  health: { number: string | null; name: string | null } | null
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
      sdk.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: config.graphVersion,
      })
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

type Phase = "idle" | "loading" | "ready" | "window" | "saving" | "done"

interface Problem {
  title: string
  text: string
}

const NOTHING_CONNECTED = "No se conectó nada. Puedes volver a intentarlo."

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/** La cuenta que encontró Meta, con las palabras que entregue. */
export function accountWords(connection: FacebookSignupConnection): string {
  const parts = [
    connection.account?.number ?? connection.health?.number,
    connection.account?.name ?? connection.health?.name,
  ]
  const said = parts.filter((part): part is string => Boolean(part?.trim()))
  return said.length > 0 ? said.join(" · ") : connection.displayName
}

export interface FacebookSignupProps {
  /** La clínica, tal como la pide la API en `x-odentia-org`; la API comprueba la membresía. */
  slug: string
  config: FacebookSignupConfig
  /** Volver a conectar esta conexión (hecha con el botón) en vez de crear otra. */
  reconnectConnectionId?: string
  /** Se conectó: la conexión que devolvió el servidor. La página vuelve a la clínica. */
  onConnected: (connection: FacebookSignupConnection) => void
}

/**
 * El botón que abre la ventana de Meta. El SDK se pide al abrir la página
 * (quien llega aquí ya pulsó «Conectar con Facebook» en su clínica), para que
 * el clic de esta página abra la ventana al instante. Dice con palabras cada
 * final: ventana cerrada sin terminar, terminado sin número, error de Meta y
 * permiso vencido. Al conectar, quien lo usa vuelve a la clínica.
 */
export function FacebookSignup({
  slug,
  config,
  reconnectConnectionId,
  onConnected,
}: FacebookSignupProps) {
  const { appId, configId, graphVersion } = config
  const [phase, setPhase] = useState<Phase>("idle")
  const [problem, setProblem] = useState<Problem | null>(null)
  /** Un intento a la vez: lo que llegue de una ventana anterior se ignora. */
  const attempt = useRef(0)
  const session = useRef<{
    code: string | null
    event: SessionEvent | null
    timer: ReturnType<typeof setTimeout> | null
  }>({
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
        headers: { "x-odentia-org": slug },
        body: JSON.stringify({
          ...input,
          ...(reconnectConnectionId ? { reconnectConnectionId } : {}),
        }),
      }),
  })
  const saveRef = useRef(save.mutateAsync)
  saveRef.current = save.mutateAsync

  // Se pide a Meta al abrir la página; si falla, el clic lo vuelve a pedir y dice por qué.
  useEffect(() => {
    loadFacebookSdk({ appId, graphVersion }).catch(() => {})
  }, [appId, graphVersion])

  const stopWaiting = useCallback(() => {
    if (session.current.timer) clearTimeout(session.current.timer)
    session.current = { code: null, event: null, timer: null }
  }, [])

  const fail = useCallback(
    (next: Problem) => {
      attempt.current += 1
      stopWaiting()
      setProblem(next)
      setPhase("idle")
    },
    [stopWaiting],
  )

  /** Con el código y el número en la mano se envía de inmediato: el código vive 30 segundos. */
  const settle = useCallback(() => {
    const { code, event } = session.current
    if (event?.kind === "error") {
      return fail({
        title: "Meta mostró un error",
        text: event.message
          ? `No se conectó nada. Meta dijo: «${event.message}». Corrígelo en la ventana de Meta y vuelve a intentarlo.`
          : "No se conectó nada. Vuelve a intentarlo en un momento.",
      })
    }
    if (event?.kind === "cancelled") {
      return fail({ title: "Cerraste la ventana sin terminar", text: NOTHING_CONNECTED })
    }
    if (event?.kind === "no-number") {
      return fail({
        title: "Terminaste sin elegir un número",
        text: "No se conectó nada. Vuelve a intentarlo y, en la ventana de Meta, agrega el número de WhatsApp de la clínica.",
      })
    }
    if (!code || event?.kind !== "finished") return
    const mine = attempt.current
    stopWaiting()
    setPhase("saving")
    saveRef
      .current({ code, wabaId: event.wabaId, phoneNumberId: event.phoneNumberId })
      .then(({ data }) => {
        if (attempt.current !== mine) return
        attempt.current += 1
        setPhase("done")
        onConnectedRef.current(data)
      })
      .catch((error: unknown) => {
        if (attempt.current !== mine) return
        const expired = error instanceof ApiError && error.shape.code === "SIGNUP_CODE_EXPIRED"
        fail({
          title: expired ? "El permiso de Facebook venció" : "No se pudo conectar",
          text: errorText(
            error,
            expired
              ? "El permiso dura 30 segundos y se usa una sola vez. No se conectó nada: vuelve a intentarlo."
              : "No pudimos terminar de conectar. Vuelve a intentarlo.",
          ),
        })
      })
  }, [fail, stopWaiting])

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
          return fail({
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
          fail({
            title: "Meta no dijo qué número elegiste",
            text: "No se conectó nada. Vuelve a intentarlo y termina la ventana de Meta hasta el final.",
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
    setProblem(null)
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
        fail({
          title: "No pudimos abrir la ventana de Meta",
          text: "No se conectó nada. Revisa tu conexión, o si tu navegador bloquea facebook.com, y vuelve a intentarlo.",
        })
      })
  }

  const busy = phase === "loading" || phase === "window" || phase === "saving" || phase === "done"
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={busy} onClick={start} className="min-h-11 sm:min-h-9">
          {problem ? "Volver a intentar" : "Abrir la ventana de Meta"}
        </SubmitButton>
        {phase === "window" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fail({ title: "Cancelaste la conexión", text: NOTHING_CONNECTED })}
          >
            Cancelar
          </Button>
        ) : null}
      </div>
      {/* Siempre montado: un lector de pantalla anuncia cada cambio de paso. */}
      <p
        role="status"
        aria-live="polite"
        className={progress ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {progress}
      </p>
      {problem ? (
        <Alert variant="destructive">
          <AlertTitle>{problem.title}</AlertTitle>
          <AlertDescription>{problem.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
