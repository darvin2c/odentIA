import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { DetailDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { CircleHelp } from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, apiFetch } from "../lib/api"
import { mutationErrorMessage } from "../lib/query-error"

interface HelpAnswer {
  topicId: string
  where: string
  text: string
  path: string | null
  restriction: string | null
}

interface HelpReply {
  askId: string
  kind: "guia" | "estado" | "nada"
  answers: HelpAnswer[]
  blockers: Array<{ text: string; where: string | null; path: string | null }>
  basedOn: string
}

interface HelpRequestItem {
  id: string
  kind: "pregunta" | "problema"
  question: string
  status: "abierta" | "respondida"
  answer: string | null
  seen: boolean
}

interface Exchange {
  question: string
  reply: HelpReply
  /** Lo que la persona dijo de la respuesta, si ya lo dijo. */
  helpful?: boolean
  /** Ya la envió a odentIA, o dijo que no. */
  sent?: "enviada" | "no"
}

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"

/**
 * «Ayuda» en la cabecera de todas las pantallas, para todo el equipo. Dice
 * dónde está cada cosa y lleva hasta ahí, qué se puede hacer y por qué algo
 * no se puede. No cambia nada: explica. Si no sabe, lo dice y ofrece enviarlo
 * a odentIA.
 */
export function HelpButton() {
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  /** Pregunta que se está preparando para enviar a odentIA; la persona puede cambiarla. */
  const [sending, setSending] = useState<{ index: number; text: string } | null>(null)

  const screen = useQuery({
    queryKey: ["help-screen", pathname],
    queryFn: () => apiFetch<{ data: { title: string | null; suggestions: string[] } }>(`/api/help/screen?path=${encodeURIComponent(pathname)}`),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const requests = useQuery({
    queryKey: ["help-requests"],
    queryFn: () => apiFetch<{ data: HelpRequestItem[] }>("/api/help/requests"),
    staleTime: 60_000,
    retry: false,
  })
  const unseen = (requests.data?.data ?? []).filter((item) => item.status === "respondida" && !item.seen)

  const ask = useMutation({
    retry: false,
    mutationFn: (question: string) =>
      apiFetch<{ data: HelpReply }>("/api/help/ask", { method: "POST", body: JSON.stringify({ question, screen: pathname }) }).then((response) => ({
        question,
        reply: response.data,
      })),
    onSuccess: (exchange) => {
      setExchanges((current) => [...current, exchange])
      setDraft("")
    },
  })
  const rate = useMutation({
    retry: false,
    mutationFn: (input: { index: number; askId: string; helpful: boolean }) =>
      apiFetch(`/api/help/ask/${input.askId}/feedback`, { method: "POST", body: JSON.stringify({ helpful: input.helpful }) }),
    onMutate: (input) => setExchanges((current) => current.map((item, index) => (index === input.index ? { ...item, helpful: input.helpful } : item))),
  })
  const send = useMutation({
    retry: false,
    mutationFn: (input: { index: number; text: string }) =>
      apiFetch("/api/help/requests", { method: "POST", body: JSON.stringify({ question: input.text, screen: pathname }) }),
    onSuccess: (_data, input) => {
      setExchanges((current) => current.map((item, index) => (index === input.index ? { ...item, sent: "enviada" } : item)))
      setSending(null)
      void queryClient.invalidateQueries({ queryKey: ["help-requests"] })
    },
  })
  const markSeen = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/help/requests/seen", { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["help-requests"] }),
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de pantalla la conversación anterior ya no viene al caso.
  useEffect(() => {
    setSending(null)
  }, [pathname])

  function submit(event: FormEvent) {
    event.preventDefault()
    const question = draft.trim()
    if (question.length >= 3 && !ask.isPending) ask.mutate(question)
  }

  const askError =
    ask.error instanceof ApiError && ask.error.status === 429
      ? (ask.error.shape.message ?? "Llegaste al tope de preguntas por hoy.")
      : ask.error
        ? "No pude responder ahora. Vuelve a intentarlo."
        : null
  const title = screen.data?.data.title

  return (
    <>
      <Button
        type="button"
        variant={open ? "default" : "outline"}
        className="elevated relative h-11 gap-2 rounded-full px-3"
        onClick={() => setOpen(!open)}
        aria-label={`Ayuda${unseen.length > 0 ? `, ${unseen.length} ${unseen.length === 1 ? "respuesta nueva" : "respuestas nuevas"}` : ""}`}
        aria-expanded={open}
      >
        <CircleHelp className="size-5" aria-hidden />
        <span className="hidden sm:inline">Ayuda</span>
        {unseen.length > 0 ? (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground">
            {unseen.length}
          </span>
        ) : null}
      </Button>

      {open ? (
        <DetailDrawer
          open
          title="Ayuda"
          description={title ? `Estás en ${title}` : "Cómo usar odentIA"}
          onClose={() => setOpen(false)}
          isSubmitting={ask.isPending || send.isPending}
        >
          <div className="flex flex-col gap-5">
            {unseen.length > 0 ? (
              <section aria-label="Respuestas de odentIA" className="flex flex-col gap-2 rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
                {unseen.map((item) => (
                  <div key={item.id} className="flex flex-col gap-1">
                    <p className="font-semibold">odentIA respondió tu pregunta «{item.question}»</p>
                    <p className="whitespace-pre-wrap">{item.answer}</p>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" disabled={markSeen.isPending} onClick={() => markSeen.mutate()}>
                  Entendido
                </Button>
              </section>
            ) : null}

            {exchanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Pregúntame dónde se configura algo, dónde se ve o si se puede hacer con el sistema. También por qué algo no te deja.
              </p>
            ) : (
              <ol className="flex flex-col gap-4" aria-live="polite">
                {exchanges.map((exchange, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: las preguntas solo se añaden al final; no se reordenan.
                  <li key={`${exchange.reply.askId}-${index}`} className="flex flex-col gap-2">
                    <p className="max-w-[92%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                      <span className="sr-only">Preguntaste: </span>
                      {exchange.question}
                    </p>

                    {exchange.reply.kind === "guia"
                      ? exchange.reply.answers.map((answer) => (
                          <div key={answer.topicId} className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
                            <p className="whitespace-pre-wrap">{answer.text}</p>
                            {answer.restriction ? <p className="text-muted-foreground">{answer.restriction}</p> : null}
                            {answer.path ? (
                              <Link to={answer.path} className={LINK} onClick={() => setOpen(false)}>
                                Llévame a {answer.where}
                              </Link>
                            ) : null}
                          </div>
                        ))
                      : null}

                    {exchange.reply.kind === "estado" ? (
                      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
                        <p className="font-semibold">Esto es lo que falta ahora:</p>
                        <ul className="flex flex-col gap-2">
                          {exchange.reply.blockers.map((blocker) => (
                            <li key={blocker.text} className="flex flex-col">
                              <span>{blocker.text}</span>
                              {blocker.path && blocker.where ? (
                                <Link to={blocker.path} className={LINK} onClick={() => setOpen(false)}>
                                  Llévame a {blocker.where}
                                </Link>
                              ) : blocker.where ? (
                                <span className="text-muted-foreground">Se resuelve en {blocker.where}; pídeselo a quien administra la clínica.</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {exchange.reply.kind === "nada" ? (
                      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
                        <p>Esto no está en la guía, y no quiero inventarlo.</p>
                        {exchange.sent === "enviada" ? (
                          <p role="status" className="font-semibold">
                            Enviado a odentIA. Cuando respondan, lo verás aquí mismo.
                          </p>
                        ) : exchange.sent === "no" ? null : sending?.index === index ? (
                          <div className="flex flex-col gap-2">
                            <Field>
                              <FieldLabel htmlFor="ayuda-enviar">Tu pregunta · puedes cambiarla</FieldLabel>
                              <Textarea
                                id="ayuda-enviar"
                                rows={2}
                                maxLength={500}
                                value={sending.text}
                                onChange={(event) => setSending({ index, text: event.target.value })}
                              />
                              <FieldDescription>
                                Se agrega solo: la pantalla{title ? ` (${title})` : ""}, tu rol y tu clínica, y la versión del sistema. No escribas
                                nombres ni datos de pacientes.
                              </FieldDescription>
                            </Field>
                            {send.isError ? (
                              <p role="alert" className="text-destructive">
                                {mutationErrorMessage(send.error)}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap gap-2">
                              <SubmitButton
                                type="button"
                                size="sm"
                                className="min-h-11 sm:min-h-8"
                                pending={send.isPending}
                                disabled={sending.text.trim().length < 3}
                                onClick={() => send.mutate({ index, text: sending.text.trim() })}
                              >
                                Enviar a odentIA
                              </SubmitButton>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="min-h-11 sm:min-h-8"
                                onClick={() => {
                                  setSending(null)
                                  setExchanges((current) => current.map((item, at) => (at === index ? { ...item, sent: "no" } : item)))
                                }}
                              >
                                No, gracias
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 self-start sm:min-h-8"
                            onClick={() => {
                              send.reset()
                              setSending({ index, text: exchange.question })
                            }}
                          >
                            Enviarlo a odentIA para que te respondan
                          </Button>
                        )}
                      </div>
                    ) : null}

                    {exchange.reply.kind !== "nada" ? (
                      <div className="flex flex-col gap-1 text-sm">
                        <p className="text-muted-foreground">
                          <span className="font-semibold text-foreground">En qué se basó:</span> {exchange.reply.basedOn}
                        </p>
                        {exchange.helpful === undefined ? (
                          <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-wrap items-center gap-2" aria-label="¿Te sirvió?">
                            <span>¿Te sirvió?</span>
                            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => rate.mutate({ index, askId: exchange.reply.askId, helpful: true })}>
                              Sí
                            </Button>
                            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => rate.mutate({ index, askId: exchange.reply.askId, helpful: false })}>
                              No
                            </Button>
                          </fieldset>
                        ) : (
                          <p role="status" className="text-muted-foreground">
                            {exchange.helpful ? "Gracias. Lo anotamos." : "Gracias. Lo anotamos para mejorar la guía."}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            {(screen.data?.data.suggestions ?? []).length > 0 ? (
              <section aria-label="En esta pantalla suelen preguntar" className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">En esta pantalla suelen preguntar</h3>
                <div className="flex flex-col items-start gap-1.5">
                  {(screen.data?.data.suggestions ?? []).map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 whitespace-normal rounded-full text-left sm:min-h-8"
                      disabled={ask.isPending}
                      onClick={() => ask.mutate(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            <form onSubmit={submit} className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor="ayuda-pregunta" className="sr-only">
                  Tu pregunta
                </FieldLabel>
                <Textarea
                  id="ayuda-pregunta"
                  rows={2}
                  maxLength={500}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="Pregunta cómo hacer algo…"
                />
                <FieldDescription>No cambia nada por ti. Si no sabe, te lo dice.</FieldDescription>
              </Field>
              {askError ? (
                <p role="alert" className="text-sm text-destructive">
                  {askError}
                </p>
              ) : null}
              <SubmitButton type="submit" pending={ask.isPending} disabled={draft.trim().length < 3} className="min-h-11 self-end sm:min-h-9">
                Preguntar
              </SubmitButton>
            </form>
          </div>
        </DetailDrawer>
      ) : null}
    </>
  )
}
