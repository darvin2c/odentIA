import { Button, Input, ScrollArea, Textarea } from "@odentia/ui"
import { createFileRoute } from "@tanstack/react-router"
import { createIsomorphicFn } from "@tanstack/react-start"
import { setResponseHeader } from "@tanstack/react-start/server"
import { CheckCircle2, SendHorizontal, X } from "lucide-react"
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { API_URL } from "../../lib/auth-client"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"

/**
 * El chat de la clínica dentro de su sitio (fase 6 del pulido de la Bandeja):
 * la ventana que abre `chat.js`. Se escribe sin dar el nombre (decisión 9), el
 * saludo es la primera burbuja y la conversación sigue 30 días en ese
 * navegador. Si Sofi pasa un tema al equipo, pide dónde avisarle (R4). Con
 * `?prueba=1` es la vista previa de Configuración: Sofi responde de verdad,
 * pero no se publica ni se cobra.
 */

/**
 * El navegador solo deja mostrar esta página dentro de los sitios que la
 * clínica permite (`frame-ancestors`); mientras no haya ninguno, en cualquiera,
 * para que el primero se registre. La vista previa vive en la propia clínica.
 */
const allowFrameAncestors = createIsomorphicFn()
  .server(async (slug: string | null) => {
    let policy = "'self'"
    if (slug) {
      try {
        const response = await fetch(`${API_URL}/api/webchat/${encodeURIComponent(slug)}/frame`)
        const body = (await response.json()) as { data?: { ancestors?: string[] | null } }
        const ancestors = body.data?.ancestors
        policy = ancestors === null ? "*" : ["'self'", ...(ancestors ?? [])].join(" ")
      } catch {
        // Sin respuesta de la API, solo la propia clínica: nunca se abre a cualquiera por un error.
      }
    }
    setResponseHeader("Content-Security-Policy", `frame-ancestors ${policy}`)
  })
  .client(async (_slug: string | null) => {})

export const Route = createFileRoute("/embed/")({
  validateSearch: (search: Record<string, unknown>): { site?: string; ticket?: string; prueba?: string } => ({
    ...(typeof search.site === "string" ? { site: search.site } : {}),
    // El sitio firmado por la API cuando cargó `chat.js`: lo pide abrir la sesión.
    ...(typeof search.ticket === "string" ? { ticket: search.ticket } : {}),
    ...(search.prueba === "1" || search.prueba === 1 ? { prueba: "1" } : {}),
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
      { title: "Chat" },
    ],
  }),
  loader: async () => {
    await allowFrameAncestors(orgSlugFromHostname(requestHostname()))
  },
  component: WebchatWindow,
})

interface Appearance {
  clinicName: string
  subtitle: string
  assistant: string
  color: string
  greeting: string
  active: boolean
}

interface ChatMessage {
  key: string
  from: "visitante" | "clinica"
  author: string | null
  text: string
  at: string
  /** Solo lo que escribió el visitante y aún no confirmó el servidor. */
  sending?: boolean
}

interface Poll {
  messages: ChatMessage[]
  typing: boolean
  askContact: boolean
  contact: { whatsapp: string | null; email: string | null } | null
}

class ChatError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  const body = (await response.json().catch(() => null)) as {
    data?: T
    error?: { message?: string }
  } | null
  if (!response.ok)
    throw new ChatError(body?.error?.message ?? "No pudimos conectar con el chat.", response.status)
  return body?.data as T
}

const storageKey = (slug: string) => `odentia-chat:${slug}`
function storedToken(slug: string): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(slug)) ?? "null") as {
      token?: unknown
    } | null
    return typeof raw?.token === "string" ? raw.token : null
  } catch {
    return null
  }
}
function storeToken(slug: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(storageKey(slug), JSON.stringify({ token }))
    else localStorage.removeItem(storageKey(slug))
  } catch {
    // Sin almacenamiento (navegación privada): la conversación dura lo que la pestaña.
  }
}

/** La prueba de Configuración trae su sesión en el fragmento: nunca viaja al servidor. */
function testSession(): string | null {
  if (typeof window === "undefined") return null
  return new URLSearchParams(window.location.hash.slice(1)).get("t")
}

const clock = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso))

function WebchatWindow() {
  const { site, ticket, prueba } = Route.useSearch()
  const test = prueba === "1"
  const slug = orgSlugFromHostname(requestHostname())
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [poll, setPoll] = useState<Poll>({
    messages: [],
    typing: false,
    askContact: false,
    contact: null,
  })
  const [pending, setPending] = useState<ChatMessage[]>([])
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!slug) {
      setLoadError("Este chat no está disponible.")
      return
    }
    setToken(test ? testSession() : storedToken(slug))
    call<Appearance>(`/api/webchat/${slug}/config`)
      .then(setAppearance)
      .catch(() => setLoadError("No pudimos cargar el chat. Vuelve a intentarlo en un momento."))
  }, [slug, test])

  const refresh = useCallback(async () => {
    if (!slug || !token) return
    try {
      const data = await call<Poll>(`/api/webchat/${slug}/messages`, {}, token)
      setPoll(data)
      setPending((items) => items.filter((item) => !data.messages.some((m) => m.key === item.key)))
    } catch (cause) {
      // Una sesión que ya no vale empieza de nuevo al escribir.
      if (cause instanceof ChatError && cause.status === 401 && !test) {
        storeToken(slug, null)
        setToken(null)
      }
    }
  }, [slug, token, test])

  useEffect(() => {
    if (!token) return
    void refresh()
    const timer = window.setInterval(
      () => void refresh(),
      document.visibilityState === "visible" ? 2500 : 6000,
    )
    return () => window.clearInterval(timer)
  }, [token, refresh])

  const shown = [...poll.messages, ...pending]
  // biome-ignore lint/correctness/useExhaustiveDependencies: baja al final cuando llega algo nuevo.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [shown.length, poll.typing, poll.askContact])

  /** Cerrar con su botón o Esc: lo hace `chat.js`, que la abrió. */
  const close = useCallback(
    () => window.parent?.postMessage({ type: "odentia-chat:close" }, "*"),
    [],
  )
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])

  async function send(event?: FormEvent) {
    event?.preventDefault()
    const message = text.trim()
    if (!message || !slug) return
    const key = crypto.randomUUID().replace(/-/g, "")
    setPending((items) => [
      ...items,
      {
        key,
        from: "visitante",
        author: null,
        text: message,
        at: new Date().toISOString(),
        sending: true,
      },
    ])
    setText("")
    setError(null)
    try {
      let session = token
      if (!session) {
        // La sesión nace con el primer mensaje: mirar el sitio no crea conversaciones.
        const opened = await call<{ token: string }>(`/api/webchat/${slug}/session`, {
          method: "POST",
          body: JSON.stringify({ site: site ?? "", ticket: ticket ?? "" }),
        })
        session = opened.token
        storeToken(slug, session)
        setToken(session)
      }
      await call(
        `/api/webchat/${slug}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ clientMessageId: key, text: message.slice(0, 2000) }),
        },
        session,
      )
      setPending((items) =>
        items.map((item) => (item.key === key ? { ...item, sending: false } : item)),
      )
      void refresh()
    } catch (cause) {
      setPending((items) => items.filter((item) => item.key !== key))
      setText(message)
      setError(
        cause instanceof ChatError && cause.status !== 500
          ? cause.message
          : "No se pudo enviar. Revisa tu conexión y vuelve a intentarlo.",
      )
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const accent = appearance?.color ?? "#0f766e"
  if (loadError || (appearance && !appearance.active && !test)) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background p-6 text-center">
        <p className="font-semibold">No disponible</p>
        <p className="text-sm text-muted-foreground">
          {loadError ?? "Este chat no está disponible por ahora."}
        </p>
      </div>
    )
  }
  const lastMine = [...shown].reverse().find((item) => item.from === "visitante")
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header
        className="flex items-center gap-3 px-4 py-3 text-white"
        style={{ backgroundColor: accent }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{appearance?.clinicName ?? "Chat"}</p>
          <p className="truncate text-sm opacity-90">{appearance?.subtitle ?? ""}</p>
        </div>
        {test ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15 hover:text-white"
            aria-label="Cerrar el chat"
            onClick={close}
          >
            <X className="size-5" />
          </Button>
        )}
      </header>
      {test ? (
        <p className="bg-warning-soft px-4 py-1.5 text-center text-xs font-semibold">
          Prueba · no se publica ni se cobra
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col gap-2 p-3" aria-live="polite" aria-label="Conversación">
          {appearance ? (
            <Bubble
              message={{
                key: "saludo",
                from: "clinica",
                author: appearance.assistant,
                text: appearance.greeting,
                at: "",
              }}
              showAuthor
              accent={accent}
            />
          ) : null}
          {shown.map((message, index) => (
            <Bubble
              key={message.key}
              message={message}
              accent={accent}
              showAuthor={
                message.from === "clinica" &&
                (index === 0
                  ? true
                  : shown[index - 1]?.author !== message.author ||
                    shown[index - 1]?.from !== "clinica")
              }
              state={message === lastMine ? (message.sending ? "Enviando…" : "Enviado") : null}
            />
          ))}
          {poll.typing ? (
            <li className="self-start text-sm text-muted-foreground" aria-live="polite">
              {appearance?.assistant ?? "La clínica"} está escribiendo…
            </li>
          ) : null}
          {poll.askContact && !poll.contact ? (
            <ContactCard
              slug={slug ?? ""}
              token={token}
              accent={accent}
              onSaved={(contact) =>
                setPoll((current) => ({ ...current, contact, askContact: false }))
              }
            />
          ) : null}
          {poll.contact ? (
            <li className="flex items-center gap-1.5 self-center text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-success" aria-hidden />
              Te avisamos{" "}
              {poll.contact.whatsapp
                ? `por WhatsApp ${poll.contact.whatsapp}`
                : `por correo ${poll.contact.email ?? ""}`}
            </li>
          ) : null}
          <div ref={bottom} />
        </ol>
      </ScrollArea>
      <form className="flex flex-col gap-1 border-t p-2" onSubmit={send}>
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Tu mensaje"
            rows={1}
            value={text}
            maxLength={2000}
            placeholder="Escribe tu mensaje…"
            className="max-h-32 min-h-11 resize-none text-base"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <Button
            type="submit"
            size="icon"
            className="size-11 shrink-0 text-white"
            style={{ backgroundColor: accent }}
            aria-label="Enviar"
            disabled={!text.trim()}
          >
            <SendHorizontal className="size-5" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="px-1 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  )
}

function Bubble({
  message,
  accent,
  showAuthor,
  state = null,
}: {
  message: ChatMessage
  accent: string
  showAuthor: boolean
  state?: string | null
}) {
  const mine = message.from === "visitante"
  return (
    <li
      className={`flex max-w-[85%] flex-col gap-0.5 ${mine ? "self-end items-end" : "self-start items-start"}`}
    >
      {showAuthor && message.author ? (
        <span className="px-1 text-xs font-semibold text-muted-foreground">{message.author}</span>
      ) : null}
      <p
        className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] ${mine ? "text-white" : "bg-muted"}`}
        style={mine ? { backgroundColor: accent } : undefined}
      >
        {message.text}
      </p>
      {message.at ? (
        <span className="px-1 text-xs text-muted-foreground">
          <time dateTime={message.at}>{clock(message.at)}</time>
          {state ? ` · ${state}` : ""}
        </span>
      ) : null}
    </li>
  )
}

/**
 * «¿Dónde te avisamos?» (R4, decisión 10): su WhatsApp o su correo, solo
 * para responderle. Sin ninguno, el equipo ve «Sin forma de avisarle».
 */
function ContactCard({
  slug,
  token,
  accent,
  onSaved,
}: {
  slug: string
  token: string | null
  accent: string
  onSaved: (contact: Poll["contact"]) => void
}) {
  const [whatsapp, setWhatsapp] = useState("")
  const [email, setEmail] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!whatsapp.trim() && !email.trim()) {
      setError("Escribe tu WhatsApp o tu correo.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await call<{ contact: Poll["contact"] }>(
        `/api/webchat/${slug}/contact`,
        {
          method: "POST",
          body: JSON.stringify({ whatsapp: whatsapp.trim() || null, email: email.trim() || null }),
        },
        token,
      )
      onSaved(saved.contact)
    } catch (cause) {
      setError(
        cause instanceof ChatError ? cause.message : "No se pudo guardar. Vuelve a intentarlo.",
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <li className="self-stretch">
      <form
        className="flex flex-col gap-2 rounded-2xl border bg-card p-3"
        onSubmit={save}
        aria-label="Dónde te avisamos"
      >
        <p className="text-sm font-semibold">¿Dónde te avisamos cuando te respondan?</p>
        <Input
          aria-label="Tu WhatsApp"
          inputMode="tel"
          autoComplete="tel"
          placeholder="Tu WhatsApp"
          className="text-base"
          value={whatsapp}
          onChange={(event) => setWhatsapp(event.target.value)}
        />
        <Input
          aria-label="O tu correo"
          type="email"
          autoComplete="email"
          placeholder="o tu correo"
          className="text-base"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          className="text-white"
          style={{ backgroundColor: accent }}
          disabled={saving}
        >
          {saving ? "Guardando…" : "Avisarme ahí"}
        </Button>
        <p className="text-xs text-muted-foreground">Solo lo usamos para responderte.</p>
      </form>
    </li>
  )
}
