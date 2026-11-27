import { Button, buttonVariants, cn, InputGroupAddon, Textarea, useIsMobile } from "@odentia/ui"
import { Message, MessageContent } from "@odentia/ui/components/ai-elements/message"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@odentia/ui/components/ai-elements/prompt-input"
import { Shimmer } from "@odentia/ui/components/ai-elements/shimmer"
import { Sources, SourcesContent, SourcesTrigger } from "@odentia/ui/components/ai-elements/sources"
import { Suggestion } from "@odentia/ui/components/ai-elements/suggestion"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { ArrowRight, ChevronDown, CircleHelp, ExternalLink } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import { DetailDrawer } from "../detail/index.js"
import { submitForm, useAppForm, useFormSubmit, useFormSubmitError } from "../form/app-form.js"
import { SubmitButton } from "../form/submit-button.js"
import { isApiErrorLike, isUnconfirmedSubmit, submitErrorMessage } from "../form/submit-error.js"
import { useHeaderCompact } from "../header-utilities.js"
import {
  ASK_HELP_EVENT,
  HELP_NAME,
  type HelpAnswer,
  type HelpAttachments,
  type HelpExchange,
  type HelpPrevious,
  type HelpVideo,
  helpAskEnvelope,
  helpScreenEnvelope,
  OPEN_HELP_EVENT,
  previousOf,
  shownVideos,
  spokenReply,
} from "./help-reply.js"

/**
 * La Ayuda, la misma en todas las apps: el botón de la cabecera y el panel donde responde
 * Ariadna. Cada app pone solo lo suyo (su nombre, su servidor, sus casos con soporte y quién da
 * acceso); cambiar la Ayuda aquí la cambia en todas. Armada con las piezas de AI Elements
 * (`Message`, `PromptInput`, `Suggestion`, `Shimmer`, `Sources`) adaptadas a la Ayuda.
 */

type SupportKind = "pregunta" | "problema"

/** Lo que cada app le pone a la Ayuda. */
export interface HelpButtonProps {
  className?: string
  /** El nombre de la app: «odentIA», «gestorIA». */
  appName: string
  /** A quiénes atiende la app, para pedir que no se escriban sus nombres: «pacientes», «clientes». */
  peopleWord: string
  /** El lugar de trabajo: «clínica», «tienda». */
  placeWord: string
  /** Dónde responde su servidor: `<apiBase>/screen`, `/ask`, `/ask/:id/feedback`, `/ask/:id/none` y `/requests`. */
  apiBase: string
  /** La llamada a su servidor, con su sesión; lanza el error de la API si no se pudo. */
  fetcher: (path: string, init?: RequestInit) => Promise<unknown>
  /** Cambia un texto del servidor antes de mostrarlo (el nombre de recepción de la clínica). */
  rename?: (text: string) => string
  /** Respuestas de soporte sin leer: van como número en el botón. */
  unseen: number
  /** Soporte mirando la cuenta: no escribe a soporte ni da acceso. */
  supportMode: boolean
  /** «Tus casos con soporte», con el caso que abrió un enlace del correo. */
  renderCases: (props: { initialCaseId: string | null }) => ReactNode
  /** «Dar acceso a soporte», para quien puede darlo. */
  renderGiveAccess?: (props: { screen: string; onClose: () => void }) => ReactNode
  /** Después de enviar algo al equipo de la app (para traer sus casos de nuevo). */
  onSent?: () => void
  /** El agente de las cifras de la app, si responde las preguntas de datos. */
  dataAgent?: { name: string; ask: (question: string) => void }
}

/** Lo que admiten `<apiBase>/ask` y `<apiBase>/requests` por texto. */
const TEXT_MAX = 500

/** La pregunta a la Ayuda, con los límites y palabras de la ruta. */
const askSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Escribe tu pregunta: al menos 3 caracteres.")
    .max(TEXT_MAX, "Escribe como mucho 500 caracteres."),
})

/** Lo que se envía al equipo de la app, con los límites y palabras de la ruta. */
const sendSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Escribe lo que quieres enviar: al menos 3 caracteres.")
    .max(TEXT_MAX, "Escribe como mucho 500 caracteres."),
})

/** Por qué no respondió: el motivo que da el servidor, o que ahora no se pudo. */
function askErrorMessage(error: unknown): string {
  return isApiErrorLike(error) && !isUnconfirmedSubmit(error)
    ? submitErrorMessage(error)
    : "No pude responder ahora. Vuelve a intentarlo."
}

/**
 * La conversación vive fuera del botón: cada pantalla monta el suyo en su
 * cabecera, y «Llévame» no debe borrar lo que se preguntó. Dura lo que dura la
 * sesión en esta pestaña; no se guarda en ninguna parte.
 */
let conversation: HelpExchange[] = []
const conversationListeners = new Set<() => void>()
function setConversation(update: (current: HelpExchange[]) => HelpExchange[]) {
  conversation = update(conversation)
  for (const listener of conversationListeners) listener()
}
function subscribeConversation(listener: () => void) {
  conversationListeners.add(listener)
  return () => {
    conversationListeners.delete(listener)
  }
}
const useConversation = () =>
  useSyncExternalStore(
    subscribeConversation,
    () => conversation,
    () => conversation,
  )
let lastExchangeId = 0
const patchExchange = (id: number, patch: Partial<HelpExchange>) =>
  setConversation((current) =>
    current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  )

/** Mensaje directo al equipo de la app desde el pie del panel: una consulta a soporte o un problema. */
interface DirectMessage {
  kind: SupportKind
  /** Con qué empieza el mensaje (vacío, o lo que dejó escrito `openSupportRequest`). */
  text: string
  sent: boolean
}

/** Lo que se dice al enviar: dónde llega la respuesta y que, si no la ve, le escribimos. */
const SENT =
  'Enviado. Te respondemos aquí, en "Tus casos con soporte". Si no lo ves, te avisamos por correo.'

const LINK =
  "inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4 sm:min-h-8"
/** La burbuja de Ariadna: `MessageContent` con el color suave de la marca de cada app. */
const ANSWER =
  "flex flex-col gap-2 rounded-2xl rounded-bl-md border border-primary/20 bg-primary-soft px-3.5 py-3 text-sm text-primary-soft-foreground"

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
  initial,
  attached,
  appName,
  peopleWord,
  placeWord,
  onSend,
  onCancel,
  cancelLabel,
}: {
  id: string
  label: string
  /** Con qué empieza el texto; después es de la persona. */
  initial: string
  attached: HelpAttachments | undefined
  appName: string
  peopleWord: string
  placeWord: string
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
      <section
        aria-labelledby={`${id}-titulo`}
        className="flex flex-col gap-2.5 rounded-xl border p-3.5 text-sm"
      >
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
            <li>
              {attached
                ? `Tu rol: ${[attached.role, attached.clinic].filter(Boolean).join(" · ")}`
                : `Tu rol y tu ${placeWord}`}
            </li>
            {/* Sin versión declarada no se envía ninguna: no se anuncia. */}
            {attached ? (
              attached.version ? (
                <li>Versión del sistema: {attached.version}</li>
              ) : null
            ) : (
              <li>Versión del sistema</li>
            )}
          </ul>
        </div>
        <p className="rounded-lg bg-warning-soft px-2.5 py-2 font-semibold">
          No escribas nombres ni datos de {peopleWord}.
        </p>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton type="submit" className="min-h-11 flex-1 sm:min-h-9" pending={pending}>
          Enviar a {appName}
        </SubmitButton>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          disabled={pending}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      </div>
    </form>
  )
}

/** «Llévame» dice a dónde: el destino va escrito en el botón, no solo resaltado en el texto. */
function TakeMe({ to, where, onGo }: { to: string; where: string; onGo: () => void }) {
  return (
    <Link
      to={to}
      className={cn(
        buttonVariants({ size: "sm" }),
        "h-auto min-h-11 self-start whitespace-normal py-1.5 text-left sm:min-h-9",
      )}
      onClick={onGo}
    >
      Llévame{where ? ` a ${where}` : ""}
    </Link>
  )
}

/** Los videos de una respuesta: enlaces de texto que abren en otra pestaña. Sin videos no se dibuja nada. */
function AnswerVideos({ videos }: { videos: HelpVideo[] }) {
  if (videos.length === 0) return null
  return (
    <ul className="flex flex-col">
      {videos.map((video) => (
        <li key={video.url}>
          <a
            href={video.url}
            target="_blank"
            rel="noreferrer"
            className={cn(LINK, "gap-1.5 text-left")}
          >
            <span>
              Verlo en video: {video.title}
              {video.minutes ? ` (${video.minutes} min)` : ""}
            </span>
            <ExternalLink aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only"> (se abre en otra pestaña)</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

const LATEST_ID = "ayuda-ultima"

/**
 * Trae a la vista la última pregunta con lo que tenga debajo: al enviarla, al
 * llegar su respuesta y al volver a abrir el panel. Vive dentro del panel para
 * correr cuando su contenido ya está en la página. Lleva al principio de la
 * pregunta, no al final: una respuesta larga se lee desde arriba.
 */
function LatestInView({ at, onOpen }: { at: string; onOpen: boolean }) {
  const opening = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onOpen` solo decide la primera vez; después manda lo último que pasó.
  useEffect(() => {
    const first = opening.current
    opening.current = false
    if (first && !onOpen) return
    document.getElementById(LATEST_ID)?.scrollIntoView({ block: "start" })
  }, [at])
  return null
}

/**
 * «Ayuda» en la cabecera de todas las pantallas, para todo el equipo. Dice
 * dónde está cada cosa y lleva hasta ahí, qué se puede hacer y por qué algo
 * no se puede. No cambia nada: explica. Si no sabe, lo dice y ofrece enviarlo
 * al equipo de la app. Es una conversación: la caja queda fija al pie, la
 * pregunta se ve al enviarla y lo nuevo se trae a la vista.
 */
export function HelpButton({
  className,
  appName,
  peopleWord,
  placeWord,
  apiBase,
  fetcher,
  rename = (text) => text,
  unseen,
  supportMode,
  renderCases,
  renderGiveAccess,
  onSent,
  dataAgent,
}: HelpButtonProps) {
  const compact = useHeaderCompact()
  const isMobile = useIsMobile()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const [open, setOpen] = useState(false)
  // El correo «Soporte respondió tu caso» abre aquí: `?ayuda=casos&caso=<id>`.
  const [linkedCase, setLinkedCase] = useState<string | null>(null)
  const handledLink = useRef<string | null>(null)
  const exchanges = useConversation()
  const [direct, setDirect] = useState<DirectMessage | null>(null)
  // «Dar acceso a soporte»: el cuadro en el mismo panel, solo para quien puede darlo.
  const [giving, setGiving] = useState(false)
  /** Lo que recibe el foco cuando aparece, porque el control que se tocó desaparece (WCAG 2.4.3). */
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    if (focusId === null) return
    document.getElementById(focusId)?.focus()
    setFocusId(null)
  }, [focusId])

  const screen = useQuery({
    queryKey: ["help-screen", apiBase, pathname],
    queryFn: () =>
      fetcher(`${apiBase}/screen?path=${encodeURIComponent(pathname)}`).then(
        (body: unknown) => helpScreenEnvelope.parse(body).data,
      ),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })

  // La respuesta llega a su pregunta aunque el panel se haya cerrado o se haya cambiado de pantalla.
  const ask = useMutation({
    retry: false,
    mutationFn: (input: {
      id: number
      body: { question: string; screen: string; previous?: HelpPrevious }
    }) =>
      fetcher(`${apiBase}/ask`, { method: "POST", body: JSON.stringify(input.body) }).then(
        (body: unknown) => helpAskEnvelope.parse(body).data,
      ),
    onSuccess: (reply, input) => patchExchange(input.id, { reply, answeredAt: Date.now() }),
    onError: (error, input) => patchExchange(input.id, { error: askErrorMessage(error) }),
  })
  // Se espera de una en una; lo dice la conversación, no este botón: otra pantalla monta otro y la espera sigue.
  const pending = exchanges.some((item) => item.reply === null && item.error === null)
  /** La pregunta se ve enseguida, con su espera debajo; la respuesta (o el motivo) llega a ella. */
  function push(question: string) {
    const id = ++lastExchangeId
    const previous = previousOf(exchanges, Date.now())
    setConversation((current) => [
      ...current,
      {
        id,
        question,
        screen: pathname,
        attached: screen.data?.attached,
        reply: null,
        error: null,
        answeredAt: null,
      },
    ])
    ask.mutate({ id, body: { question, screen: pathname, ...(previous ? { previous } : {}) } })
  }
  /** La misma pregunta, en su misma burbuja y con la pantalla donde se hizo. */
  function retry(exchange: HelpExchange) {
    const previous = previousOf(
      exchanges.filter((item) => item.id !== exchange.id),
      Date.now(),
    )
    patchExchange(exchange.id, { error: null })
    ask.mutate({
      id: exchange.id,
      body: {
        question: exchange.question,
        screen: exchange.screen,
        ...(previous ? { previous } : {}),
      },
    })
  }
  const askForm = useAppForm({
    defaultValues: { question: "" },
    validators: { onSubmit: askSchema },
    onSubmit: ({ value }) => {
      // Mientras espera, lo escrito se queda en la caja.
      if (pending) return
      push(value.question.trim())
      askForm.reset()
    },
  })
  /** Una pregunta que no se escribió (sugerencia, buscador): pasa por la misma caja y sus mismos avisos. */
  const askText = (text: string) => {
    askForm.setFieldValue("question", text)
    void submitForm(askForm)
  }
  const askTextRef = useRef(askText)
  askTextRef.current = askText
  const rate = useMutation({
    retry: false,
    mutationFn: (input: { index: number; askId: string; helpful: boolean }) =>
      fetcher(`${apiBase}/ask/${input.askId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ helpful: input.helpful }),
      }),
    // No quedó anotado: vuelve a preguntarse y se dice por qué.
    onError: (_error, input) =>
      setConversation((current) =>
        current.map((item, index) =>
          index === input.index ? { ...item, helpful: undefined } : item,
        ),
      ),
  })
  /** «¿Te sirvió?»: se anota enseguida y el foco pasa a lo que aparece en lugar de los botones. */
  function answerHelpful(exchange: HelpExchange, index: number, helpful: boolean) {
    if (!exchange.reply) return
    setConversation((current) =>
      current.map((item, at) => (at === index ? { ...item, helpful } : item)),
    )
    rate.mutate({ index, askId: exchange.reply.askId, helpful })
    setFocusId(
      helpful
        ? `ayuda-gracias-${index}`
        : exchange.reply.written
          ? `ayuda-origen-${index}`
          : `ayuda-enviar-${index}`,
    )
  }
  /** «Ninguna es lo que busco»: se ofrece enviarla y queda contado, sin frenar ni decir nada si no se pudo contar. */
  function noneFits(exchange: HelpExchange, index: number) {
    setConversation((current) =>
      current.map((item, at) => (at === index ? { ...item, noneFits: true } : item)),
    )
    // El botón desaparece: el foco pasa al texto que se enviaría.
    setFocusId(`ayuda-enviar-${index}`)
    const askId = exchange.reply?.askId
    if (askId)
      void fetcher(`${apiBase}/ask/${askId}/none`, { method: "POST" }).catch(() => undefined)
  }
  // Un solo envío para lo que no supo, para soporte y para un problema: siempre un caso para el equipo de la app.
  const send = useMutation({
    retry: false,
    mutationFn: (input: {
      index: number | null
      text: string
      kind: SupportKind
      screen: string
    }) =>
      fetcher(`${apiBase}/requests`, {
        method: "POST",
        body: JSON.stringify({ question: input.text, screen: input.screen, kind: input.kind }),
      }),
    onSuccess: (_data, input) => {
      if (input.index === null)
        setDirect((current) => (current ? { ...current, sent: true } : current))
      else
        setConversation((current) =>
          current.map((item, index) =>
            index === input.index ? { ...item, sent: "enviada" } : item,
          ),
        )
      onSent?.()
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
      const support = (
        event as CustomEvent<{ support?: string } | undefined>
      ).detail?.support?.trim()
      if (support) {
        setDirect({ kind: "pregunta", text: support, sent: false })
        setFocusId("ayuda-directo")
      }
    }
    window.addEventListener(OPEN_HELP_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_HELP_EVENT, onOpen)
  }, [])

  const words = { appName, peopleWord, placeWord }
  const directWords: Record<SupportKind, { title: string; label: string }> = {
    pregunta: { title: `Escribir a soporte de ${appName}`, label: `Tu mensaje para ${appName}` },
    problema: { title: "Reportar un problema", label: "Qué pasó" },
  }

  /** Lo que no supo responder y lo que respondió sin servir salen igual: la pregunta y lo que se envía con ella. */
  const sendExchange = (exchange: HelpExchange, index: number) => (
    <WhatIsSent
      id={`ayuda-enviar-${index}`}
      label="Tu pregunta · puedes cambiarla"
      initial={exchange.question}
      attached={exchange.attached}
      {...words}
      onSend={(text) =>
        send.mutateAsync({ index, text, kind: "pregunta", screen: exchange.screen })
      }
      onCancel={() =>
        setConversation((current) =>
          current.map((item, at) => (at === index ? { ...item, sent: "no" } : item)),
        )
      }
      cancelLabel="No, gracias"
    />
  )

  /** El mensaje a soporte se escribe en el cuerpo, bajo la conversación: su campo recibe el foco y queda a la vista. */
  function openDirect(kind: SupportKind) {
    setDirect({ kind, text: "", sent: false })
    setFocusId("ayuda-directo")
  }

  const title = screen.data?.title
  const attached = screen.data?.attached
  const started = exchanges.length > 0
  const last = exchanges[exchanges.length - 1]
  const close = () => setOpen(false)
  // Un solo aviso para el lector de pantalla con lo último que pasó, no la conversación entera.
  const live = !last
    ? ""
    : last.error
      ? last.error
      : last.reply
        ? `Respuesta lista. ${rename(spokenReply(last.reply))}`
        : "Pregunta enviada. Buscando en la guía…"
  const suggestions = (screen.data?.suggestions ?? []).map(rename)
  const suggestionButtons = suggestions.map((suggestion) => (
    <Suggestion
      key={suggestion}
      suggestion={suggestion}
      variant="outline"
      size="default"
      className="h-auto min-h-11 justify-start whitespace-normal rounded-full py-2 text-left text-primary sm:min-h-10"
      disabled={pending}
      onClick={askText}
    />
  ))

  return (
    <>
      <Button
        type="button"
        variant={open ? "default" : "outline"}
        className={cn(
          "elevated relative h-9 gap-2 rounded-full px-3",
          compact && "hidden",
          className,
        )}
        onClick={() => setOpen(!open)}
        aria-label={`Ayuda${unseen > 0 ? `, ${unseen} ${unseen === 1 ? "respuesta nueva" : "respuestas nuevas"}` : ""}`}
        aria-expanded={open}
      >
        <CircleHelp className="size-4" aria-hidden />
        <span className="hidden md:inline">Ayuda</span>
        {unseen > 0 ? (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground">
            {unseen}
          </span>
        ) : null}
      </Button>

      {open ? (
        // Se puede cerrar mientras busca: la respuesta llega igual a su pregunta y se ve al volver a abrir.
        <DetailDrawer
          open
          title="Ayuda"
          description={title ? `Estás en ${title}` : `Cómo usar ${appName}`}
          onClose={close}
          isSubmitting={send.isPending}
          footer={
            <div className="flex w-full min-w-0 flex-col gap-2">
              <askForm.AppField name="question">
                {(field) => (
                  <field.Control label="Tu pregunta" hideLabel id="ayuda-pregunta">
                    {(control) => (
                      <PromptInput
                        className="[&_[data-slot=input-group]]:border-input [&_[data-slot=input-group]]:bg-card"
                        // La caja es la de la pregunta (`useAppForm`): si no se pudo preguntar, lo escrito se queda.
                        // `root` es la caja: el foco va a su campo y el panel sabe que el envío se rechazó.
                        // `event.target`, no `currentTarget`: PromptInput espera antes de llamar y para entonces es nulo.
                        onSubmit={async (_message, event) => {
                          if (
                            !(await submitForm(askForm, { root: event.target as HTMLFormElement }))
                          )
                            throw new Error("La pregunta no se envió")
                        }}
                      >
                        <PromptInputTextarea
                          {...control.props}
                          rows={1}
                          maxLength={TEXT_MAX}
                          className="max-h-32 min-h-11"
                          // Quien abre Ayuda viene a preguntar. En el teléfono no: el teclado taparía lo que vino a leer.
                          // Tampoco si se abrió para ver un caso o escribir a soporte.
                          autoFocus={isMobile === false && !linkedCase && !direct}
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                          placeholder={
                            started ? "Escribe otra pregunta" : "Pregunta cómo hacer algo…"
                          }
                          aria-describedby={["ayuda-pregunta-nota", control.describedBy]
                            .filter(Boolean)
                            .join(" ")}
                        />
                        <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                          <PromptInputSubmit
                            className="size-11 rounded-xl sm:size-9"
                            aria-label="Preguntar"
                            disabled={pending}
                            aria-busy={pending}
                          >
                            <ArrowRight aria-hidden />
                          </PromptInputSubmit>
                        </InputGroupAddon>
                      </PromptInput>
                    )}
                  </field.Control>
                )}
              </askForm.AppField>
              <div className="flex flex-wrap items-center justify-between gap-x-3 text-[13px] sm:flex-col sm:items-start">
                {/* La pregunta la leen los modelos de Ariadna (el que elige la respuesta y el que la redacta), sin datos de la cuenta: que no lleve a nadie. */}
                <p id="ayuda-pregunta-nota" className="text-muted-foreground">
                  No escribas nombres de {peopleWord}.
                  <span className="hidden sm:inline">
                    {" "}
                    No cambia nada por ti y, si no sabe, te lo dice.
                  </span>
                </p>
                {(direct && !direct.sent) || supportMode ? null : (
                  <div className="flex flex-wrap items-center gap-x-4">
                    <Button
                      type="button"
                      variant="link"
                      className={`h-auto p-0 ${LINK}`}
                      onClick={() => openDirect("pregunta")}
                    >
                      <span className="sm:hidden">Escribir a soporte</span>
                      <span className="hidden sm:inline">Escribir a soporte de {appName}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className={`h-auto p-0 ${LINK}`}
                      onClick={() => openDirect("problema")}
                    >
                      Reportar un problema
                    </Button>
                    {renderGiveAccess ? (
                      <Button
                        type="button"
                        variant="link"
                        className={`h-auto p-0 ${LINK}`}
                        onClick={() => setGiving(true)}
                      >
                        Dar acceso a soporte
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          }
        >
          {/* Con preguntas hechas, los casos y las sugerencias quedan arriba: la última respuesta y la caja van juntas. */}
          <div className="flex flex-col gap-5 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
            {started ? null : (
              <p className="text-sm text-muted-foreground">
                Soy {HELP_NAME}, tu guía virtual de {appName}. Pregúntame dónde se configura algo,
                dónde se ve o si se puede hacer con el sistema. También por qué algo no te deja.
              </p>
            )}

            {giving && renderGiveAccess
              ? renderGiveAccess({ screen: pathname, onClose: () => setGiving(false) })
              : null}
            {renderCases({ initialCaseId: linkedCase })}
            {suggestions.length === 0 ? null : started ? (
              <details className="border-t pt-1">
                <summary className="min-h-11 cursor-pointer content-center text-[13px] font-bold text-muted-foreground sm:min-h-8">
                  En esta pantalla suelen preguntar
                </summary>
                <div className="mt-1 flex flex-col gap-1.5">{suggestionButtons}</div>
              </details>
            ) : (
              <section
                aria-label="En esta pantalla suelen preguntar"
                className="flex flex-col gap-1.5 border-t pt-3"
              >
                <h3 className="text-[13px] font-bold text-muted-foreground">
                  En esta pantalla suelen preguntar
                </h3>
                {suggestionButtons}
              </section>
            )}

            {started ? (
              <ol className="flex flex-col gap-4" aria-label="Preguntas y respuestas">
                {exchanges.map((exchange, index) => {
                  const reply = exchange.reply
                  const written = reply?.kind === "guia" ? reply.written : null
                  const picked =
                    exchange.picked === undefined ? undefined : reply?.answers[exchange.picked]
                  return (
                    <li
                      key={exchange.id}
                      id={index === exchanges.length - 1 ? LATEST_ID : undefined}
                      className="flex scroll-mt-1 flex-col gap-3"
                    >
                      <Message from="user" className="max-w-[86%]">
                        <MessageContent className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-primary group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-primary-foreground">
                          <p>
                            <span className="sr-only">Preguntaste: </span>
                            {exchange.question}
                          </p>
                        </MessageContent>
                      </Message>

                      {/* No pudo responder: la pregunta no se pierde, queda con el motivo y cómo volver a intentarlo. */}
                      {exchange.error ? (
                        <Answer>
                          <p>{exchange.error}</p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 self-start bg-card sm:min-h-9"
                            disabled={pending}
                            onClick={() => retry(exchange)}
                          >
                            Intentar de nuevo
                          </Button>
                        </Answer>
                      ) : null}

                      {!reply && !exchange.error ? (
                        <Shimmer as="p" className="text-sm font-semibold">
                          Buscando en la guía…
                        </Shimmer>
                      ) : null}

                      {reply?.kind === "charla" ? (
                        <Answer>
                          <p>{reply.say}</p>
                        </Answer>
                      ) : null}

                      {/* La redactada: lo que Ariadna escribió uniendo la guía y, debajo, cada texto del que sale. */}
                      {reply?.kind === "guia" && written ? (
                        <Answer>
                          <p className="whitespace-pre-wrap">{rename(written)}</p>
                          <p className="text-xs">
                            Redactado con la guía: {HELP_NAME} unió estas partes para responderte.
                          </p>
                          <AnswerVideos videos={shownVideos(reply.answers)} />
                          <Sources
                            defaultOpen
                            className="mb-0 flex flex-col gap-1 border-t border-primary/20 pt-2 text-sm text-primary-soft-foreground"
                          >
                            <SourcesTrigger
                              count={reply.answers.length}
                              className="min-h-11 text-xs font-bold sm:min-h-8"
                            >
                              De dónde sale
                              <ChevronDown aria-hidden className="size-3.5" />
                            </SourcesTrigger>
                            <SourcesContent className="mt-0 w-full gap-1">
                              {reply.answers.map((answer, at) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden ser de la misma pantalla; llegan en orden y no cambian.
                                <div
                                  key={`${answer.topicId}-${at}`}
                                  className="flex flex-col gap-1.5"
                                >
                                  <details>
                                    <summary className="min-h-11 cursor-pointer content-center font-semibold sm:min-h-8">
                                      {answer.where || "La guía del sistema"}
                                    </summary>
                                    <p className="whitespace-pre-wrap pb-1">
                                      {withDestination(rename(answer.text), answer.where)}
                                    </p>
                                  </details>
                                  {answer.restriction ? <p>{answer.restriction}</p> : null}
                                  {/* Dos textos de la misma pantalla: un solo «Llévame». */}
                                  {answer.path &&
                                  reply.answers.findIndex((other) => other.path === answer.path) ===
                                    at ? (
                                    <TakeMe to={answer.path} where={answer.where} onGo={close} />
                                  ) : null}
                                </div>
                              ))}
                            </SourcesContent>
                          </Sources>
                        </Answer>
                      ) : null}

                      {reply?.kind === "guia" && !written
                        ? reply.answers.map((answer, at) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden ser de la misma pantalla; llegan en orden y no cambian.
                            <Answer key={`${answer.topicId}-${at}`}>
                              <p className="whitespace-pre-wrap">
                                {withDestination(rename(answer.text), answer.where)}
                              </p>
                              {answer.restriction ? <p>{answer.restriction}</p> : null}
                              {answer.path ? (
                                <TakeMe to={answer.path} where={answer.where} onGo={close} />
                              ) : null}
                              <AnswerVideos videos={shownVideos(reply.answers, at)} />
                            </Answer>
                          ))
                        : null}

                      {reply?.kind === "estado" ? (
                        <Answer>
                          <p className="font-bold">Esto es lo que falta ahora:</p>
                          <ul className="flex flex-col gap-3">
                            {reply.blockers.map((blocker) => (
                              <li key={blocker.text} className="flex flex-col gap-1.5">
                                <span>{blocker.text}</span>
                                {blocker.where ? (
                                  <span>
                                    Se resuelve en{" "}
                                    <strong className="font-bold">{blocker.where}</strong>
                                    {blocker.path
                                      ? "."
                                      : `; pídeselo a quien administra la ${placeWord}.`}
                                  </span>
                                ) : null}
                                {blocker.path && blocker.where ? (
                                  <TakeMe to={blocker.path} where={blocker.where} onGo={close} />
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </Answer>
                      ) : null}

                      {reply &&
                      (reply.kind === "nada" || (reply.kind === "duda" && exchange.noneFits)) ? (
                        <>
                          <Answer>
                            <p className="font-bold">
                              {reply.kind === "duda"
                                ? "No encontré tu respuesta en la guía."
                                : (reply.say ?? "Esto no está en la guía, y no quiero inventarlo.")}
                            </p>
                            {exchange.sent === undefined ? (
                              <p>¿Lo envío a {appName} para que te respondan?</p>
                            ) : null}
                          </Answer>
                          {exchange.sent === "enviada" ? (
                            <p role="status" className="text-sm font-semibold">
                              {SENT}
                            </p>
                          ) : exchange.sent === "no" ? null : (
                            sendExchange(exchange, index)
                          )}
                        </>
                      ) : null}

                      {/* La duda: las respuestas de la guía más parecidas. Tocar una la pregunta tal cual, sin modelo. */}
                      {reply?.kind === "duda" && !exchange.noneFits ? (
                        <Answer>
                          <p className="font-bold">{reply.say}</p>
                          <ul className="flex flex-col gap-1.5">
                            {reply.choices.map((choice) => (
                              <li key={choice.question}>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0.5 whitespace-normal bg-card py-2 text-left sm:min-h-10"
                                  disabled={pending}
                                  onClick={() => askText(rename(choice.question))}
                                >
                                  <span className="font-semibold text-primary">
                                    {rename(choice.question)}
                                  </span>
                                  {choice.where ? (
                                    <span className="text-xs font-normal text-muted-foreground">
                                      En {choice.where}
                                    </span>
                                  ) : null}
                                </Button>
                              </li>
                            ))}
                          </ul>
                          <Button
                            type="button"
                            variant="link"
                            className={`h-auto self-start p-0 ${LINK}`}
                            onClick={() => noneFits(exchange, index)}
                          >
                            Ninguna es lo que busco
                          </Button>
                        </Answer>
                      ) : null}

                      {/* Las cifras no son de la guía: las responde el agente de las cifras de la app, si el rol lo ve y está encendido. */}
                      {reply?.kind === "datos" ? (
                        <Answer>
                          <p>{reply.say}</p>
                          {reply.argos && dataAgent ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                className="min-h-11 self-start sm:min-h-9"
                                onClick={() => {
                                  setOpen(false)
                                  dataAgent.ask(exchange.question)
                                }}
                              >
                                Preguntarle a {dataAgent.name}
                              </Button>
                              {reply.argosNote ? (
                                <p className="text-xs text-muted-foreground">{reply.argosNote}</p>
                              ) : null}
                            </>
                          ) : null}
                          {reply.answers.map((answer) =>
                            answer.path ? (
                              <TakeMe
                                key={answer.topicId}
                                to={answer.path}
                                where={answer.where}
                                onGo={close}
                              />
                            ) : null,
                          )}
                        </Answer>
                      ) : null}

                      {reply?.kind === "guia" || reply?.kind === "estado" ? (
                        <>
                          {/* En la redactada, «De dónde sale» ya lo dice. */}
                          {written ? null : (
                            <div className="flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm">
                              <p className="text-xs font-bold text-muted-foreground">
                                En qué se basó
                              </p>
                              <p>{reply.basedOn}</p>
                            </div>
                          )}
                          {exchange.helpful === undefined ? (
                            <fieldset
                              className="m-0 flex min-w-0 items-center gap-2 border-0 p-0 text-sm"
                              aria-label="¿Te sirvió?"
                            >
                              <span className="flex-1 font-semibold">¿Te sirvió?</span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="min-h-11 px-4 sm:min-h-9"
                                onClick={() => answerHelpful(exchange, index, true)}
                              >
                                Sí
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="min-h-11 px-4 sm:min-h-9"
                                onClick={() => answerHelpful(exchange, index, false)}
                              >
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
                            // Recibe el foco al decir «Sí»: los botones desaparecen y aquí se lee que quedó anotado.
                            <p
                              id={`ayuda-gracias-${index}`}
                              tabIndex={-1}
                              className="text-sm text-muted-foreground outline-none"
                            >
                              {exchange.helpful
                                ? "Gracias. Lo anotamos."
                                : "Gracias. Lo anotamos para mejorar la guía."}
                            </p>
                          )}
                          {/* La redactada no sirvió: quizá uno solo de sus textos era la respuesta. Se eligen antes de ofrecer el envío. */}
                          {written && exchange.helpful === false && !exchange.noneFits ? (
                            <Answer>
                              <p
                                id={`ayuda-origen-${index}`}
                                tabIndex={-1}
                                className="font-bold outline-none"
                              >
                                La armé con estas partes de la guía. ¿Es alguna de estas?
                              </p>
                              <ul className="flex flex-col gap-1.5">
                                {reply.answers.map((answer: HelpAnswer, at) => (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: llegan en orden y no cambian.
                                  <li key={`${answer.topicId}-${at}`}>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      aria-pressed={exchange.picked === at}
                                      className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0.5 whitespace-normal bg-card py-2 text-left sm:min-h-10"
                                      onClick={() => {
                                        setConversation((current) =>
                                          current.map((item, position) =>
                                            position === index ? { ...item, picked: at } : item,
                                          ),
                                        )
                                        setFocusId(`ayuda-elegida-${index}`)
                                      }}
                                    >
                                      <span className="font-semibold text-primary">
                                        {answer.where || "La guía del sistema"}
                                      </span>
                                      <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
                                        {rename(answer.text)}
                                      </span>
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                              {picked ? (
                                // El texto de la guía tal cual, sin volver a preguntar: recibe el foco al elegirlo.
                                <div
                                  id={`ayuda-elegida-${index}`}
                                  tabIndex={-1}
                                  className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-foreground outline-none"
                                >
                                  <p className="whitespace-pre-wrap">
                                    {withDestination(rename(picked.text), picked.where)}
                                  </p>
                                  {picked.restriction ? <p>{picked.restriction}</p> : null}
                                  {picked.path ? (
                                    <TakeMe to={picked.path} where={picked.where} onGo={close} />
                                  ) : null}
                                </div>
                              ) : null}
                              <Button
                                type="button"
                                variant="link"
                                className={`h-auto self-start p-0 ${LINK}`}
                                onClick={() => noneFits(exchange, index)}
                              >
                                Ninguna es lo que busco
                              </Button>
                            </Answer>
                          ) : null}
                          {/* Si no le sirvió, no se queda sin salida: la misma vía que lo que no supo responder. */}
                          {exchange.helpful === false && (!written || exchange.noneFits) ? (
                            exchange.sent === "enviada" ? (
                              <p role="status" className="text-sm font-semibold">
                                {SENT}
                              </p>
                            ) : exchange.sent === "no" ? null : (
                              <>
                                <p className="text-sm font-semibold">
                                  ¿Lo envío a {appName} para que te respondan?
                                </p>
                                {sendExchange(exchange, index)}
                              </>
                            )
                          ) : null}
                        </>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            ) : null}

            {direct?.sent ? (
              <p role="status" className="text-sm font-semibold">
                {SENT}
              </p>
            ) : direct ? (
              <section
                aria-label={directWords[direct.kind].title}
                className="flex flex-col gap-2 border-t pt-3.5"
              >
                <h3 className="text-sm font-semibold">{directWords[direct.kind].title}</h3>
                <WhatIsSent
                  key={`${direct.kind}:${direct.text}`}
                  id="ayuda-directo"
                  label={directWords[direct.kind].label}
                  initial={direct.text}
                  attached={attached}
                  {...words}
                  onSend={(text) =>
                    send.mutateAsync({ index: null, text, kind: direct.kind, screen: pathname })
                  }
                  onCancel={() => setDirect(null)}
                  cancelLabel="Cancelar"
                />
              </section>
            ) : null}

            {last ? (
              <LatestInView
                at={`${last.id}:${last.reply ? "respuesta" : last.error ? "error" : "espera"}`}
                // Quien abre por un caso (el enlace del correo, una respuesta sin leer) o para escribir a soporte empieza ahí, no en la conversación.
                onOpen={!linkedCase && unseen === 0 && !direct}
              />
            ) : null}
            <p role="status" className="sr-only">
              {live}
            </p>
          </div>
        </DetailDrawer>
      ) : null}
    </>
  )
}

/** Lo que dice Ariadna: un `Message` de la asistente con la burbuja suave de la marca. */
function Answer({ children }: { children: ReactNode }) {
  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent
        className={cn(
          ANSWER,
          "w-full overflow-visible group-[.is-assistant]:text-primary-soft-foreground",
        )}
      >
        {children}
      </MessageContent>
    </Message>
  )
}
