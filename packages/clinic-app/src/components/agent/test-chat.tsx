import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
} from "@odentia/ui"
import { DataRefreshMarker } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, CircleAlert, CircleCheck, Ellipsis, SendHorizontal, X } from "lucide-react"
import { type FormEvent, Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import {
  ANSWER_CHECK_LABEL,
  type ProbarCreated,
  type ProbarState,
  type ProbarTurn,
  type TestCaseItem,
} from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError, apiFetch } from "../../lib/api"
import { appWords } from "../../lib/product-words"
import { mutationErrorMessage } from "../../lib/query-error"

/** Los mensajes para empezar, con lo que se pide en el producto de la app. */
const starters = () => [
  { label: "Quiere una cita", text: `Hola, quiero una cita para ${appWords().examples.service}.` },
  { label: "Pregunta un precio", text: `Hola, ¿cuánto cuesta ${appWords().examples.service}?` },
  { label: "Se queja", text: "Llevo una hora esperando y nadie me atiende. Qué mal servicio." },
  { label: "Pide una persona", text: "Prefiero hablar con una persona, por favor." },
]

const PROBAR_KEY = ["agent-probar"] as const
/** El campo de escribir: la página lo enfoca cuando «Probar» ya está a la vista. */
export const PROBAR_INPUT = "probar-mensaje"

/** Mientras el agente atiende, se mira seguido; si no, no hace falta. */
const POLL_MS = 1500

/**
 * «Probar» (ADR 0094): una conversación real con el agente, por el mismo
 * recorrido que el chat de la clínica, con una persona de prueba. Tiene la
 * forma de ese chat —cabecera de color, burbujas y la caja al pie— y debajo de
 * cada respuesta lo que hizo. Lo que el agente hace con el «sí» se crea de
 * verdad, marcado «Prueba», y se abre desde aquí. El contenedor (columna
 * lateral, cajón o pantalla) lo pone la página: esto llena su alto.
 */
export function AgentTestChat({
  titleId,
  onClose,
  closeLabel,
}: {
  titleId: string
  onClose?: () => void
  closeLabel?: string
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const [draft, setDraft] = useState("")
  /** Lo que se envió y aún no llegó de vuelta: se ve enseguida, como en cualquier chat. */
  const [sending, setSending] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const probar = useQuery({
    queryKey: PROBAR_KEY,
    queryFn: () => apiFetch<{ data: ProbarState }>("/api/agent/probar"),
    retry: false,
    refetchInterval: (query) => (query.state.data?.data.busy || sending ? POLL_MS : false),
  })
  const state = probar.data?.data
  const cases = useQuery({
    queryKey: ["agent-test-cases"],
    queryFn: () => apiFetch<{ data: TestCaseItem[] }>("/api/agent/learning/cases"),
    retry: false,
  })

  const send = useMutation({
    retry: false,
    mutationFn: (text: string) =>
      apiFetch("/api/agent/probar/messages", {
        method: "POST",
        body: JSON.stringify({ text, clientMessageId: crypto.randomUUID() }),
      }),
    onMutate: (text) => {
      setSending(text)
      setDraft("")
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PROBAR_KEY })
      void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
    },
    // El mensaje sin enviar vuelve al campo para reintentar.
    onError: (_error, text) => {
      setSending(null)
      setDraft(text)
    },
  })
  // «Lo probaste» cuenta las respuestas del modelo, que llegan después del envío:
  // con cada respuesta nueva se vuelve a pedir el resumen del agente.
  const answered = state?.turns.length ?? 0
  const seenAnswers = useRef(answered)
  useEffect(() => {
    if (answered > seenAnswers.current) void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
    seenAnswers.current = answered
  }, [answered, queryClient])
  // Lo enviado deja de verse aparte cuando ya es parte de la conversación.
  const lastFromPatient = state?.messages.filter((item) => item.from === "paciente").at(-1)?.text
  useEffect(() => {
    if (sending && lastFromPatient === sending) setSending(null)
  }, [sending, lastFromPatient])

  const restart = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: ProbarState }>("/api/agent/probar", { method: "DELETE" }),
    onSuccess: () => {
      setSending(null)
      queryClient.setQueryData(PROBAR_KEY, (old: { data: ProbarState } | undefined) =>
        old
          ? {
              data: {
                ...old.data,
                conversationId: null,
                deletesAt: null,
                messages: [],
                turns: [],
                waiting: [],
                created: [],
                typing: false,
                busy: false,
              },
            }
          : old,
      )
      // Lo que creó la prueba se fue con ella.
      void queryClient.invalidateQueries({ queryKey: ["appointments"] })
      inputRef.current?.focus()
    },
  })

  // Un caso de prueba se vuelve a responder sin conversación previa: la primera pregunta con su respuesta.
  const firstQuestion = state?.messages.find((item) => item.from === "paciente")
  const firstAnswer = firstQuestion
    ? state?.messages.find((item) => item.from === "sofi" && item.at >= firstQuestion.at)
    : undefined
  const saveCase = useMutation({
    retry: false,
    mutationFn: (input: { question: string; expected: string }) =>
      apiFetch<{ data: TestCaseItem }>("/api/agent/learning/cases", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      for (const key of ["agent-test-cases", "agent-learning"])
        void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })

  const messageCount = (state?.messages.length ?? 0) + (sending ? 1 : 0)
  const typing = Boolean(state?.typing || (sending && send.isSuccess))
  // La conversación sigue al último mensaje, como en cualquier chat.
  useEffect(() => {
    if (messageCount > 0 || typing) endRef.current?.scrollIntoView({ block: "end" })
  }, [messageCount, typing])

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || send.isPending || sending) return
    send.mutate(text)
  }

  const empty = !state || (state.messages.length === 0 && !sending)
  const error =
    send.error instanceof ApiError
      ? (send.error.shape.message ?? "No pudimos enviarlo")
      : send.error
        ? "No pudimos enviarlo. Vuelve a intentarlo."
        : restart.error
          ? mutationErrorMessage(restart.error)
          : null
  const saved = cases.data?.data.filter((item) => item.agent === "recepcion").length

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 bg-primary py-3 pr-2 pl-5 text-primary-foreground">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={titleId} className="font-heading text-base font-semibold">
            Probar
          </h2>
          <p className="text-sm opacity-90">Escribe como un paciente</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // En el teléfono va en «⋯»: la cabecera no da para el botón y el título.
          className="min-h-8 shrink-0 rounded-full border-primary-foreground/50 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground max-sm:hidden"
          disabled={empty || restart.isPending}
          onClick={() => restart.mutate()}
        >
          Empezar de nuevo
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground sm:size-8"
                aria-label="Más opciones de Probar"
              />
            }
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="sm:hidden"
              disabled={empty || restart.isPending}
              onClick={() => restart.mutate()}
            >
              Empezar de nuevo
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!firstQuestion || !firstAnswer || saveCase.isPending || saveCase.isSuccess}
              onClick={() => {
                if (firstQuestion && firstAnswer)
                  saveCase.mutate({ question: firstQuestion.text, expected: firstAnswer.text })
              }}
            >
              Guardar como caso de prueba
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={empty || restart.isPending}
              onClick={() => restart.mutate()}
            >
              Borrar esta prueba
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground sm:size-8"
            aria-label={closeLabel ?? "Cerrar Probar"}
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </header>
      <p
        role="note"
        className="shrink-0 bg-warning-soft px-4 py-2 text-center text-xs font-semibold"
      >
        Prueba · {receptionName} es real, pero no se envía nada y se borra en 7 días
      </p>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-h-full flex-col justify-end gap-2 px-4 py-3" aria-live="polite">
          {probar.isPending ? (
            <DataRefreshMarker message="Cargando la prueba…" />
          ) : probar.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(probar.error)}
            </p>
          ) : empty ? (
            <p className="m-auto max-w-64 text-center text-sm text-muted-foreground">
              {receptionName} te responde como a un paciente que escribe por el chat de tu sitio.
            </p>
          ) : state ? (
            <Conversation state={state} sending={sending} receptionName={receptionName} />
          ) : null}
          {typing ? <DataRefreshMarker message={`${receptionName} está respondiendo…`} /> : null}
          {saveCase.isSuccess ? (
            <p role="status" className="text-xs text-muted-foreground">
              Guardada como caso de prueba: «{saveCase.data.data.question}».{" "}
              {saved !== undefined
                ? `Tienes ${saved === 1 ? "1 caso" : `${saved} casos`}: con ellos se prueba una lección.`
                : null}
            </p>
          ) : null}
          {saveCase.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {mutationErrorMessage(saveCase.error)}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <footer className="flex shrink-0 flex-col gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {empty ? (
          <>
            <p className="text-xs text-muted-foreground">
              Empieza con un ejemplo o escribe el tuyo
            </p>
            <ScrollArea horizontal className="-mx-4 min-w-0">
              <fieldset
                className="relative m-0 flex min-w-0 gap-2 border-0 px-4 pb-1"
                aria-label="Ejemplos"
              >
                {starters().map((starter) => (
                  <Button
                    key={starter.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0 rounded-full sm:min-h-8"
                    disabled={send.isPending || Boolean(sending)}
                    onClick={() => send.mutate(starter.text)}
                  >
                    {starter.label}
                  </Button>
                ))}
              </fieldset>
            </ScrollArea>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor={PROBAR_INPUT} className="sr-only">
            Mensaje de prueba
          </label>
          <Input
            ref={inputRef}
            id={PROBAR_INPUT}
            value={draft}
            maxLength={2000}
            autoComplete="off"
            enterKeyHint="send"
            className="h-11 min-w-0 flex-1 rounded-full border-0 bg-muted px-4"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Escribe como paciente…"
          />
          <Button
            type="submit"
            size="icon"
            className="size-11 shrink-0 rounded-full"
            aria-label="Enviar el mensaje de prueba"
            disabled={!draft.trim() || send.isPending || Boolean(sending)}
          >
            <SendHorizontal aria-hidden />
          </Button>
        </form>
      </footer>
    </div>
  )
}

/**
 * La conversación en orden: los mensajes y lo que la prueba creó, cada cosa en
 * su momento; «Lo que hizo» va después de las respuestas a cada mensaje del
 * paciente, justo antes del siguiente.
 */
function Conversation({
  state,
  sending,
  receptionName,
}: {
  state: ProbarState
  sending: string | null
  receptionName: string
}) {
  const turnFor = new Map(state.turns.map((turn) => [turn.triggerMessageId, turn]))
  type Item = { at: string; key: string; node: ReactNode }
  const items: Item[] = []
  let pendingTurn: ProbarTurn | undefined
  const flushTurn = (at: string) => {
    if (pendingTurn)
      items.push({
        at,
        key: `turno-${pendingTurn.triggerMessageId}`,
        node: <TurnDetail turn={pendingTurn} />,
      })
    pendingTurn = undefined
  }
  let previousFrom: string | null = null
  for (const message of state.messages) {
    if (message.from === "paciente") {
      flushTurn(message.at)
      items.push({
        at: message.at,
        key: message.id,
        node: (
          <p className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
            <span className="sr-only">Paciente de prueba: </span>
            {message.text}
          </p>
        ),
      })
      const turn = turnFor.get(message.id)
      // En una ráfaga la corrida la dispara el último mensaje: lo que hizo va tras sus respuestas.
      if (turn) pendingTurn = turn
    } else {
      const author = message.from === "sofi" ? receptionName : "Tu equipo"
      items.push({
        at: message.at,
        key: message.id,
        node: (
          <div className="flex max-w-[88%] flex-col gap-1 self-start">
            {previousFrom !== message.from ? (
              <span className="px-1.5 text-xs text-muted-foreground">{author}</span>
            ) : null}
            <p className="whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] rounded-bl-md bg-muted px-3.5 py-2.5 text-sm">
              <span className="sr-only">{author}: </span>
              {message.text}
            </p>
          </div>
        ),
      })
    }
    previousFrom = message.from
  }
  for (const created of state.created)
    items.push({
      at: created.createdAt,
      key: created.appointmentId,
      node: <CreatedCard created={created} />,
    })
  items.sort((a, b) => a.at.localeCompare(b.at))
  const last = state.turns.at(-1)
  if (pendingTurn)
    items.push({
      at: "~",
      key: `turno-${pendingTurn.triggerMessageId}`,
      node: <TurnDetail turn={pendingTurn} waiting={pendingTurn === last ? state.waiting : []} />,
    })
  return (
    <>
      {items.map((item) => (
        <Fragment key={item.key}>{item.node}</Fragment>
      ))}
      {sending ? (
        <p className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground opacity-70">
          <span className="sr-only">Paciente de prueba, enviando: </span>
          {sending}
        </p>
      ) : null}
    </>
  )
}

/** La cita que la prueba reservó de verdad: se abre en la Agenda, donde se ve marcada «Prueba». */
function CreatedCard({ created }: { created: ProbarCreated }) {
  const when = new Intl.DateTimeFormat("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(created.timeZone ? { timeZone: created.timeZone } : {}),
  }).format(new Date(created.startsAt))
  const day = new Intl.DateTimeFormat(
    "en-CA",
    created.timeZone ? { timeZone: created.timeZone } : {},
  ).format(new Date(created.startsAt))
  const cancelled = created.status === "cancelada"
  return (
    <div className="flex items-center gap-3 self-stretch rounded-xl border bg-card px-3 py-2.5 text-sm">
      <CircleCheck
        className={`size-4 shrink-0 ${cancelled ? "text-muted-foreground" : "text-success"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">
          {cancelled ? "Canceló la cita de prueba" : "Reservó la cita de prueba"}
        </span>
        <span className="block text-xs text-muted-foreground">
          {when} · {created.professionalName}
        </span>
      </span>
      <Button
        size="sm"
        className="min-h-11 shrink-0 rounded-full sm:min-h-8"
        render={
          <Link
            to="/agenda"
            search={{ appointmentId: created.appointmentId, date: day, branch: undefined }}
          />
        }
      >
        Ver en la Agenda
      </Button>
    </div>
  )
}

/**
 * Debajo de las respuestas a cada mensaje: lo que hizo, en qué se basó y lo
 * que espera, plegado para que se siga la conversación. Lo que cambia lo que
 * recibió el paciente (no salió, pasó a una persona, un dato que no coincide)
 * queda siempre a la vista.
 */
function TurnDetail({
  turn,
  waiting = [],
}: {
  turn: ProbarTurn
  waiting?: ProbarState["waiting"]
}) {
  const receptionName = useReceptionName()
  const sent = turn.answers.filter(
    (answer) => answer.outcome === "enviada" || answer.outcome === "pendiente",
  )
  const blocked = turn.answers.filter(
    (answer) => answer.outcome === "bloqueada" || answer.outcome === "fallida",
  )
  const basis = sent.flatMap((answer) => answer.basis)
  const checks = turn.answers.flatMap((answer) => answer.checks)
  const failed = checks.filter((check) => !check.ok)
  const handedOff = turn.status === "handoff"
  const notSent =
    sent.length === 0 &&
    !handedOff &&
    (turn.status === "sin_respuesta" || turn.status === "error" || blocked.length > 0)
  const alerts =
    notSent || handedOff || failed.length > 0 ? (
      <div className="flex w-full max-w-[88%] flex-col gap-1 self-start text-sm">
        {handedOff ? (
          <div className="flex flex-col gap-0.5 rounded-xl border bg-card px-3 py-2.5">
            <p className="font-semibold">Pasó el caso a tu equipo</p>
            <p className="text-xs text-muted-foreground">
              Es una prueba: no llega a «Te espera» ni avisa a nadie.
            </p>
          </div>
        ) : null}
        {notSent ? (
          <p role="status" className="font-medium text-destructive">
            {receptionName} no llegó a enviar una respuesta: el paciente no recibió nada.
          </p>
        ) : null}
        {failed.map((check) => (
          <p
            key={`${check.kind}-${check.value}`}
            className="flex items-start gap-1.5 text-destructive"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {ANSWER_CHECK_LABEL[check.kind]} «{check.value}»: no está en tus datos; esa respuesta no
            salió.
          </p>
        ))}
      </div>
    ) : null
  // El modelo de demostración siempre lleva su aviso dentro de «Lo que hizo».
  if (
    turn.did.length === 0 &&
    basis.length === 0 &&
    waiting.length === 0 &&
    turn.model !== "fake"
  ) {
    return (
      <>
        {alerts}
        {sent.length > 0 ? (
          <p className="self-start px-1.5 text-xs text-muted-foreground">
            Respondió sin consultar nada: con lo que ya había en la conversación.
          </p>
        ) : null}
      </>
    )
  }
  // En una línea: lo primero que hizo y, si hizo más, cuántas cosas más.
  const summary = turn.did[0]
    ? `${turn.did[0].replace(/\.$/, "")}${turn.did.length > 1 ? ` y ${turn.did.length - 1} más` : ""}`
    : basis.length > 0
      ? `Se basó en ${basis.length === 1 ? "1 fuente" : `${basis.length} fuentes`}`
      : null
  return (
    <>
      {alerts}
      <Collapsible className="flex w-full max-w-[88%] flex-col gap-2 self-start">
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group h-auto min-h-11 max-w-full justify-start gap-1.5 self-start px-1.5 text-left text-xs font-normal text-muted-foreground sm:min-h-8"
            >
              <ChevronRight
                aria-hidden
                className="shrink-0 transition-transform group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
              />
              <span className="font-semibold">Lo que hizo</span>
              {summary ? <span className="min-w-0 truncate">· {summary}</span> : null}
            </Button>
          }
        />
        <CollapsibleContent className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
          {turn.did.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Lo que hizo</p>
              <ul className="list-disc pl-5">
                {turn.did.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {basis.length > 0 || checks.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground">En qué se basó</p>
              <ul className="flex flex-col gap-1">
                {basis.map((item) => (
                  <li key={`${item.kind}-${item.label}`}>
                    {item.label}
                    {item.detail ? (
                      <span className="text-muted-foreground"> · {item.detail}</span>
                    ) : null}
                  </li>
                ))}
                {checks.map((check) => (
                  <li key={`${check.kind}-${check.value}`} className="flex items-start gap-1.5">
                    <span
                      className={`mt-0.5 shrink-0 [&>svg]:size-4 ${check.ok ? "text-success" : "text-destructive"}`}
                    >
                      {check.ok ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
                    </span>
                    <span>
                      {ANSWER_CHECK_LABEL[check.kind]} «{check.value}»:{" "}
                      {check.ok
                        ? `coincide con ${check.source ?? "tus datos"}`
                        : "no está en tus datos; esa respuesta no salió"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {waiting.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground">
                Espera el «sí» del paciente
              </p>
              <ul className="list-disc pl-5">
                {waiting.map((item) => (
                  <li key={item.id}>{item.summary ?? item.action}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {turn.model === "fake" ? (
            <p className="text-xs text-muted-foreground">
              Modelo de demostración: siempre responde lo mismo y no acredita la calidad de un
              proveedor real.
            </p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}
