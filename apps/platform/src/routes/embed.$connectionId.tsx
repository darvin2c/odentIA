import { Message, MessageContent } from "@odentia/ui/components/ai-elements/message"
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@odentia/ui/components/ai-elements/prompt-input"
import { createFileRoute } from "@tanstack/react-router"
import { MessageCircle } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { API_URL } from "../lib/auth-client"
import { orgSlugFromHostname, requestHostname } from "../lib/host"

export const Route = createFileRoute("/embed/$connectionId")({
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: WebchatWidget,
})

interface WidgetConfig {
  orgName: string
  title: string
  color: string
  greeting: string | null
}

interface WidgetMessage {
  id: string
  direction: string
  senderKind: string
  contentType: string
  body: string | null
  status: string
  createdAt: string
}

interface PollData {
  status: "open" | "closed" | null
  items: WidgetMessage[]
  nextCursor: string | null
}

async function api<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let detail = `Error ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) detail = body.error.message
    } catch {
      // cuerpo no JSON
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

function WebchatWidget() {
  const { connectionId } = Route.useParams()
  const slug = orgSlugFromHostname(requestHostname())
  const [config, setConfig] = useState<WidgetConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [started, setStarted] = useState(false)
  const [session, setSession] = useState<{ token: string; expiresAt: number } | null>(null)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [closed, setClosed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<{ token: string } | null>(null)
  sessionRef.current = session

  useEffect(() => {
    if (!slug) {
      setConfigError("Enlace de chat inválido")
      return
    }
    let cancelled = false
    api<{ data: WidgetConfig }>(`/api/webchat/${slug}/${connectionId}/config`)
      .then((result) => {
        if (!cancelled) setConfig(result.data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : "No pudimos cargar el chat")
      })
    return () => {
      cancelled = true
    }
  }, [slug, connectionId])

  const mergeMessages = useCallback((items: WidgetMessage[]) => {
    setMessages((previous) => {
      const known = new Set(previous.map((m) => m.id))
      const next = [...previous]
      for (const item of items) {
        if (!known.has(item.id)) {
          known.add(item.id)
          next.push(item)
        }
      }
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return next.slice(-200)
    })
  }, [])

  const start = useCallback(async () => {
    if (!slug || starting) return
    setStarting(true)
    setError(null)
    try {
      const result = await api<{ data: { token: string; expiresAt: number } }>(
        `/api/webchat/${slug}/${connectionId}/session`,
        { method: "POST", body: JSON.stringify({}) },
      )
      setSession(result.data)
      setStarted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pudimos iniciar el chat")
    } finally {
      setStarting(false)
    }
  }, [slug, connectionId, starting])

  useEffect(() => {
    if (!started || !session || !slug) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    async function poll() {
      try {
        const result = await api<{ data: PollData }>(
          `/api/webchat/${slug}/${connectionId}/messages?limit=50`,
          undefined,
          sessionRef.current?.token,
        )
        if (cancelled) return
        mergeMessages(result.data.items)
        if (result.data.status === "closed") setClosed(true)
      } catch {
        // polling best-effort: el siguiente ciclo reintenta
      }
    }
    void poll()
    timer = setInterval(() => void poll(), 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [started, session, slug, connectionId, mergeMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages.length])

  async function send(message: PromptInputMessage) {
    const text = message.text.trim()
    if (!text || sending || !session || !slug || closed) return
    setSending(true)
    setError(null)
    try {
      await api(
        `/api/webchat/${slug}/${connectionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            clientMessageId: crypto.randomUUID(),
            text: text.slice(0, 2000),
            ...(name.trim() ? { displayName: name.trim().slice(0, 80) } : {}),
          }),
        },
        session.token,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pudimos enviar el mensaje")
      throw e
    } finally {
      setSending(false)
    }
  }

  const accent = config?.color ?? "#0f766e"

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header
        className="flex items-center gap-2 px-4 py-3 text-white"
        style={{ backgroundColor: accent }}
      >
        <MessageCircle className="size-5 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{config?.title ?? "Chat"}</p>
          {config ? (
            <p className="truncate text-xs opacity-80">{config.orgName}</p>
          ) : null}
        </div>
      </header>

      {configError ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {configError}
        </div>
      ) : !config ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Cargando el chat…
        </div>
      ) : !started ? (
        <div className="flex flex-1 flex-col justify-center gap-3 p-6">
          {config.greeting ? <p className="text-sm">{config.greeting}</p> : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Tu nombre (opcional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="¿Cómo te llamas?"
              autoComplete="off"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2"
            />
          </label>
          {error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ backgroundColor: accent }}
          >
            {starting ? "Iniciando…" : "Iniciar chat"}
          </button>
          <p className="text-xs text-muted-foreground">
            Solo usamos tu nombre para atenderte; no vinculamos pacientes por lo que escribas aquí.
          </p>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" aria-live="polite">
            {messages.map((msg) => {
              const mine = msg.direction === "in"
              return (
                <Message key={msg.id} from={mine ? "user" : "assistant"}>
                  <MessageContent
                    className={mine ? undefined : "rounded-lg bg-muted px-4 py-3"}
                  >
                    {msg.senderKind === "agent" && !mine ? (
                      <span className="text-xs font-medium text-muted-foreground">Agente</span>
                    ) : null}
                    <span className="whitespace-pre-wrap break-words">{msg.body ?? ""}</span>
                  </MessageContent>
                </Message>
              )
            })}
            <div ref={bottomRef} />
          </div>
          {closed ? (
            <p className="border-t px-4 py-3 text-center text-sm text-muted-foreground">
              Esta conversación fue cerrada. Gracias por escribirnos.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 border-t p-2">
              <PromptInput onSubmit={send} className="h-auto min-h-10 items-end bg-background">
                <PromptInputTextarea
                  aria-label="Mensaje"
                  rows={1}
                  placeholder="Escribe tu mensaje… (Enter para enviar)"
                />
                <PromptInputSubmit aria-label="Enviar" disabled={sending} />
              </PromptInput>
              {error ? (
                <p className="px-1 text-xs text-red-600" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}
