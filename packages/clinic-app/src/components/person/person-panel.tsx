import { formatMoney } from "@odentia/clinical"
import { Badge, Button, buttonVariants, cn, Field, FieldDescription, FieldError, FieldLabel, Textarea, toast } from "@odentia/ui"
import { DetailDrawer, DetailSection, RowActions, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { useReceptionName } from "../../lib/agent-names"
import { invalidateAgentWork } from "../../lib/agent-work"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { timeAgo, useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import { formatClock, formatWeekdayDay } from "../../lib/finance-cash"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { readPanelDraft, writePanelDraft } from "../../lib/panel-draft"
import { isAmbiguousMutationError, QueryErrorState } from "../../lib/query-error"
import { HandoffUrgency } from "../agent/handoff-badges"
import { openBookingAnywhere } from "../agenda/schedule-host"
import { type PassableTopic, PassTopicDialog } from "../inbox/pass-topic-dialog"
import { WriteToPersonDialog } from "../write-to-person"

interface PanelAppointment {
  startsAt: string
  professionalName: string | null
  serviceName: string | null
  branchName: string | null
}

/** Lo que entrega `GET /api/workspace/person-panel`: cada parte, solo si el rol la lee. */
interface PersonPanelData {
  conversationId: string
  contactId: string
  name: string | null
  channel: string | null
  patientId: string | null
  topic: {
    id: string
    reason: string
    asks: string | null
    pending: string | null
    quote: string | null
    kind: PassableTopic["kind"]
    priority: string
    urgent: boolean
    status: "abierta" | "tomada" | "resuelta"
    assigneeUserId: string | null
    createdAt: string
  } | null
  thread: Array<{ from: "person" | "agent" | "team"; text: string; at: string }>
  known: Array<{ label: string | null; text: string; origin: "caso" | "persona" | "ficha"; notedBy: "agente" | "equipo" | null }> | null
  proposals: Array<{ label: string; summary: string; status: string; at: string }>
  reply: { allowed: boolean; closedChannel: boolean; windowOpen: boolean; holdOn: string | null }
  appointments: { next: PanelAppointment | null; last: PanelAppointment | null } | null
  allergies: string[] | null
  lastEncounter: { startedAt: string; professionalName: string | null } | null
  budget: { id: string; title: string; status: string } | null
  debts: Array<{ cents: number; currency: string }> | null
  opportunities: Array<{ id: string; title: string; stageName: string }> | null
  suggestions: {
    professionalName: string | null
    slots: Array<{ startsAt: string; label: string }>
    prices: Array<{ name: string; text: string }>
    noPriceFor: string | null
  }
  canTeach: boolean
}

export interface PersonPanelTarget {
  conversationId: string
  /** El tema que se responde; sin él, un mensaje normal. */
  topicId?: string
  name: string
}

/** Lo que el panel escribe en la respuesta: una frase corta que se puede cambiar. */
function appended(current: string, phrase: string): string {
  const base = current.trim()
  return base ? `${base} ${phrase}` : phrase
}

const when = (iso: string) => {
  const locale = activeOrgLocale() ?? "es"
  const timeZone = activeOrgTimeZone() ?? "UTC"
  return `${formatWeekdayDay(iso, locale, timeZone)}, ${formatClock(iso, locale, timeZone)}`
}

const appointmentLine = (item: PanelAppointment) => [when(item.startsAt), item.professionalName, item.serviceName].filter(Boolean).join(" · ")

/**
 * Lo que abre una fila de una persona: qué pasó, qué se sabe y qué hacer, con la
 * caja de respuesta al pie (ADR 0127). Es uno solo en Inicio y en la Bandeja. La
 * × cierra; lo escrito queda guardado como borrador de esa persona.
 *
 * Responder cuenta como en la Bandeja (ADR 0122): un solo «Enviar», y «Dejar
 * pendiente» aparece después, porque resolver se corrige y enviar no.
 */
export function PersonPanel({
  target,
  also,
  next,
  onClose,
  onChanged,
}: {
  /** La persona; null = cerrado. */
  target: PersonPanelTarget | null
  /** Lo demás de esta persona que le toca a quien mira, ya escrito por quien abre el panel. */
  also?: ReactNode
  /** «Siguiente: Rosa Quispe», después de enviar. */
  next?: { name: string; open: () => void } | null
  onClose: () => void
  onChanged?: () => void
}) {
  const conversationId = target?.conversationId ?? null
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const receptionName = useReceptionName()
  const memberName = useMemberName()
  const myUserId = useMyUserId()
  const canWrite = usePermission("conversations.write")
  const canBook = usePermission("appointments.write")
  const key = ["person-panel", conversationId, target?.topicId ?? null]
  const query = useQuery({
    queryKey: key,
    queryFn: () => {
      const params = new URLSearchParams({ conversationId: conversationId as string, ...(target?.topicId ? { topicId: target.topicId } : {}) })
      return apiFetch<{ data: PersonPanelData }>(`/api/workspace/person-panel?${params}`)
    },
    enabled: conversationId !== null,
    retry: false,
  })
  const panel = query.data?.data
  const [text, setText] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** Otra persona lo tomó mientras se escribía: enviar lo pasa a quien escribe. */
  const [takenBy, setTakenBy] = useState<string | null>(null)
  const [takeOver, setTakeOver] = useState(false)
  /** No se sabe si salió: no se ofrece reenviar, podría llegarle dos veces. */
  const [unknownDelivery, setUnknownDelivery] = useState(false)
  const [sent, setSent] = useState<{ text: string; held: boolean; resolved: boolean; topicId: string | null } | null>(null)
  const [reopened, setReopened] = useState(false)
  const [taught, setTaught] = useState(false)
  const [passing, setPassing] = useState(false)
  const [writing, setWriting] = useState(false)

  // Cada persona con lo suyo: al cambiar de fila, su borrador y nada de la anterior.
  useEffect(() => {
    setText(conversationId ? readPanelDraft(myUserId, conversationId) : "")
    setFieldError(null)
    setProblem(null)
    setTakenBy(null)
    setTakeOver(false)
    setUnknownDelivery(false)
    setSent(null)
    setReopened(false)
    setTaught(false)
  }, [conversationId, target?.topicId, myUserId])

  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
    void queryClient.invalidateQueries({ queryKey: ["person-panel"] })
    invalidateAgentWork(queryClient)
    onChanged?.()
  }

  const topic = panel?.topic && panel.topic.status !== "resuelta" ? panel.topic : null
  const heldByOther = topic?.assigneeUserId && topic.assigneeUserId !== myUserId ? topic.assigneeUserId : null

  const send = useMutation({
    retry: false,
    mutationFn: (body: string) =>
      topic
        ? apiFetch<{ data: { held?: boolean; topicResolved?: boolean; topicId?: string | null } }>(`/api/workspace/topics/${topic.id}/reply`, {
            method: "POST",
            body: JSON.stringify({ text: body, ...(takeOver ? { takeOver: true } : {}) }),
          })
        : apiFetch<{ data: { held?: boolean; topicResolved?: boolean; topicId?: string | null } }>(`/api/conversations/${conversationId}/messages`, {
            method: "POST",
            // Pasadas las 24 horas, responder a lo último que dijo es lo que deja el mensaje por entregar.
            body: JSON.stringify({ text: body, ...(panel?.reply.holdOn ? { replyToMessageId: panel.reply.holdOn } : {}) }),
          }),
    onSuccess: (result, body) => {
      if (conversationId) writePanelDraft(myUserId, conversationId, "")
      setText("")
      setProblem(null)
      setTakenBy(null)
      setSent({ text: body, held: result.data.held === true, resolved: result.data.topicResolved === true, topicId: topic?.id ?? null })
      settled()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.shape.code === "TOPIC_TAKEN") {
        setTakenBy(error.shape.message ?? "Otra persona acaba de tomar este tema.")
        void query.refetch()
        return
      }
      if (isAmbiguousMutationError(error)) {
        setUnknownDelivery(true)
        return
      }
      setProblem(submitErrorMessage(error))
    },
  })

  const topicAction = useMutation({
    retry: false,
    mutationFn: ({ topicId, path, body }: { topicId: string; path: "take" | "resolve" | "reopen"; body?: unknown }) =>
      apiFetch(path === "reopen" ? `/api/workspace/topics/${topicId}/reopen` : `/api/conversations/${conversationId}/topics/${topicId}/${path}`, {
        method: "POST",
        ...(path === "reopen" ? { body: JSON.stringify({ conversationId }) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: (_result, variables) => {
      settled()
      if (variables.path === "resolve") {
        toast.success("Tema resuelto")
        onClose()
      }
      if (variables.path === "reopen") setReopened(true)
    },
    onError: (error) => setProblem(submitErrorMessage(error)),
  })

  const teach = useMutation({
    retry: false,
    mutationFn: (input: { question: string; answer: string }) =>
      apiFetch("/api/workspace/teach", { method: "POST", body: JSON.stringify({ conversationId, ...input }) }),
    onSuccess: () => setTaught(true),
    onError: (error) => setProblem(submitErrorMessage(error)),
  })

  if (conversationId === null) return null

  const name = panel?.name ?? target?.name ?? "Interlocutor"
  const first = name.trim().split(/\s+/)[0] || "la persona"
  const channel = panel?.channel ? channelLabel(panel.channel) : null
  const description = [panel?.patientId ? "Paciente" : null, channel, panel?.topic ? timeAgo(panel.topic.createdAt) : null].filter(Boolean).join(" · ")
  const question = panel?.topic?.quote ?? panel?.thread.filter((item) => item.from === "person").at(-1)?.text ?? ""

  const submit = () => {
    // Enter no pasa por el botón: mientras sale el mensaje, otro Enter le llegaría dos veces.
    if (send.isPending) return
    const body = text.trim()
    if (!body) {
      setFieldError("Escribe tu respuesta.")
      return
    }
    if (body.length > 4000) {
      setFieldError("Escribe como mucho 4000 caracteres.")
      return
    }
    setFieldError(null)
    setProblem(null)
    send.mutate(body)
  }

  const change = (value: string) => {
    setText(value)
    setFieldError(null)
    writePanelDraft(myUserId, conversationId, value)
  }

  const menu = [
    ...(topic && canWrite ? [{ key: "pasar", label: "Pasar este tema a…", disabled: topicAction.isPending, onSelect: () => setPassing(true) }] : []),
    ...(topic && canWrite ? [{ key: "resuelto", label: "Marcar resuelto", disabled: topicAction.isPending, onSelect: () => topicAction.mutate({ topicId: topic.id, path: "resolve" }) }] : []),
    ...(panel && panel.thread.length > 0 ? [{ key: "conversacion", label: "Ver la conversación", onSelect: () => void navigate({ to: "/inbox", search: { conversation: conversationId } }) }] : []),
  ]

  const replyBox = panel && !sent ? (
    <div className="flex w-full flex-col gap-2">
      {panel.suggestions.slots.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-bold text-foreground">Horarios libres{panel.suggestions.professionalName ? ` con ${panel.suggestions.professionalName}` : ""}.</span> <span className="max-sm:sr-only">Tocar uno lo escribe; no lo aparta.</span>
          </p>
          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] sm:flex-wrap">
            {panel.suggestions.slots.map((slot) => (
              <Button
                key={slot.startsAt}
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 shrink-0 sm:min-h-8"
                onClick={() => change(appended(text, `¿Te queda bien ${slot.label}${panel.suggestions.professionalName ? ` con ${panel.suggestions.professionalName}` : ""}?`))}
              >
                {slot.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {panel.suggestions.prices.length === 0 && panel.suggestions.noPriceFor ? <p className="text-[13px] text-muted-foreground">{panel.suggestions.noPriceFor}</p> : null}
      {panel.suggestions.prices.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-bold text-foreground">Tu lista de precios.</span> Tocar uno lo escribe.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {panel.suggestions.prices.map((price) => (
              <Button key={price.name} type="button" size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal text-left sm:min-h-8" onClick={() => change(appended(text, price.text))}>
                {price.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {heldByOther && !takeOver && !takenBy ? (
        <div className="flex flex-col gap-1.5 rounded-xl bg-muted/60 p-3 text-sm">
          <p>Sigue en manos de {memberName(heldByOther)}. Si respondes tú, el tema pasa a ti y se le avisa.</p>
          <Button type="button" size="sm" variant="outline" className="min-h-11 self-start sm:min-h-8" onClick={() => setTakeOver(true)}>
            Responder yo
          </Button>
        </div>
      ) : null}
      {takenBy ? (
        <div role="status" className="flex flex-col gap-1.5 rounded-xl bg-warning/10 p-3 text-sm">
          <p>{takenBy} Lo que escribiste sigue aquí.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 self-start sm:min-h-8"
            onClick={() => {
              setTakeOver(true)
              setTakenBy(null)
            }}
          >
            Responder yo
          </Button>
        </div>
      ) : null}
      {unknownDelivery ? (
        <div role="alert" className="flex flex-col gap-1.5 rounded-xl bg-warning/10 p-3 text-sm">
          <p>No sabemos si le llegó. Mira la conversación antes de volver a escribirle.</p>
          <Link to="/inbox" search={{ conversation: conversationId }} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "min-h-11 self-start sm:min-h-8")}>
            Ver la conversación
          </Link>
        </div>
      ) : null}
      {panel.reply.closedChannel ? (
        <div className="flex flex-col gap-1.5 rounded-xl bg-muted/60 p-3 text-sm">
          <p>{channel ?? "Ese canal"} ya no deja responderle. {canWrite ? "Puedes escribirle por otro canal." : "Lo responde recepción en la Bandeja."}</p>
          {canWrite ? (
            <Button type="button" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => setWriting(true)}>
              Escribirle
            </Button>
          ) : null}
        </div>
      ) : panel.reply.allowed && (!heldByOther || takeOver) && !unknownDelivery ? (
        <Field data-invalid={fieldError ? true : undefined}>
          <FieldLabel htmlFor="panel-respuesta">Tu respuesta para {first}</FieldLabel>
          <Textarea
            id="panel-respuesta"
            rows={2}
            value={text}
            maxLength={4000}
            className="text-base sm:text-sm"
            aria-invalid={fieldError ? true : undefined}
            onChange={(event) => change(event.target.value)}
            onKeyDown={(event) => {
              // Enter envía, como en la Bandeja; Mayús + Enter baja de línea.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!event.repeat) submit()
              }
            }}
          />
          {fieldError ? <FieldError>{fieldError}</FieldError> : null}
          <FieldDescription className="text-xs">
            {panel.reply.windowOpen
              ? `Se envía por ${channel ?? "su conversación"}${topic?.quote ? ", citando su pregunta" : ""}.`
              : "Queda por entregar: le llega cuando toque «Ver respuesta»."}{" "}
            {receptionName} sigue con lo demás.{topic && topic.assigneeUserId !== myUserId ? " Al enviar, este tema queda contigo." : ""}
          </FieldDescription>
        </Field>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {menu.length > 0 ? <RowActions label={`Más sobre ${name}`} items={menu} /> : null}
        {panel.reply.allowed && !panel.reply.closedChannel && (!heldByOther || takeOver) && !unknownDelivery ? (
          <Button type="button" className="min-h-11 sm:min-h-9" disabled={send.isPending} onClick={submit}>
            {send.isPending ? "Enviando…" : "Enviar"}
          </Button>
        ) : null}
      </div>
    </div>
  ) : panel && sent ? (
    <div className="flex w-full flex-col gap-2">
      <p role="status" className="text-sm">
        {sent.held
          ? `Quedó por entregar: a ${first} le llega con «Ver respuesta».`
          : reopened
            ? `Le respondiste a ${first}. El tema sigue pendiente.`
            : `Le respondiste a ${first}.${sent.resolved ? " Tema resuelto." : ""} ${receptionName} sigue con lo demás.`}
      </p>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {sent.resolved && sent.topicId && !reopened && (canWrite || panel.topic?.kind === "pago") ? (
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" disabled={topicAction.isPending} onClick={() => topicAction.mutate({ topicId: sent.topicId as string, path: "reopen" })}>
            Dejar pendiente
          </Button>
        ) : null}
        {panel.canTeach && question && !taught ? (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={teach.isPending} onClick={() => teach.mutate({ question, answer: sent.text })}>
            {teach.isPending ? "Guardando…" : `Enseñárselo a ${receptionName}`}
          </Button>
        ) : null}
        {taught ? <span className="text-sm text-muted-foreground">Queda por aprobar en Aprender.</span> : null}
        {next ? (
          <Button type="button" className="min-h-11 sm:min-h-9" onClick={next.open}>
            Siguiente: {next.name}
          </Button>
        ) : null}
      </div>
    </div>
  ) : undefined

  return (
    <>
      <DetailDrawer
        open
        focusTitle
        title={name}
        size="lg"
        description={description || undefined}
        headerContent={
          panel?.topic && panel.topic.status !== "resuelta" ? (
            <div className="flex flex-wrap items-center gap-2">
              <HandoffUrgency priority={panel.topic.urgent ? "alta" : panel.topic.priority} />
              <span className="text-sm text-muted-foreground">
                {!panel.topic.assigneeUserId ? "Nadie lo ha tomado" : panel.topic.assigneeUserId === myUserId ? "Lo tienes tú" : `Lo tiene ${memberName(panel.topic.assigneeUserId)}`}
              </span>
            </div>
          ) : undefined
        }
        onClose={onClose}
        isLoading={query.isPending}
        actions={replyBox}
      >
        {query.isError || (!query.isPending && !panel) ? (
          <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : panel ? (
          <div className="flex flex-col gap-5">
            {panel.topic?.status === "resuelta" && !sent ? (
              <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/60 p-3 text-sm">
                <span className="flex-1">Este tema ya se resolvió.</span>
                {next ? (
                  <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={next.open}>
                    Siguiente: {next.name}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {panel.thread.length > 0 ? (
              <div className="flex flex-col gap-2">
                {panel.thread.map((item) => (
                  <div key={`${item.at}-${item.from}`} className={cn("flex max-w-[88%] flex-col gap-0.5", item.from === "person" ? "self-start" : "self-end")}>
                    <span className={cn("text-[11px] text-muted-foreground", item.from !== "person" && "text-right")}>
                      {item.from === "person" ? first : item.from === "agent" ? receptionName : "Tu equipo"} · {timeAgo(item.at)}
                    </span>
                    <p className={cn("rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap", item.from === "person" ? "bg-primary-soft" : "bg-muted")}>{item.text}</p>
                  </div>
                ))}
                {canWrite ? (
                  <Link to="/inbox" search={{ conversation: conversationId }} className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary hover:underline sm:min-h-8">
                    Ver toda la conversación
                  </Link>
                ) : null}
              </div>
            ) : panel.topic?.quote ? (
              <p className="self-start rounded-2xl bg-primary-soft px-3 py-2 text-sm">«{panel.topic.quote}»</p>
            ) : null}

            {panel.topic ? (
              <div className="rounded-xl border border-primary/25 bg-primary-soft/40 p-3 text-sm">
                <p className="text-[13px] font-bold text-primary-soft-foreground">Por qué te lo pasó {receptionName}</p>
                <p>{panel.topic.reason}</p>
                {panel.topic.asks ? <p className="mt-1">Pide: {panel.topic.asks}</p> : null}
                {panel.topic.pending ? <p className="mt-1 font-semibold">Falta: {panel.topic.pending}</p> : null}
              </div>
            ) : null}

            <FactList panel={panel} canBook={canBook} name={name} />

            {panel.known && panel.known.length > 0 ? (
              <DetailSection title="Lo que ya se sabe">
                <p className="text-sm text-muted-foreground">No hace falta volver a preguntarlo.</p>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {panel.known.map((item) => (
                    <li key={`${item.origin}-${item.label ?? ""}-${item.text}`} className="flex flex-wrap items-baseline gap-x-2">
                      {item.label ? <span className="font-semibold">{item.label}:</span> : null}
                      <span>{item.text}</span>
                      {item.origin === "ficha" ? <Badge variant="secondary">Ficha</Badge> : null}
                    </li>
                  ))}
                </ul>
              </DetailSection>
            ) : null}

            {panel.proposals.length > 0 ? (
              <DetailSection title={`Lo que ya hizo ${receptionName}`}>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                  {panel.proposals.map((item) => (
                    <li key={`${item.at}-${item.label}`}>
                      {item.label}: {item.summary}
                    </li>
                  ))}
                </ul>
              </DetailSection>
            ) : null}

            {also}
          </div>
        ) : null}
      </DetailDrawer>
      {topic ? (
        <PassTopicDialog
          topic={passing ? { id: topic.id, kind: topic.kind, assigneeUserId: topic.assigneeUserId, quote: topic.asks ?? topic.quote ?? topic.reason } : null}
          pending={topicAction.isPending}
          onClose={() => setPassing(false)}
          onPass={(item, userId, toMe) => {
            setPassing(false)
            topicAction.mutate({ topicId: item.id, path: "take", ...(toMe ? {} : { body: { toUserId: userId } }) })
          }}
        />
      ) : null}
      {panel ? <WriteToPersonDialog open={writing} onClose={() => setWriting(false)} people={[{ contactId: panel.contactId, displayName: name }]} /> : null}
    </>
  )
}

/** Sus citas, alergias y lo demás que el rol puede ver: lo que hace falta para responder sin preguntar. */
function FactList({ panel, canBook, name }: { panel: PersonPanelData; canBook: boolean; name: string }) {
  const locale = activeOrgLocale() ?? "es"
  const facts: Array<{ label: string; value: ReactNode }> = []
  if (panel.appointments) {
    if (panel.appointments.last) facts.push({ label: "Última cita", value: appointmentLine(panel.appointments.last) })
    facts.push({
      label: "Próxima cita",
      value: panel.appointments.next ? (
        appointmentLine(panel.appointments.next)
      ) : (
        <>
          No tiene
          {canBook && panel.patientId ? (
            <>
              {" · "}
              <Button
                type="button"
                variant="link"
                className="h-auto min-h-0 p-0 font-semibold"
                onClick={() => openBookingAnywhere({ patient: { id: panel.patientId as string, name }, lockedPatient: true, conversationId: panel.conversationId })}
              >
                Reservar cita
              </Button>
            </>
          ) : null}
        </>
      ),
    })
  }
  if (panel.allergies) facts.push({ label: "Alergias", value: panel.allergies.length > 0 ? panel.allergies.join(", ") : "Ninguna registrada" })
  if (panel.lastEncounter) facts.push({ label: "Última atención", value: [when(panel.lastEncounter.startedAt), panel.lastEncounter.professionalName].filter(Boolean).join(" · ") })
  if (panel.budget) facts.push({ label: "Presupuesto", value: panel.budget.title })
  if (panel.debts) facts.push({ label: "Debe", value: panel.debts.length > 0 ? panel.debts.map((item) => formatMoney(item.cents, item.currency, locale)).join(" · ") : "Nada" })
  if (panel.opportunities && panel.opportunities.length > 0) facts.push({ label: "Oportunidad", value: panel.opportunities.map((item) => `${item.title} (${item.stageName})`).join(" · ") })
  if (facts.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="font-semibold">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
