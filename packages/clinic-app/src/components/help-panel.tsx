import { Button, buttonVariants, cn, InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, Textarea } from "@odentia/ui"
import {
  DetailDrawer,
  isUnconfirmedSubmit,
  SubmitButton,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useHeaderCompact,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { ArrowRight, CircleHelp } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { HELP_NAME, useReceptionName, withReceptionName } from "../lib/agent-names"
import { ASK_HELP_EVENT } from "../lib/global-search"
import { casesEnvelope, SupportCasesSection } from "./support-cases"
import { appWords } from "../lib/product-words"

const helpAnswer = z.object({
  topicId: z.string(),
  where: z.string(),
  text: z.string(),
  path: z.string().nullable(),
  restriction: z.string().nullable(),
})

const helpReply = z.object({
  askId: z.string(),
  kind: z.enum(["guia", "estado", "nada", "charla"]),
  say: z.string().nullable().optional(),
  answers: z.array(helpAnswer),
  blockers: z.array(z.object({ text: z.string(), where: z.string().nullable(), path: z.string().nullable() })),
  basedOn: z.string(),
})
type HelpReply = z.infer<typeof helpReply>
const askEnvelope = z.object({ data: helpReply })

type SupportKind = "pregunta" | "problema"

/** Lo que un envío a odentIA lleva sin que la persona lo escriba, con sus valores. */
const helpAttachments = z.object({
  screen: z.string(),
  role: z.string(),
  clinic: z.string().nullable(),
  version: z.string().nullable(),
})
type HelpAttachments = z.infer<typeof helpAttachments>
export const screenEnvelope = z.object({
  data: z.object({ title: z.string().nullable(), suggestions: z.array(z.string()), attached: helpAttachments.optional() }),
})

interface Exchange {
  question: string
  /** Dónde se preguntó: la conversación sigue al navegar y lo que se envía después dice esa pantalla. */
  screen: string
  attached: HelpAttachments | undefined
  reply: HelpReply
  /** Lo que la persona dijo de la respuesta, si ya lo dijo. */
  helpful?: boolean
  /** Ya la envió a odentIA, o dijo que no. */
  sent?: "enviada" | "no"
}

/**
 * La conversación vive fuera del botón: cada pantalla monta el suyo en su
 * cabecera, y «Llévame» no debe borrar lo que se preguntó. Dura lo que dura la
 * sesión en esta pestaña; no se guarda en ninguna parte.
 */
let conversation: Exchange[] = []
const conversationListeners = new Set<() => void>()
function setConversation(update: (current: Exchange[]) => Exchange[]) {
  conversation = update(conversation)
  for (const listener of conversationListeners) listener()
}
function subscribeConversation(listener: () => void) {
  conversationListeners.add(listener)
  return () => {
    conversationListeners.delete(listener)
  }
}
const useConversation = () => useSyncExternalStore(subscribeConversation, () => conversation, () => conversation)

/** Mensaje directo a odentIA desde el pie del panel: una consulta a soporte o un problema. */
interface DirectMessage {
  kind: SupportKind
  /** Con qué empieza el mensaje (vacío, o lo que dejó escrito `openSupportRequest`). */
  text: string
  sent: boolean
}

/** Lo que se dice al enviar: dónde llega la respuesta y que, si no la ve, le escribimos. */
const SENT = 'Enviado. Te respondemos aquí, en "Tus casos con soporte". Si no lo ves, te avisamos por correo.'

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4 sm:min-h-8"
const ANSWER = "flex flex-col gap-2 rounded-2xl rounded-bl-md border border-primary/20 bg-primary-soft px-3.5 py-3 text-sm text-primary-soft-foreground"
/** Al leerlo, no al cargar el módulo: la app declara su producto después. */
const DIRECT: Record<SupportKind, { title: string; label: string }> = {
  get pregunta() {
    return { title: `Escribir a soporte de ${appWords().name}`, label: `Tu mensaje para ${appWords().name}` }
  },
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

/** Lo que admiten `POST /api/help/ask` y `POST /api/help/requests` por texto. */
const TEXT_MAX = 500

/** La pregunta a la Ayuda, con los límites y palabras de la ruta. */
const askSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Escribe tu pregunta: al menos 3 caracteres.")
    .max(TEXT_MAX, "Escribe como mucho 500 caracteres."),
})

/** Lo que se envía a odentIA, con los límites y palabras de la ruta. */
const sendSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Escribe lo que quieres enviar: al menos 3 caracteres.")
    .max(TEXT_MAX, "Escribe como mucho 500 caracteres."),
})

/**
 * «Lo que se envía»: el texto, que la persona puede cambiar, y lo que se
 * agrega solo con los valores que el servidor guardará junto a él.
 */
export function WhatIsSent({
  id,
  label,
  initial,
  attached,
  onSend,
  onCancel,
  cancelLabel,
}: {
  id: string
  label: string
  /** Con qué empieza el texto; después es de la persona. */
  initial: string
  attached: HelpAttachments | undefined
  /** Envía el texto ya limpio; si rechaza, el motivo se dice en el campo o junto a los botones. */
  onSend: (text: string) => Promise<unknown>
  onCancel: () => void
  cancelLabel: string
}) {
  const form = useAppForm({
    defaultValues: { question: initial },
    validators: { onSubmit: sendSchema },
    onSubmit: async ({ value }) => {
      await onSend(value.question.trim())
    },
  })
  const onSubmit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
      <section aria-labelledby={`${id}-titulo`} className="flex flex-col gap-2.5 rounded-xl border p-3.5 text-sm">
        <h3 id={`${id}-titulo`} className="font-heading text-[15px] font-semibold">
          Lo que se envía
        </h3>
        <form.AppField name="question">
          {(field) => (
            <field.Control label={label} id={id}>
              {(control) => (
                <Textarea
                  {...control.props}
                  rows={2}
                  maxLength={TEXT_MAX}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
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
        <SubmitButton type="submit" className="min-h-11 flex-1 sm:min-h-9" pending={pending}>
          Enviar a {appWords().name}
        </SubmitButton>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  )
}

/**
 * «Ayuda» en la cabecera de todas las pantallas, para todo el equipo. Dice
 * dónde está cada cosa y lleva hasta ahí, qué se puede hacer y por qué algo
 * no se puede. No cambia nada: explica. Si no sabe, lo dice y ofrece enviarlo
 * a odentIA.
 */
/**
 * Abre la ayuda desde fuera del botón (el menú «⋯» del teléfono). Con
 * `detail.support` abre ya el mensaje a soporte con ese texto escrito, para
 * que la persona lo lea, lo complete y lo envíe ella (`openSupportRequest`).
 */
export const OPEN_HELP_EVENT = "odentia:abrir-ayuda"

/** Abre la ayuda con un mensaje a soporte ya escrito; no se envía solo. */
export function openSupportRequest(text: string) {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { support: text } }))
}

export function HelpButton({ className }: { className?: string } = {}) {
  const receptionName = useReceptionName()
  const compact = useHeaderCompact()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const [open, setOpen] = useState(false)
  // El correo «Soporte de odentIA respondió tu caso» abre aquí: `?ayuda=casos&caso=<id>`.
  const [linkedCase, setLinkedCase] = useState<string | null>(null)
  const handledLink = useRef<string | null>(null)
  const exchanges = useConversation()
  const [direct, setDirect] = useState<DirectMessage | null>(null)

  const screen = useQuery({
    queryKey: ["help-screen", pathname],
    queryFn: () =>
      apiFetch(`/api/help/screen?path=${encodeURIComponent(pathname)}`).then((body: unknown) =>
        screenEnvelope.parse(body).data,
      ),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })
  // Casos como única fuente de respuestas: el insigne cuenta no leídos del equipo.
  const supportCases = useQuery({
    queryKey: ["support-cases"],
    queryFn: () => apiFetch("/api/help/cases").then((body: unknown) => casesEnvelope.parse(body).data),
    staleTime: 30_000,
    retry: false,
  })
  const unseen = (supportCases.data ?? []).filter((item) => item.unread)

  const ask = useMutation({
    retry: false,
    mutationFn: (question: string) =>
      apiFetch("/api/help/ask", { method: "POST", body: JSON.stringify({ question, screen: pathname }) }).then((body: unknown) => ({
        question,
        screen: pathname,
        attached: screen.data?.attached,
        reply: askEnvelope.parse(body).data,
      })),
    onSuccess: (exchange) => setConversation((current) => [...current, exchange]),
  })
  // Si la red o el servidor fallan, la pregunta se queda escrita para volver a intentarlo.
  const askOptions = { formMessage: (error: unknown) => (isUnconfirmedSubmit(error) ? "No pude responder ahora. Vuelve a intentarlo." : null) }
  const askForm = useAppForm({
    defaultValues: { question: "" },
    validators: { onSubmit: askSchema },
    onSubmit: async ({ value }) => {
      if (ask.isPending) return
      await ask.mutateAsync(value.question.trim())
      askForm.reset()
    },
  })
  const onAskSubmit = useFormSubmit(askForm, askOptions)
  const askError = useFormSubmitError(askForm)
  /** Una pregunta que no se escribió (sugerencia, buscador): pasa por la misma caja y sus mismos avisos. */
  const askText = (text: string) => {
    askForm.setFieldValue("question", text)
    void submitForm(askForm, askOptions)
  }
  const askTextRef = useRef(askText)
  askTextRef.current = askText
  const rate = useMutation({
    retry: false,
    mutationFn: (input: { index: number; askId: string; helpful: boolean }) =>
      apiFetch(`/api/help/ask/${input.askId}/feedback`, { method: "POST", body: JSON.stringify({ helpful: input.helpful }) }),
    onMutate: (input) => setConversation((current) => current.map((item, index) => (index === input.index ? { ...item, helpful: input.helpful } : item))),
    // No quedó anotado: vuelve a preguntarse y se dice por qué.
    onError: (_error, input) => setConversation((current) => current.map((item, index) => (index === input.index ? { ...item, helpful: undefined } : item))),
  })
  // Un solo envío para lo que no supo, para soporte y para un problema: siempre un caso para el equipo de odentIA.
  const send = useMutation({
    retry: false,
    mutationFn: (input: { index: number | null; text: string; kind: SupportKind; screen: string }) =>
      apiFetch("/api/help/requests", { method: "POST", body: JSON.stringify({ question: input.text, screen: input.screen, kind: input.kind }) }),
    onSuccess: (_data, input) => {
      if (input.index === null) setDirect((current) => (current ? { ...current, sent: true } : current))
      else setConversation((current) => current.map((item, index) => (index === input.index ? { ...item, sent: "enviada" } : item)))
      void queryClient.invalidateQueries({ queryKey: ["support-cases"] })
    },
  })
  useEffect(() => {
    const params = new URLSearchParams(searchStr)
    if (params.get("ayuda") !== "casos" || handledLink.current === searchStr) return
    handledLink.current = searchStr
    setLinkedCase(params.get("caso"))
    setOpen(true)
  }, [searchStr])
  // El buscador rápido manda aquí lo que no es un nombre ni una pantalla: «¿cuántas citas hay mañana?».
  useEffect(() => {
    function onAsk(event: Event) {
      const question = (event as CustomEvent<{ question?: string }>).detail?.question?.trim() ?? ""
      setOpen(true)
      if (question.length >= 3) askTextRef.current(question)
      else askForm.setFieldValue("question", question)
    }
    window.addEventListener(ASK_HELP_EVENT, onAsk)
    return () => window.removeEventListener(ASK_HELP_EVENT, onAsk)
  }, [askForm])
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de pantalla, un mensaje a medio escribir diría otra pantalla de la que se adjunta.
  useEffect(() => {
    setDirect(null)
  }, [pathname])
  useEffect(() => {
    const onOpen = (event: Event) => {
      setOpen(true)
      const support = (event as CustomEvent<{ support?: string } | undefined>).detail?.support?.trim()
      if (support) setDirect({ kind: "pregunta", text: support, sent: false })
    }
    window.addEventListener(OPEN_HELP_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_HELP_EVENT, onOpen)
  }, [])

  /** Lo que no supo responder y lo que respondió sin servir salen igual: la pregunta y lo que se envía con ella. */
  const sendExchange = (exchange: Exchange, index: number) => (
    <WhatIsSent
      id={`ayuda-enviar-${index}`}
      label="Tu pregunta · puedes cambiarla"
      initial={exchange.question}
      attached={exchange.attached}
      onSend={(text) => send.mutateAsync({ index, text, kind: "pregunta", screen: exchange.screen })}
      onCancel={() => setConversation((current) => current.map((item, at) => (at === index ? { ...item, sent: "no" } : item)))}
      cancelLabel="No, gracias"
    />
  )

  function openDirect(kind: SupportKind) {
    setDirect({ kind, text: "", sent: false })
  }

  const title = screen.data?.title
  const attached = screen.data?.attached

  return (
    <>
      <Button
        type="button"
        variant={open ? "default" : "outline"}
        className={cn("elevated relative h-9 gap-2 rounded-full px-3", compact && "hidden", className)}
        onClick={() => setOpen(!open)}
        aria-label={`Ayuda${unseen.length > 0 ? `, ${unseen.length} ${unseen.length === 1 ? "respuesta nueva" : "respuestas nuevas"}` : ""}`}
        aria-expanded={open}
      >
        <CircleHelp className="size-4" aria-hidden />
        <span className="hidden md:inline">Ayuda</span>
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
          description={title ? `Estás en ${title}` : `Cómo usar ${appWords().name}`}
          onClose={() => setOpen(false)}
          isSubmitting={ask.isPending || send.isPending}
        >
          <div className="flex flex-col gap-5">
            {exchanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Soy {HELP_NAME}, tu guía virtual de {appWords().name}. Pregúntame dónde se configura algo, dónde se ve o si se puede hacer con el sistema. También por qué algo no te deja.
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

                    {exchange.reply.kind === "charla" ? (
                      <div className={ANSWER}>
                        <p>{exchange.reply.say}</p>
                      </div>
                    ) : null}

                    {exchange.reply.kind === "guia"
                      ? exchange.reply.answers.map((answer) => (
                          <div key={answer.topicId} className={ANSWER}>
                            <p className="whitespace-pre-wrap">{withDestination(withReceptionName(answer.text, receptionName), answer.where)}</p>
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
                          {exchange.sent === undefined ? <p>¿Lo envío a {appWords().name} para que te respondan?</p> : null}
                        </div>
                        {exchange.sent === "enviada" ? (
                          <p role="status" className="text-sm font-semibold">
                            {SENT}
                          </p>
                        ) : exchange.sent === "no" ? null : (
                          sendExchange(exchange, index)
                        )}
                      </>
                    ) : null}

                    {exchange.reply.kind === "guia" || exchange.reply.kind === "estado" ? (
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
                        ) : null}
                        {exchange.helpful === undefined ? (
                          rate.isError && rate.variables?.index === index ? (
                            <p role="alert" className="text-sm text-destructive">
                              No se anotó: {submitErrorMessage(rate.error)}
                            </p>
                          ) : null
                        ) : (
                          <p role="status" className="text-sm text-muted-foreground">
                            {exchange.helpful ? "Gracias. Lo anotamos." : "Gracias. Lo anotamos para mejorar la guía."}
                          </p>
                        )}
                        {/* Si no le sirvió, no se queda sin salida: la misma vía que lo que no supo responder. */}
                        {exchange.helpful === false ? (
                          exchange.sent === "enviada" ? (
                            <p role="status" className="text-sm font-semibold">
                              {SENT}
                            </p>
                          ) : exchange.sent === "no" ? null : (
                            <>
                              <p className="text-sm font-semibold">¿Lo envío a {appWords().name} para que te respondan?</p>
                              {sendExchange(exchange, index)}
                            </>
                          )
                        ) : null}
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            <SupportCasesSection initialCaseId={linkedCase} />
            {(screen.data?.suggestions ?? []).length > 0 ? (
              <section aria-label="En esta pantalla suelen preguntar" className="flex flex-col gap-1.5 border-t pt-3">
                <h3 className="text-[13px] font-bold text-muted-foreground">En esta pantalla suelen preguntar</h3>
                {(screen.data?.suggestions ?? []).map((suggestion) => withReceptionName(suggestion, receptionName)).map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left text-primary sm:min-h-10"
                    disabled={ask.isPending}
                    onClick={() => askText(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </section>
            ) : null}

            <div className="flex flex-col gap-2 border-t pt-3.5">
              <form noValidate onSubmit={onAskSubmit}>
                <askForm.AppField name="question">
                  {(field) => (
                    <field.Control label="Tu pregunta" hideLabel id="ayuda-pregunta">
                      {(control) => (
                        <InputGroup className="border-input bg-card">
                          <InputGroupTextarea
                            {...control.props}
                            rows={1}
                            maxLength={TEXT_MAX}
                            className="max-h-32 min-h-11"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault()
                                event.currentTarget.form?.requestSubmit()
                              }
                            }}
                            placeholder="Pregunta cómo hacer algo…"
                            aria-describedby={["ayuda-pregunta-nota", control.describedBy].filter(Boolean).join(" ")}
                          />
                          <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                            <InputGroupButton
                              type="submit"
                              variant="default"
                              size="icon-sm"
                              className="size-11 rounded-xl sm:size-9"
                              aria-label="Preguntar"
                              disabled={ask.isPending}
                              aria-busy={ask.isPending}
                            >
                              <ArrowRight aria-hidden />
                            </InputGroupButton>
                          </InputGroupAddon>
                        </InputGroup>
                      )}
                    </field.Control>
                  )}
                </askForm.AppField>
              </form>
              {askError ? (
                <p role="alert" className="text-sm text-destructive">
                  {askError}
                </p>
              ) : null}

              {direct?.sent ? (
                <p role="status" className="text-sm font-semibold">
                  {SENT}
                </p>
              ) : direct ? (
                <section aria-label={DIRECT[direct.kind].title} className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">{DIRECT[direct.kind].title}</h3>
                  <WhatIsSent
                    key={`${direct.kind}:${direct.text}`}
                    id="ayuda-directo"
                    label={DIRECT[direct.kind].label}
                    initial={direct.text}
                    attached={attached}
                    onSend={(text) => send.mutateAsync({ index: null, text, kind: direct.kind, screen: pathname })}
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
                      <span className="hidden sm:inline">Escribir a soporte de {appWords().name}</span>
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
