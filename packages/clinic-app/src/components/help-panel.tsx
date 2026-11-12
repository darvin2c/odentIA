import { Button, buttonVariants, cn, InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, Textarea, useIsMobile } from "@odentia/ui"
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
import { ArrowRight, CircleHelp, ExternalLink, LoaderCircle } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../lib/api"
import { ADMIN_NAME, HELP_NAME, useReceptionName, withReceptionName } from "../lib/agent-names"
import { openArgos } from "../lib/argos"
import { ASK_HELP_EVENT } from "../lib/global-search"
import { casesEnvelope, SupportCasesSection } from "./support-cases"
import { GiveSupportAccess } from "./support-access"
import { useMyRole, useSupportMode } from "../lib/crm"
import { appWords } from "../lib/product-words"

const helpAnswer = z.object({
  topicId: z.string(),
  where: z.string(),
  text: z.string(),
  path: z.string().nullable(),
  restriction: z.string().nullable(),
  /** Los videos de esa respuesta, si los tiene; un servidor que aún no los entrega no manda el campo. */
  videos: z.array(z.object({ title: z.string(), url: z.string(), minutes: z.number().nullable() })).optional(),
})
type HelpAnswer = z.infer<typeof helpAnswer>
type HelpVideo = NonNullable<HelpAnswer["videos"]>[number]

export const helpReply = z.object({
  askId: z.string(),
  kind: z.enum(["guia", "estado", "duda", "nada", "datos", "charla"]),
  say: z.string().nullable().optional(),
  /** `guia` redactada: lo que Ariadna escribió uniendo `answers`. Sin ella (o de un servidor anterior), la guía tal cual. */
  written: z.string().nullable().optional(),
  answers: z.array(helpAnswer),
  blockers: z.array(z.object({ text: z.string(), where: z.string().nullable(), path: z.string().nullable() })),
  /** La duda: respuestas de la guía para elegir; tocar una la pregunta tal cual, sin modelo. */
  choices: z.array(z.object({ question: z.string(), where: z.string() })).default([]),
  /** Lo de las cifras: si puede preguntárselo a Argos. */
  argos: z.boolean().default(false),
  /** Lo que cuesta preguntarle a Argos, dicho por el servidor como está hoy. */
  argosNote: z.string().nullable().default(null),
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
  id: number
  question: string
  /** Dónde se preguntó: la conversación sigue al navegar y lo que se envía después dice esa pantalla. */
  screen: string
  attached: HelpAttachments | undefined
  /** Nula mientras se espera (o si no se pudo): la pregunta se ve desde que se envía. */
  reply: HelpReply | null
  /** Por qué no se pudo responder; con «Intentar de nuevo». */
  error: string | null
  /** Cuándo llegó la respuesta: una pregunta de seguimiento solo se entiende con una reciente. */
  answeredAt: number | null
  /** Lo que la persona dijo de la respuesta, si ya lo dijo. */
  helpful?: boolean
  /** Ya la envió a odentIA, o dijo que no. */
  sent?: "enviada" | "no"
  /** Dijo que ninguna era lo que buscaba (en la duda o entre los textos de una redactada): se ofrece enviarla. */
  noneFits?: boolean
  /** La redactada no sirvió y eligió uno de sus textos de origen: se muestra tal cual. */
  picked?: number
}

/** La pregunta anterior que viaja con una de seguimiento («¿y cómo la creo?»). */
interface HelpPrevious {
  question: string
  where: string | null
}

/** Pasado este tiempo, una pregunta ya no es de seguimiento: viaja sola. */
export const FOLLOW_UP_MS = 10 * 60_000

/**
 * Lo anterior que acompaña a la pregunta nueva, sin ningún control: solo si lo
 * último que se respondió fue una respuesta de verdad (`guia` o `estado`), es
 * reciente y la persona no dijo que no le sirvió. Tras una duda, un «no está»,
 * las cifras o un saludo no viaja nada: arrastraría un tema que no se respondió.
 */
export function previousOf(
  exchanges: ReadonlyArray<Pick<Exchange, "question" | "reply" | "answeredAt" | "helpful">>,
  now: number,
): HelpPrevious | undefined {
  const last = exchanges.findLast((item) => item.reply !== null)
  if (!last?.reply || last.answeredAt === null) return undefined
  if (last.reply.kind !== "guia" && last.reply.kind !== "estado") return undefined
  if (last.helpful === false || now - last.answeredAt >= FOLLOW_UP_MS) return undefined
  return { question: last.question, where: last.reply.answers[0]?.where || null }
}

/** Por qué no respondió: el motivo que da el servidor, o que ahora no se pudo. */
function askErrorMessage(error: unknown): string {
  return error instanceof ApiError && !isUnconfirmedSubmit(error) ? submitErrorMessage(error) : "No pude responder ahora. Vuelve a intentarlo."
}

/** Lo que el aviso del lector de pantalla dice de una respuesta. */
function spokenReply(reply: HelpReply): string {
  if (reply.kind === "guia") return reply.written ?? reply.answers.map((answer) => answer.text).join(" ")
  if (reply.kind === "estado") return `Esto es lo que falta ahora: ${reply.blockers.map((blocker) => blocker.text).join(" ")}`
  return reply.say ?? "Esto no está en la guía, y no quiero inventarlo."
}

/** Videos a la vista por pregunta: dos como mucho, sumando los de todos sus textos. */
const VIDEOS_SHOWN = 2
const videosOf = (answer: HelpAnswer) => (answer.videos ?? []).filter((video) => /^https:\/\//i.test(video.url))
/** Los videos que se muestran: los de un texto (`at`) sin pasar el tope de la pregunta, o los de todos juntos. */
function shownVideos(answers: readonly HelpAnswer[], at?: number): HelpVideo[] {
  // Un mismo video puede estar unido a dos respuestas que se muestran juntas: sale una vez.
  const once = (videos: HelpVideo[]) => videos.filter((video, index) => videos.findIndex((other) => other.url === video.url) === index)
  if (at === undefined) return once(answers.flatMap(videosOf)).slice(0, VIDEOS_SHOWN)
  const before = once(answers.slice(0, at).flatMap(videosOf))
  const answer = answers[at]
  if (!answer) return []
  return once(videosOf(answer))
    .filter((video) => !before.some((other) => other.url === video.url))
    .slice(0, Math.max(0, VIDEOS_SHOWN - before.length))
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
let lastExchangeId = 0
const newExchangeId = () => ++lastExchangeId
const patchExchange = (id: number, patch: Partial<Exchange>) => setConversation((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))

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
 * Abre la ayuda desde fuera del botón (el menú «⋯» del teléfono). Con
 * `detail.support` abre ya el mensaje a soporte con ese texto escrito, para
 * que la persona lo lea, lo complete y lo envíe ella (`openSupportRequest`).
 */
export const OPEN_HELP_EVENT = "odentia:abrir-ayuda"

/** Abre la ayuda con un mensaje a soporte ya escrito; no se envía solo. */
export function openSupportRequest(text: string) {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { support: text } }))
}

/** «Llévame» dice a dónde: el destino va escrito en el botón, no solo resaltado en el texto. */
function TakeMe({ to, where, onGo }: { to: string; where: string; onGo: () => void }) {
  return (
    <Link to={to} className={cn(buttonVariants({ size: "sm" }), "h-auto min-h-11 self-start whitespace-normal py-1.5 text-left sm:min-h-9")} onClick={onGo}>
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
          <a href={video.url} target="_blank" rel="noreferrer" className={cn(LINK, "gap-1.5 text-left")}>
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

/**
 * Trae a la vista la última pregunta con lo que tenga debajo: al enviarla, al
 * llegar su respuesta y al volver a abrir el panel. Vive dentro del panel para
 * correr cuando su contenido ya está en la página.
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
const LATEST_ID = "ayuda-ultima"

/**
 * «Ayuda» en la cabecera de todas las pantallas, para todo el equipo. Dice
 * dónde está cada cosa y lleva hasta ahí, qué se puede hacer y por qué algo
 * no se puede. No cambia nada: explica. Si no sabe, lo dice y ofrece enviarlo
 * a odentIA. Es una conversación: la caja queda fija al pie, la pregunta se ve
 * al enviarla y lo nuevo se trae a la vista (el molde de Argos).
 */
export function HelpButton({ className }: { className?: string } = {}) {
  const receptionName = useReceptionName()
  const compact = useHeaderCompact()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const [open, setOpen] = useState(false)
  // El correo «Soporte de odentIA respondió tu caso» abre aquí: `?ayuda=casos&caso=<id>`.
  const [linkedCase, setLinkedCase] = useState<string | null>(null)
  const handledLink = useRef<string | null>(null)
  const exchanges = useConversation()
  const [direct, setDirect] = useState<DirectMessage | null>(null)
  // «Dar acceso a soporte»: el cuadro en el mismo panel, solo para quien puede darlo.
  const [giving, setGiving] = useState(false)
  const myRole = useMyRole()
  // Soporte mirando la clínica no da acceso a soporte (la API lo rechaza igual).
  const canGiveAccess = (myRole === "owner" || myRole === "admin") && !useSupportMode()
  /** Lo que recibe el foco cuando aparece, porque el control que se tocó desaparece (WCAG 2.4.3). */
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    if (focusId === null) return
    document.getElementById(focusId)?.focus()
    setFocusId(null)
  }, [focusId])

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

  // La respuesta llega a su pregunta aunque el panel se haya cerrado o se haya cambiado de pantalla.
  const ask = useMutation({
    retry: false,
    mutationFn: (input: { id: number; body: { question: string; screen: string; previous?: HelpPrevious } }) =>
      apiFetch("/api/help/ask", { method: "POST", body: JSON.stringify(input.body) }).then((body: unknown) => askEnvelope.parse(body).data),
    onSuccess: (reply, input) => patchExchange(input.id, { reply, answeredAt: Date.now() }),
    onError: (error, input) => patchExchange(input.id, { error: askErrorMessage(error) }),
  })
  // Se espera de una en una; lo dice la conversación, no este botón: otra pantalla monta otro y la espera sigue.
  const pending = exchanges.some((item) => item.reply === null && item.error === null)
  /** La pregunta se ve enseguida, con su espera debajo; la respuesta (o el motivo) llega a ella. */
  function push(question: string) {
    const id = newExchangeId()
    const previous = previousOf(exchanges, Date.now())
    setConversation((current) => [...current, { id, question, screen: pathname, attached: screen.data?.attached, reply: null, error: null, answeredAt: null }])
    ask.mutate({ id, body: { question, screen: pathname, ...(previous ? { previous } : {}) } })
  }
  /** La misma pregunta, en su misma burbuja y con la pantalla donde se hizo. */
  function retry(exchange: Exchange) {
    const previous = previousOf(exchanges.filter((item) => item.id !== exchange.id), Date.now())
    patchExchange(exchange.id, { error: null })
    ask.mutate({ id: exchange.id, body: { question: exchange.question, screen: exchange.screen, ...(previous ? { previous } : {}) } })
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
  const onAskSubmit = useFormSubmit(askForm)
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
      apiFetch(`/api/help/ask/${input.askId}/feedback`, { method: "POST", body: JSON.stringify({ helpful: input.helpful }) }),
    // No quedó anotado: vuelve a preguntarse y se dice por qué.
    onError: (_error, input) => setConversation((current) => current.map((item, index) => (index === input.index ? { ...item, helpful: undefined } : item))),
  })
  /** «¿Te sirvió?»: se anota enseguida y el foco pasa a lo que aparece en lugar de los botones. */
  function answerHelpful(exchange: Exchange, index: number, helpful: boolean) {
    if (!exchange.reply) return
    setConversation((current) => current.map((item, at) => (at === index ? { ...item, helpful } : item)))
    rate.mutate({ index, askId: exchange.reply.askId, helpful })
    setFocusId(helpful ? `ayuda-gracias-${index}` : exchange.reply.written ? `ayuda-origen-${index}` : `ayuda-enviar-${index}`)
  }
  /** «Ninguna es lo que busco»: se ofrece enviarla y queda contado, sin frenar ni decir nada si no se pudo contar. */
  function noneFits(exchange: Exchange, index: number) {
    setConversation((current) => current.map((item, at) => (at === index ? { ...item, noneFits: true } : item)))
    // El botón desaparece: el foco pasa al texto que se enviaría.
    setFocusId(`ayuda-enviar-${index}`)
    const askId = exchange.reply?.askId
    if (askId) void apiFetch(`/api/help/ask/${askId}/none`, { method: "POST" }).catch(() => undefined)
  }
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
      if (support) {
        setDirect({ kind: "pregunta", text: support, sent: false })
        setFocusId("ayuda-directo")
      }
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
        ? `Respuesta lista. ${withReceptionName(spokenReply(last.reply), receptionName)}`
        : "Pregunta enviada. Buscando en la guía…"
  const suggestions = (screen.data?.suggestions ?? []).map((suggestion) => withReceptionName(suggestion, receptionName))
  const suggestionButtons = suggestions.map((suggestion) => (
    <Button
      key={suggestion}
      type="button"
      variant="outline"
      className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left text-primary sm:min-h-10"
      disabled={pending}
      onClick={() => askText(suggestion)}
    >
      {suggestion}
    </Button>
  ))

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
        // Se puede cerrar mientras busca: la respuesta llega igual a su pregunta y se ve al volver a abrir.
        <DetailDrawer
          open
          title="Ayuda"
          description={title ? `Estás en ${title}` : `Cómo usar ${appWords().name}`}
          onClose={close}
          isSubmitting={send.isPending}
          footer={
            <div className="flex w-full min-w-0 flex-col gap-2">
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
                            // Quien abre Ayuda viene a preguntar. En el teléfono no: el teclado taparía lo que vino a leer.
                            // Tampoco si se abrió para ver un caso o escribir a soporte.
                            autoFocus={isMobile === false && !linkedCase && !direct}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault()
                                event.currentTarget.form?.requestSubmit()
                              }
                            }}
                            placeholder={started ? "Escribe otra pregunta" : "Pregunta cómo hacer algo…"}
                            aria-describedby={["ayuda-pregunta-nota", control.describedBy].filter(Boolean).join(" ")}
                          />
                          <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                            <InputGroupButton
                              type="submit"
                              variant="default"
                              size="icon-sm"
                              className="size-11 rounded-xl sm:size-9"
                              aria-label="Preguntar"
                              disabled={pending}
                              aria-busy={pending}
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
              <div className="flex flex-wrap items-center justify-between gap-x-3 text-[13px] sm:flex-col sm:items-start">
                {/* La pregunta la leen los modelos de odentIA (el que elige la respuesta y el que la redacta), sin datos de la clínica: que no lleve a nadie. */}
                <p id="ayuda-pregunta-nota" className="text-muted-foreground">
                  No escribas nombres de pacientes.<span className="hidden sm:inline"> No cambia nada por ti y, si no sabe, te lo dice.</span>
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
                    {canGiveAccess ? (
                      <Button type="button" variant="link" className={`h-auto p-0 ${LINK}`} onClick={() => setGiving(true)}>
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
                Soy {HELP_NAME}, tu guía virtual de {appWords().name}. Pregúntame dónde se configura algo, dónde se ve o si se puede hacer con el sistema. También por qué algo no te deja.
              </p>
            )}

            {giving ? <GiveSupportAccess screen={pathname} onClose={() => setGiving(false)} /> : null}
            <SupportCasesSection initialCaseId={linkedCase} />
            {suggestions.length === 0 ? null : started ? (
              <details className="border-t pt-1">
                <summary className="min-h-11 cursor-pointer content-center text-[13px] font-bold text-muted-foreground sm:min-h-8">En esta pantalla suelen preguntar</summary>
                <div className="mt-1 flex flex-col gap-1.5">{suggestionButtons}</div>
              </details>
            ) : (
              <section aria-label="En esta pantalla suelen preguntar" className="flex flex-col gap-1.5 border-t pt-3">
                <h3 className="text-[13px] font-bold text-muted-foreground">En esta pantalla suelen preguntar</h3>
                {suggestionButtons}
              </section>
            )}

            {started ? (
              <ol className="flex flex-col gap-4" aria-label="Preguntas y respuestas">
                {exchanges.map((exchange, index) => {
                  const reply = exchange.reply
                  const written = reply?.kind === "guia" ? reply.written : null
                  const picked = exchange.picked === undefined ? undefined : reply?.answers[exchange.picked]
                  return (
                    <li key={exchange.id} id={index === exchanges.length - 1 ? LATEST_ID : undefined} className="flex scroll-mt-1 flex-col gap-3">
                      <p className="max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
                        <span className="sr-only">Preguntaste: </span>
                        {exchange.question}
                      </p>

                      {/* No pudo responder: la pregunta no se pierde, queda con el motivo y cómo volver a intentarlo. */}
                      {exchange.error ? (
                        <div className={ANSWER}>
                          <p>{exchange.error}</p>
                          <Button type="button" variant="outline" size="sm" className="min-h-11 self-start bg-card sm:min-h-9" disabled={pending} onClick={() => retry(exchange)}>
                            Intentar de nuevo
                          </Button>
                        </div>
                      ) : null}

                      {!reply && !exchange.error ? (
                        <p className="flex items-center gap-2 text-sm font-semibold text-primary-soft-foreground">
                          <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                          Buscando en la guía…
                        </p>
                      ) : null}

                      {reply?.kind === "charla" ? (
                        <div className={ANSWER}>
                          <p>{reply.say}</p>
                        </div>
                      ) : null}

                      {/* La redactada: lo que Ariadna escribió uniendo la guía y, debajo, cada texto del que sale. */}
                      {reply?.kind === "guia" && written ? (
                        <div className={ANSWER}>
                          <p className="whitespace-pre-wrap">{withReceptionName(written, receptionName)}</p>
                          <p className="text-xs">Redactado con la guía: {HELP_NAME} unió estas partes para responderte.</p>
                          <AnswerVideos videos={shownVideos(reply.answers)} />
                          <section aria-label="De dónde sale" className="flex flex-col gap-1 border-t border-primary/20 pt-2">
                            <h3 className="text-xs font-bold">De dónde sale</h3>
                            {reply.answers.map((answer, at) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden ser de la misma pantalla; llegan en orden y no cambian.
                              <div key={`${answer.topicId}-${at}`} className="flex flex-col gap-1.5">
                                <details>
                                  <summary className="min-h-11 cursor-pointer content-center font-semibold sm:min-h-8">{answer.where || "La guía del sistema"}</summary>
                                  <p className="whitespace-pre-wrap pb-1">{withDestination(withReceptionName(answer.text, receptionName), answer.where)}</p>
                                </details>
                                {answer.restriction ? <p>{answer.restriction}</p> : null}
                                {/* Dos textos de la misma pantalla: un solo «Llévame». */}
                                {answer.path && reply.answers.findIndex((other) => other.path === answer.path) === at ? (
                                  <TakeMe to={answer.path} where={answer.where} onGo={close} />
                                ) : null}
                              </div>
                            ))}
                          </section>
                        </div>
                      ) : null}

                      {reply?.kind === "guia" && !written
                        ? reply.answers.map((answer, at) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden ser de la misma pantalla; llegan en orden y no cambian.
                            <div key={`${answer.topicId}-${at}`} className={ANSWER}>
                              <p className="whitespace-pre-wrap">{withDestination(withReceptionName(answer.text, receptionName), answer.where)}</p>
                              {answer.restriction ? <p>{answer.restriction}</p> : null}
                              {answer.path ? <TakeMe to={answer.path} where={answer.where} onGo={close} /> : null}
                              <AnswerVideos videos={shownVideos(reply.answers, at)} />
                            </div>
                          ))
                        : null}

                      {reply?.kind === "estado" ? (
                        <div className={ANSWER}>
                          <p className="font-bold">Esto es lo que falta ahora:</p>
                          <ul className="flex flex-col gap-3">
                            {reply.blockers.map((blocker) => (
                              <li key={blocker.text} className="flex flex-col gap-1.5">
                                <span>{blocker.text}</span>
                                {blocker.where ? (
                                  <span>
                                    Se resuelve en <strong className="font-bold">{blocker.where}</strong>
                                    {blocker.path ? "." : "; pídeselo a quien administra la clínica."}
                                  </span>
                                ) : null}
                                {blocker.path && blocker.where ? <TakeMe to={blocker.path} where={blocker.where} onGo={close} /> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {reply && (reply.kind === "nada" || (reply.kind === "duda" && exchange.noneFits)) ? (
                        <>
                          <div className={ANSWER}>
                            <p className="font-bold">
                              {reply.kind === "duda" ? "No encontré tu respuesta en la guía." : (reply.say ?? "Esto no está en la guía, y no quiero inventarlo.")}
                            </p>
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

                      {/* La duda: las respuestas de la guía más parecidas. Tocar una la pregunta tal cual, sin modelo. */}
                      {reply?.kind === "duda" && !exchange.noneFits ? (
                        <div className={ANSWER}>
                          <p className="font-bold">{reply.say}</p>
                          <ul className="flex flex-col gap-1.5">
                            {reply.choices.map((choice) => (
                              <li key={choice.question}>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0.5 whitespace-normal bg-card py-2 text-left sm:min-h-10"
                                  disabled={pending}
                                  onClick={() => askText(withReceptionName(choice.question, receptionName))}
                                >
                                  <span className="font-semibold text-primary">{withReceptionName(choice.question, receptionName)}</span>
                                  {choice.where ? <span className="text-xs font-normal text-muted-foreground">En {choice.where}</span> : null}
                                </Button>
                              </li>
                            ))}
                          </ul>
                          <Button type="button" variant="link" className={`h-auto self-start p-0 ${LINK}`} onClick={() => noneFits(exchange, index)}>
                            Ninguna es lo que busco
                          </Button>
                        </div>
                      ) : null}

                      {/* Las cifras de la clínica no son de la guía: las responde Argos, si el rol lo ve y está encendido. */}
                      {reply?.kind === "datos" ? (
                        <div className={ANSWER}>
                          <p>{reply.say}</p>
                          {reply.argos ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                className="min-h-11 self-start sm:min-h-9"
                                onClick={() => {
                                  setOpen(false)
                                  openArgos({ question: exchange.question, routed: true })
                                }}
                              >
                                Preguntarle a {ADMIN_NAME}
                              </Button>
                              {reply.argosNote ? <p className="text-xs text-muted-foreground">{reply.argosNote}</p> : null}
                            </>
                          ) : null}
                          {reply.answers.map((answer) => (answer.path ? <TakeMe key={answer.topicId} to={answer.path} where={answer.where} onGo={close} /> : null))}
                        </div>
                      ) : null}

                      {reply?.kind === "guia" || reply?.kind === "estado" ? (
                        <>
                          {/* En la redactada, «De dónde sale» ya lo dice. */}
                          {written ? null : (
                            <div className="flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm">
                              <p className="text-xs font-bold text-muted-foreground">En qué se basó</p>
                              <p>{reply.basedOn}</p>
                            </div>
                          )}
                          {exchange.helpful === undefined ? (
                            <fieldset className="m-0 flex min-w-0 items-center gap-2 border-0 p-0 text-sm" aria-label="¿Te sirvió?">
                              <span className="flex-1 font-semibold">¿Te sirvió?</span>
                              <Button type="button" variant="outline" size="sm" className="min-h-11 px-4 sm:min-h-9" onClick={() => answerHelpful(exchange, index, true)}>
                                Sí
                              </Button>
                              <Button type="button" variant="outline" size="sm" className="min-h-11 px-4 sm:min-h-9" onClick={() => answerHelpful(exchange, index, false)}>
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
                            <p id={`ayuda-gracias-${index}`} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
                              {exchange.helpful ? "Gracias. Lo anotamos." : "Gracias. Lo anotamos para mejorar la guía."}
                            </p>
                          )}
                          {/* La redactada no sirvió: quizá uno solo de sus textos era la respuesta. Se eligen antes de ofrecer el envío. */}
                          {written && exchange.helpful === false && !exchange.noneFits ? (
                            <div className={ANSWER}>
                              <p id={`ayuda-origen-${index}`} tabIndex={-1} className="font-bold outline-none">
                                La armé con estas partes de la guía. ¿Es alguna de estas?
                              </p>
                              <ul className="flex flex-col gap-1.5">
                                {reply.answers.map((answer, at) => (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: llegan en orden y no cambian.
                                  <li key={`${answer.topicId}-${at}`}>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      aria-pressed={exchange.picked === at}
                                      className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0.5 whitespace-normal bg-card py-2 text-left sm:min-h-10"
                                      onClick={() => {
                                        setConversation((current) => current.map((item, position) => (position === index ? { ...item, picked: at } : item)))
                                        setFocusId(`ayuda-elegida-${index}`)
                                      }}
                                    >
                                      <span className="font-semibold text-primary">{answer.where || "La guía del sistema"}</span>
                                      <span className="line-clamp-2 text-xs font-normal text-muted-foreground">{withReceptionName(answer.text, receptionName)}</span>
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                              {picked ? (
                                // El texto de la guía tal cual, sin volver a preguntar: recibe el foco al elegirlo.
                                <div id={`ayuda-elegida-${index}`} tabIndex={-1} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-foreground outline-none">
                                  <p className="whitespace-pre-wrap">{withDestination(withReceptionName(picked.text, receptionName), picked.where)}</p>
                                  {picked.restriction ? <p>{picked.restriction}</p> : null}
                                  {picked.path ? <TakeMe to={picked.path} where={picked.where} onGo={close} /> : null}
                                </div>
                              ) : null}
                              <Button type="button" variant="link" className={`h-auto self-start p-0 ${LINK}`} onClick={() => noneFits(exchange, index)}>
                                Ninguna es lo que busco
                              </Button>
                            </div>
                          ) : null}
                          {/* Si no le sirvió, no se queda sin salida: la misma vía que lo que no supo responder. */}
                          {exchange.helpful === false && (!written || exchange.noneFits) ? (
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
                  )
                })}
              </ol>
            ) : null}

            {direct?.sent ? (
              <p role="status" className="text-sm font-semibold">
                {SENT}
              </p>
            ) : direct ? (
              <section aria-label={DIRECT[direct.kind].title} className="flex flex-col gap-2 border-t pt-3.5">
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

            {last ? (
              <LatestInView
                at={`${last.id}:${last.reply ? "respuesta" : last.error ? "error" : "espera"}`}
                // Quien abre por un caso (el enlace del correo, una respuesta sin leer) o para escribir a soporte empieza ahí, no en la conversación.
                onOpen={!linkedCase && unseen.length === 0 && !direct}
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
