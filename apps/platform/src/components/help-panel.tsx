import { Button, buttonVariants, cn, Field, FieldLabel, InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, Textarea } from "@odentia/ui"
import { DetailDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { ArrowRight, CircleHelp } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
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

/** Lo que un envío a odentIA lleva sin que la persona lo escriba, con sus valores. */
interface HelpAttachments {
  screen: string
  role: string
  clinic: string | null
  version: string | null
}

interface Exchange {
  question: string
  reply: HelpReply
  /** Lo que la persona dijo de la respuesta, si ya lo dijo. */
  helpful?: boolean
  /** Lo que se enviaría a odentIA si no supo; empieza siendo la pregunta y se puede cambiar. */
  toSend?: string
  /** Ya la envió a odentIA, o dijo que no. */
  sent?: "enviada" | "no"
}

/** Mensaje directo a odentIA desde el pie del panel: una consulta a soporte o un problema. */
interface DirectMessage {
  kind: HelpRequestItem["kind"]
  text: string
  sent: boolean
}

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4 sm:min-h-8"
const ANSWER = "flex flex-col gap-2 rounded-2xl rounded-bl-md border border-primary/20 bg-primary-soft px-3.5 py-3 text-sm text-primary-soft-foreground"
const DIRECT: Record<HelpRequestItem["kind"], { title: string; label: string }> = {
  pregunta: { title: "Escribir a soporte de odentIA", label: "Tu mensaje para odentIA" },
  problema: { title: "Reportar un problema", label: "Qué pasó" },
}

/** El texto de la guía con el nombre de la pantalla resaltado: es el destino de «Llévame». */
function withDestination(text: string, where: string): ReactNode {
  const at = where ? text.indexOf(where) : -1
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-bold">{where}</strong>
      {text.slice(at + where.length)}
    </>
  )
}

/**
 * «Lo que se envía»: el texto, que la persona puede cambiar, y lo que se
 * agrega solo con los valores que el servidor guardará junto a él.
 */
function WhatIsSent({
  id,
  label,
  value,
  onChange,
  attached,
  error,
  pending,
  onSend,
  onCancel,
  cancelLabel,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  attached: HelpAttachments | undefined
  error: string | null
  pending: boolean
  onSend: () => void
  onCancel: () => void
  cancelLabel: string
}) {
  return (
    <>
      <section aria-labelledby={`${id}-titulo`} className="flex flex-col gap-2.5 rounded-xl border p-3.5 text-sm">
        <h3 id={`${id}-titulo`} className="font-heading text-[15px] font-semibold">
          Lo que se envía
        </h3>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Textarea id={id} rows={2} maxLength={500} value={value} onChange={(event) => onChange(event.target.value)} />
        </Field>
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold text-muted-foreground">Se agrega solo</p>
          <ul className="flex flex-col gap-0.5">
            <li>Pantalla{attached ? `: ${attached.screen}` : ""}</li>
            <li>{attached ? `Tu rol: ${[attached.role, attached.clinic].filter(Boolean).join(" · ")}` : "Tu rol y tu clínica"}</li>
            {/* Sin versión declarada no se envía ninguna: no se anuncia. */}
            {attached ? attached.version ? <li>Versión del sistema: {attached.version}</li> : null : <li>Versión del sistema</li>}
          </ul>
        </div>
        <p className="rounded-lg bg-warning-soft px-2.5 py-2 font-semibold">No escribas nombres ni datos de pacientes.</p>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton type="button" className="min-h-11 flex-1 sm:min-h-9" pending={pending} disabled={value.trim().length < 3} onClick={onSend}>
          Enviar a odentIA
        </SubmitButton>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </>
  )
}

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
  const [direct, setDirect] = useState<DirectMessage | null>(null)
  /** Respuestas de odentIA abiertas con «Ver»: siguen a la vista aunque ya cuenten como leídas. */
  const [viewed, setViewed] = useState<string[]>([])

  const screen = useQuery({
    queryKey: ["help-screen", pathname],
    queryFn: () =>
      apiFetch<{ data: { title: string | null; suggestions: string[]; attached?: HelpAttachments } }>(`/api/help/screen?path=${encodeURIComponent(pathname)}`),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const requests = useQuery({
    queryKey: ["help-requests"],
    queryFn: () => apiFetch<{ data: HelpRequestItem[] }>("/api/help/requests"),
    staleTime: 60_000,
    retry: false,
  })
  const answered = (requests.data?.data ?? []).filter((item) => item.status === "respondida")
  const unseen = answered.filter((item) => !item.seen)
  const shown = answered.filter((item) => !item.seen || viewed.includes(item.id))

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
  // Un solo envío para lo que no supo, para soporte y para un problema: siempre un caso para el equipo de odentIA.
  const send = useMutation({
    retry: false,
    mutationFn: (input: { index: number | null; text: string; kind: HelpRequestItem["kind"] }) =>
      apiFetch("/api/help/requests", { method: "POST", body: JSON.stringify({ question: input.text, screen: pathname, kind: input.kind }) }),
    onSuccess: (_data, input) => {
      if (input.index === null) setDirect((current) => (current ? { ...current, sent: true } : current))
      else setExchanges((current) => current.map((item, index) => (index === input.index ? { ...item, sent: "enviada" } : item)))
      void queryClient.invalidateQueries({ queryKey: ["help-requests"] })
    },
  })
  const markSeen = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch("/api/help/requests/seen", { method: "POST", body: JSON.stringify({ id }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["help-requests"] }),
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de pantalla, un mensaje a medio escribir diría otra pantalla de la que se adjunta.
  useEffect(() => {
    setDirect(null)
  }, [pathname])

  function submit(event: FormEvent) {
    event.preventDefault()
    const question = draft.trim()
    if (question.length >= 3 && !ask.isPending) ask.mutate(question)
  }

  function view(item: HelpRequestItem) {
    const showing = viewed.includes(item.id)
    setViewed(showing ? viewed.filter((id) => id !== item.id) : [...viewed, item.id])
    if (!showing && !item.seen) markSeen.mutate(item.id)
  }

  function openDirect(kind: HelpRequestItem["kind"]) {
    send.reset()
    setDirect({ kind, text: "", sent: false })
  }

  const askError =
    ask.error instanceof ApiError && ask.error.status === 429
      ? (ask.error.shape.message ?? "Llegaste al tope de preguntas por hoy.")
      : ask.error
        ? "No pude responder ahora. Vuelve a intentarlo."
        : null
  const title = screen.data?.data.title
  const attached = screen.data?.data.attached
  const sendError = (index: number | null) => (send.isError && send.variables?.index === index ? mutationErrorMessage(send.error) : null)
  const sendPending = (index: number | null) => send.isPending && send.variables?.index === index

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
            {shown.length > 0 ? (
              <section aria-label="Respuestas de odentIA">
                <ul className="flex flex-col gap-2">
                  {shown.map((item) => {
                    const showing = viewed.includes(item.id)
                    return (
                      <li key={item.id} className="flex flex-col gap-2 rounded-xl bg-success-soft px-3.5 py-3 text-sm">
                        <div className="flex items-center gap-2.5">
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="font-bold">odentIA respondió tu pregunta</span>
                            <span className="break-words">«{item.question}»</span>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 shrink-0 sm:min-h-9"
                            aria-expanded={showing}
                            aria-controls={`ayuda-respuesta-${item.id}`}
                            onClick={() => view(item)}
                          >
                            {showing ? "Ocultar" : "Ver"}
                          </Button>
                        </div>
                        {showing ? (
                          <p id={`ayuda-respuesta-${item.id}`} className="whitespace-pre-wrap rounded-lg bg-card px-3 py-2">
                            {item.answer}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
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
                  <li key={`${exchange.reply.askId}-${index}`} className="flex flex-col gap-3">
                    <p className="max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
                      <span className="sr-only">Preguntaste: </span>
                      {exchange.question}
                    </p>

                    {exchange.reply.kind === "guia"
                      ? exchange.reply.answers.map((answer) => (
                          <div key={answer.topicId} className={ANSWER}>
                            <p className="whitespace-pre-wrap">{withDestination(answer.text, answer.where)}</p>
                            {answer.restriction ? <p>{answer.restriction}</p> : null}
                            {answer.path ? (
                              <Link
                                to={answer.path}
                                className={cn(buttonVariants({ size: "sm" }), "min-h-11 self-start sm:min-h-9")}
                                aria-label={`Llévame a ${answer.where}`}
                                onClick={() => setOpen(false)}
                              >
                                Llévame
                              </Link>
                            ) : null}
                          </div>
                        ))
                      : null}

                    {exchange.reply.kind === "estado" ? (
                      <div className={ANSWER}>
                        <p className="font-bold">Esto es lo que falta ahora:</p>
                        <ul className="flex flex-col gap-3">
                          {exchange.reply.blockers.map((blocker) => (
                            <li key={blocker.text} className="flex flex-col gap-1.5">
                              <span>{blocker.text}</span>
                              {blocker.where ? (
                                <span>
                                  Se resuelve en <strong className="font-bold">{blocker.where}</strong>
                                  {blocker.path ? "." : "; pídeselo a quien administra la clínica."}
                                </span>
                              ) : null}
                              {blocker.path && blocker.where ? (
                                <Link
                                  to={blocker.path}
                                  className={cn(buttonVariants({ size: "sm" }), "min-h-11 self-start sm:min-h-9")}
                                  aria-label={`Llévame a ${blocker.where}`}
                                  onClick={() => setOpen(false)}
                                >
                                  Llévame
                                </Link>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {exchange.reply.kind === "nada" ? (
                      <>
                        <div className={ANSWER}>
                          <p className="font-bold">Esto no está en la guía, y no quiero inventarlo.</p>
                          {exchange.sent === undefined ? <p>¿Lo envío a odentIA para que te respondan?</p> : null}
                        </div>
                        {exchange.sent === "enviada" ? (
                          <p role="status" className="text-sm font-semibold">
                            Enviado a odentIA. Cuando respondan, lo verás aquí mismo.
                          </p>
                        ) : exchange.sent === "no" ? null : (
                          <WhatIsSent
                            id={`ayuda-enviar-${index}`}
                            label="Tu pregunta · puedes cambiarla"
                            value={exchange.toSend ?? exchange.question}
                            onChange={(text) => setExchanges((current) => current.map((item, at) => (at === index ? { ...item, toSend: text } : item)))}
                            attached={attached}
                            error={sendError(index)}
                            pending={sendPending(index)}
                            onSend={() => send.mutate({ index, text: (exchange.toSend ?? exchange.question).trim(), kind: "pregunta" })}
                            onCancel={() => setExchanges((current) => current.map((item, at) => (at === index ? { ...item, sent: "no" } : item)))}
                            cancelLabel="No, gracias"
                          />
                        )}
                      </>
                    ) : null}

                    {exchange.reply.kind !== "nada" ? (
                      <>
                        <div className="flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm">
                          <p className="text-xs font-bold text-muted-foreground">En qué se basó</p>
                          <p>{exchange.reply.basedOn}</p>
                        </div>
                        {exchange.helpful === undefined ? (
                          <fieldset className="m-0 flex min-w-0 items-center gap-2 border-0 p-0 text-sm" aria-label="¿Te sirvió?">
                            <span className="flex-1 font-semibold">¿Te sirvió?</span>
                            <Button type="button" variant="outline" size="sm" className="min-h-11 px-4 sm:min-h-9" onClick={() => rate.mutate({ index, askId: exchange.reply.askId, helpful: true })}>
                              Sí
                            </Button>
                            <Button type="button" variant="outline" size="sm" className="min-h-11 px-4 sm:min-h-9" onClick={() => rate.mutate({ index, askId: exchange.reply.askId, helpful: false })}>
                              No
                            </Button>
                          </fieldset>
                        ) : (
                          <p role="status" className="text-sm text-muted-foreground">
                            {exchange.helpful ? "Gracias. Lo anotamos." : "Gracias. Lo anotamos para mejorar la guía."}
                          </p>
                        )}
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            {(screen.data?.data.suggestions ?? []).length > 0 ? (
              <section aria-label="En esta pantalla suelen preguntar" className="flex flex-col gap-1.5 border-t pt-3">
                <h3 className="text-[13px] font-bold text-muted-foreground">En esta pantalla suelen preguntar</h3>
                {(screen.data?.data.suggestions ?? []).map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left text-primary sm:min-h-10"
                    disabled={ask.isPending}
                    onClick={() => ask.mutate(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </section>
            ) : null}

            <div className="flex flex-col gap-2 border-t pt-3.5">
              <form onSubmit={submit}>
                <FieldLabel htmlFor="ayuda-pregunta" className="sr-only">
                  Tu pregunta
                </FieldLabel>
                <InputGroup className="border-input bg-card">
                  <InputGroupTextarea
                    id="ayuda-pregunta"
                    rows={1}
                    maxLength={500}
                    className="max-h-32 min-h-11"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault()
                        event.currentTarget.form?.requestSubmit()
                      }
                    }}
                    placeholder="Pregunta cómo hacer algo…"
                    aria-describedby="ayuda-pregunta-nota"
                  />
                  <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                    <InputGroupButton
                      type="submit"
                      variant="default"
                      size="icon-sm"
                      className="size-11 rounded-xl sm:size-9"
                      aria-label="Preguntar"
                      disabled={draft.trim().length < 3 || ask.isPending}
                      aria-busy={ask.isPending}
                    >
                      <ArrowRight aria-hidden />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
              {askError ? (
                <p role="alert" className="text-sm text-destructive">
                  {askError}
                </p>
              ) : null}

              {direct?.sent ? (
                <p role="status" className="text-sm font-semibold">
                  Enviado a odentIA. Cuando respondan, lo verás aquí mismo.
                </p>
              ) : direct ? (
                <section aria-label={DIRECT[direct.kind].title} className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">{DIRECT[direct.kind].title}</h3>
                  <WhatIsSent
                    id="ayuda-directo"
                    label={DIRECT[direct.kind].label}
                    value={direct.text}
                    onChange={(text) => setDirect({ ...direct, text })}
                    attached={attached}
                    error={sendError(null)}
                    pending={sendPending(null)}
                    onSend={() => send.mutate({ index: null, text: direct.text.trim(), kind: direct.kind })}
                    onCancel={() => setDirect(null)}
                    cancelLabel="Cancelar"
                  />
                </section>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-x-3 text-[13px] sm:flex-col sm:items-start">
                <p id="ayuda-pregunta-nota" className="text-muted-foreground">
                  No cambia nada por ti.<span className="hidden sm:inline"> Si no sabe, te lo dice.</span>
                </p>
                {direct && !direct.sent ? null : (
                  <div className="flex flex-wrap items-center gap-x-4">
                    <Button type="button" variant="link" className={`h-auto p-0 ${LINK}`} onClick={() => openDirect("pregunta")}>
                      <span className="sm:hidden">Escribir a soporte</span>
                      <span className="hidden sm:inline">Escribir a soporte de odentIA</span>
                    </Button>
                    <Button type="button" variant="link" className={`h-auto p-0 ${LINK}`} onClick={() => openDirect("problema")}>
                      Reportar un problema
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DetailDrawer>
      ) : null}
    </>
  )
}
