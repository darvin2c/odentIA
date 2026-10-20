/**
 * «Pregúntale a Argos» en Reportes (tableros A1, A2 y 10 del lienzo; ADR
 * 0070): el campo bajo el título y la respuesta al lado (la columna si cabe,
 * el cajón si no: `DetailDrawer`). Argos responde solo con cifras de Reportes:
 * la frase, el gráfico, «Así lo calculé» y lo que se puede hacer los entrega el
 * servidor. La conversación vive en la pantalla y se pierde al recargar: no se
 * guarda lo escrito.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, buttonVariants, cn, FieldLabel, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea, toast } from "@odentia/ui"
import { AgentMark, BarList, ColumnChart, DetailDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, Download, Pin, Search } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { ADMIN_NAME } from "../../lib/agent-names"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"
import type { ReportListKey, ReportQuery } from "../../lib/reports"
import { askReport, downloadReportAnswer, fetchPinKeys, type FigureUnit, PIN_KEYS_KEY, PINS_KEY, pinAnswer, type ReportAnswer, type ReportAskQuery, type ReportAskResult, type ReportSentence } from "../../lib/reports-ask"
import { screenEnvelope, WhatIsSent } from "../help-panel"
import { AdviceNote } from "./advice-note"

/** Las preguntas de muestra del panel vacío (tablero A1). */
const SAMPLES = ["¿Cuánto me trajo el agente este mes?", "¿Quién tiene más inasistencias?", "¿Cuántos llegaron por Instagram?"]

/** Medio minuto con el campo apagado si el modelo no respondió: vuelve solo, como en la página de Argos. */
const RETRY_AFTER_MS = 30_000

const ANSWER = "flex min-w-0 flex-col gap-3 rounded-2xl rounded-bl-md border bg-card px-3.5 py-3 text-sm"

interface Exchange {
  id: number
  question: string
  result: ReportAskResult | null
  error: string | null
  /** Lo que se enviaría a odentIA si no supo; empieza siendo la pregunta. */
  toSend?: string
  sent?: "enviada" | "no"
}

export function formatFigureValue(value: number, unit: FigureUnit, currency: string, locale: string): string {
  if (unit === "money") return formatMoney(Math.round(value), currency, locale)
  if (unit === "rate") return `${value} %`
  if (unit === "minutes") return `${Math.round(value)} min`
  if (unit === "hours") return `${Math.round(value / 60)} h`
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

function Sentence({ parts }: { parts: ReportSentence }) {
  return (
    <p className="text-[15px] leading-6">
      {parts.map((part, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: las partes de una frase no cambian de orden.
        part.strong ? <strong key={index} className="font-bold tabular-nums">{part.text}</strong> : <span key={index}>{part.text}</span>,
      )}
    </p>
  )
}

/** El gráfico de una respuesta: barras por grupo o los 12 meses; los dos con «Ver como tabla». */
export function AnswerChart({ answer, compact = false }: { answer: ReportAnswer; compact?: boolean }) {
  const chart = answer.chart
  if (!chart) return null
  const format = (value: number) => formatFigureValue(value, answer.unit, answer.currency, answer.locale)
  if (chart.kind === "bars") {
    return (
      <BarList
        title={answer.title}
        size="sm"
        rows={chart.rows.map((row) => ({
          key: row.key,
          label: row.label,
          value: row.value,
          ...(row.part !== undefined ? { part: row.part } : {}),
          valueText: row.valueText,
          ...(row.note ? { note: row.note } : {}),
        }))}
        {...(chart.legend ? { legend: chart.legend } : {})}
        table={{ label: "Grupo", value: "Cifra", ...(chart.rows.some((row) => row.note) ? { note: "Detalle" } : {}) }}
      />
    )
  }
  return (
    <ColumnChart
      title={`${answer.title}, últimos 12 meses`}
      height={compact ? 120 : 150}
      categories={chart.points.map((point) => ({ key: point.key, label: point.label, short: point.short, partial: point.partial }))}
      bars={[{ key: answer.query.figure, label: answer.title, tone: "series-1", values: chart.points.map((point) => point.value) }]}
      format={format}
    />
  )
}

/**
 * La respuesta de Argos: la frase con sus cifras, el gráfico, «Así lo
 * calculé» y lo que se puede hacer (ver la lista, fijarla, descargarla, abrir
 * su pestaña), más el aviso de la línea que lo atendería si está apagada.
 */
export function ArgosAnswer({
  answer,
  onOpenList,
  onAskQuery,
  onOpenRecommendation,
}: {
  answer: ReportAnswer
  /** Abre la lista con el periodo y la sede de la respuesta (pueden no ser los de la pantalla). */
  onOpenList: (list: ReportListKey, at: ReportQuery) => void
  onAskQuery: (query: ReportAskQuery) => void
  onOpenRecommendation: (key: string) => void
}) {
  const at: ReportQuery = { period: answer.query.period, ...(answer.query.branchId ? { branchId: answer.query.branchId } : {}) }
  const queryClient = useQueryClient()
  // Fijada o no lo dice lo guardado, no el último clic: quitarla desde el Resumen vuelve a ofrecer «Fijar».
  const pinKeys = useQuery({ queryKey: PIN_KEYS_KEY, queryFn: fetchPinKeys, retry: false })
  const pinned = (pinKeys.data?.data ?? []).some(
    (item) => item.figure === answer.query.figure && item.group === answer.query.group && (item.focus ?? "") === (answer.query.focus ?? ""),
  )
  const pin = useMutation({
    retry: false,
    mutationFn: () => pinAnswer(answer.query),
    onSuccess: () => {
      toast.success("Fijada en el Resumen: sigue el periodo y la sede de arriba")
      // El botón sigue pendiente hasta que la lista diga que quedó fijada.
      return queryClient.invalidateQueries({ queryKey: PINS_KEY })
    },
  })
  const download = useMutation({ retry: false, mutationFn: () => downloadReportAnswer(answer.query), onError: (error) => toast.error(mutationErrorMessage(error)) })
  return (
    <div className={ANSWER}>
      <Sentence parts={answer.sentence} />
      <AnswerChart answer={answer} />
      <p className="text-[13px] text-muted-foreground">
        <span className="font-bold text-foreground">Así lo calculé:</span> {answer.how} · {answer.scope}
      </p>
      <div className="flex flex-wrap gap-2">
        {answer.list ? (
          <Button type="button" className="min-h-11 sm:min-h-9" onClick={() => onOpenList(answer.list?.key as ReportListKey, at)}>
            {answer.list.label}
          </Button>
        ) : null}
        <SubmitButton
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          pending={pin.isPending}
          disabled={pinned}
          onClick={() => pin.mutate()}
        >
          <Pin aria-hidden />
          {pinned ? "Fijada en Resumen" : "Fijar en Resumen"}
        </SubmitButton>
        {answer.downloadable ? (
          <SubmitButton type="button" variant="outline" className="min-h-11 sm:min-h-9" pending={download.isPending} onClick={() => download.mutate()}>
            <Download aria-hidden />
            Descargar
          </SubmitButton>
        ) : null}
        <Link
          to="/reports"
          search={(prev) => ({
            ...prev,
            tab: answer.tab.key === "resumen" ? undefined : (answer.tab.key as "finanzas"),
            // La pestaña se abre con el periodo y la sede de la respuesta.
            period: at.period === "este_mes" ? undefined : at.period,
            branch: at.branchId,
            lista: undefined,
            vista: undefined,
          })}
          className={cn(buttonVariants({ variant: "ghost" }), "min-h-11 text-primary-soft-foreground sm:min-h-9")}
        >
          {answer.tab.label}
        </Link>
      </div>
      {pin.isError ? (
        <p role="alert" className="text-[13px] text-destructive">
          {mutationErrorMessage(pin.error)}
        </p>
      ) : null}
      {answer.advice ? <AdviceNote advice={answer.advice} onOpen={onOpenRecommendation} /> : null}
      {answer.followUps.length > 0 ? (
        <div role="group" className="flex flex-wrap gap-1.5" aria-label="Seguir preguntando">
          {answer.followUps.map((follow) => (
            <Button
              key={follow.label}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 rounded-full sm:min-h-8"
              onClick={() => ("list" in follow ? onOpenList(follow.list as ReportListKey, at) : onAskQuery(follow.query))}
            >
              {follow.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** La conversación con Argos de esta pantalla: cada pregunta, con su respuesta o su error. */
export function useArgosConversation(query: ReportQuery) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [open, setOpen] = useState(false)
  const [downUntil, setDownUntil] = useState<number | null>(null)
  const next = useRef(1)
  const ask = useMutation({
    retry: false,
    mutationFn: (input: { id: number; body: Parameters<typeof askReport>[0] }) => askReport(input.body),
    onSuccess: (response, input) => {
      setExchanges((current) => current.map((item) => (item.id === input.id ? { ...item, result: response.data } : item)))
      if (response.data.kind === "sin_modelo") setDownUntil(Date.now() + RETRY_AFTER_MS)
    },
    onError: (error, input) => {
      const message = error instanceof ApiError && error.shape.message ? error.shape.message : "No pude responder ahora. Vuelve a intentarlo."
      setExchanges((current) => current.map((item) => (item.id === input.id ? { ...item, error: message } : item)))
    },
  })
  useEffect(() => {
    if (downUntil === null) return
    const timer = setTimeout(() => setDownUntil(null), Math.max(0, downUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [downUntil])

  function push(question: string, body: Parameters<typeof askReport>[0]) {
    const id = next.current++
    setExchanges((current) => [...current, { id, question, result: null, error: null }])
    setOpen(true)
    ask.mutate({ id, body })
  }
  return {
    exchanges,
    setExchanges,
    open,
    setOpen,
    pending: ask.isPending,
    down: downUntil !== null,
    retry: () => setDownUntil(null),
    askText: (text: string) => push(text, { text, period: query.period, ...(query.branchId ? { branchId: query.branchId } : {}) }),
    askQuery: (label: string, asked: ReportAskQuery) => push(label, { query: asked }),
  }
}

export type ArgosConversation = ReturnType<typeof useArgosConversation>

/** El campo bajo el título (tablero 1): preguntar abre la respuesta al lado. Con Argos apagado, lo dice. */
export function AskArgosField({ conversation, enabled }: { conversation: ArgosConversation; enabled: boolean | undefined }) {
  const canAgent = usePermission("agent.write")
  const [draft, setDraft] = useState("")
  const off = enabled === false
  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length < 3 || conversation.pending || conversation.down) return
    conversation.askText(text)
    setDraft("")
  }
  return (
    <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-1 sm:max-w-xl md:ml-auto">
      <form onSubmit={submit} className="min-w-0">
        <FieldLabel htmlFor="argos-pregunta" className="sr-only">
          Pregúntale a {ADMIN_NAME}
        </FieldLabel>
        <InputGroup className={cn("border-primary bg-card", off && "border-input opacity-70")}>
          <InputGroupAddon className="pl-2">
            <AgentMark size="sm" />
          </InputGroupAddon>
          <InputGroupInput
            id="argos-pregunta"
            className="min-h-11"
            maxLength={500}
            value={draft}
            disabled={off || conversation.down}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Pregúntale a ${ADMIN_NAME}: ¿cuánto me trajo el agente este mes?`}
          />
          <InputGroupAddon align="inline-end" className="pr-1.5">
            <InputGroupButton
              type="submit"
              variant="default"
              size="sm"
              className="min-h-11 rounded-lg px-3 sm:min-h-8"
              disabled={off || conversation.down || draft.trim().length < 3 || conversation.pending}
              aria-busy={conversation.pending}
            >
              <Search aria-hidden className="sm:hidden" />
              <span className="hidden sm:inline">Preguntar</span>
              <span className="sr-only sm:hidden">Preguntar</span>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      {off ? (
        <p className="text-[13px] text-muted-foreground">
          {ADMIN_NAME} está apagado: enciéndelo para preguntarle. Las cifras de Reportes no dependen de él.{" "}
          {canAgent ? (
            <Link to="/agent/administrador" className="font-semibold text-primary-soft-foreground underline">
              Encender a {ADMIN_NAME}
            </Link>
          ) : null}
        </p>
      ) : conversation.down ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Ahora no puedo leer preguntas: el campo vuelve solo en medio minuto.{" "}
          <Button type="button" variant="link" className="h-auto p-0 text-[13px]" onClick={conversation.retry}>
            Reintentar
          </Button>
        </p>
      ) : null}
    </div>
  )
}

/** Lo que dice Argos cuando no es una cifra: duda, no sabe, no le toca o no pudo. */
function Reply({ exchange, children }: { exchange: Exchange; children?: ReactNode }) {
  const result = exchange.result
  if (!result) return null
  return (
    <div className={ANSWER}>
      <p className="text-[15px] leading-6">{result.kind === "respuesta" ? null : result.message}</p>
      {children}
    </div>
  )
}

/** La respuesta al lado: columna fija si cabe, cajón estándar si no (tableros A1 y 10). */
export function ArgosPanel({
  conversation,
  onOpenList,
  onOpenRecommendation,
}: {
  conversation: ArgosConversation
  onOpenList: (list: ReportListKey, at: ReportQuery) => void
  onOpenRecommendation: (key: string) => void
}) {
  const queryClient = useQueryClient()
  const canAgent = usePermission("agent.read")
  const [draft, setDraft] = useState("")
  const end = useRef<HTMLDivElement>(null)
  const { exchanges, setExchanges } = conversation
  // Lo que viaja con un pedido a odentIA: lo mismo que dice la Ayuda en esta pantalla.
  const screen = useQuery({
    queryKey: ["help-screen", "/reports"],
    queryFn: () => apiFetch("/api/help/screen?path=%2Freports").then((body: unknown) => screenEnvelope.parse(body).data),
    enabled: conversation.open && exchanges.some((item) => item.result?.kind === "no_sabe"),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const send = useMutation({
    retry: false,
    mutationFn: (input: { id: number; text: string }) =>
      apiFetch("/api/help/requests", {
        method: "POST",
        body: JSON.stringify({ question: input.text, screen: "/reports", kind: "pregunta", detail: `Pregunta a ${ADMIN_NAME} en Reportes que todavía no sabe responder` }),
      }),
    onSuccess: (_data, input) => {
      setExchanges((current) => current.map((item) => (item.id === input.id ? { ...item, sent: "enviada" } : item)))
      void queryClient.invalidateQueries({ queryKey: ["support-cases"] })
    },
  })
  const last = exchanges[exchanges.length - 1]
  // biome-ignore lint/correctness/useExhaustiveDependencies: baja a la última respuesta cuando llega.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [last?.id, last?.result])

  if (!conversation.open) return null
  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length < 3 || conversation.pending || conversation.down) return
    conversation.askText(text)
    setDraft("")
  }
  const askQuery = (query: ReportAskQuery, label: string) => conversation.askQuery(label, query)
  const close = () => conversation.setOpen(false)

  return (
    <DetailDrawer open title={ADMIN_NAME} description="Responde con las cifras de Reportes" onClose={close} isSubmitting={conversation.pending}>
      <div className="flex flex-col gap-4">
        {exchanges.length === 0 ? (
          <section aria-label="Prueba una pregunta" className="flex flex-col gap-1.5">
            <h3 className="text-[13px] font-bold text-muted-foreground">Prueba una pregunta</h3>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLES.map((sample) => (
                <Button key={sample} type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={conversation.pending || conversation.down} onClick={() => conversation.askText(sample)}>
                  {sample}
                </Button>
              ))}
            </div>
          </section>
        ) : (
          <ol className="flex flex-col gap-4" aria-live="polite">
            {exchanges.map((exchange) => {
              const result = exchange.result
              return (
                <li key={exchange.id} className="flex flex-col gap-3">
                  <p className="max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
                    <span className="sr-only">Preguntaste: </span>
                    {exchange.question}
                  </p>
                  {exchange.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {exchange.error}
                    </p>
                  ) : !result ? (
                    <p className="text-sm text-muted-foreground" role="status">
                      Calculando…
                    </p>
                  ) : result.kind === "respuesta" ? (
                    <ArgosAnswer
                      answer={result.answer}
                      onOpenList={onOpenList}
                      onAskQuery={(query) => askQuery(query, followUpLabel(result.answer, query))}
                      onOpenRecommendation={onOpenRecommendation}
                    />
                  ) : result.kind === "pregunta" ? (
                    <Reply exchange={exchange}>
                      <div className="flex flex-col gap-1.5">
                        {result.options.map((option) => (
                          <Button key={option.label} type="button" variant="outline" className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left sm:min-h-10" onClick={() => askQuery(option.query, option.label)}>
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </Reply>
                  ) : result.kind === "no_sabe" ? (
                    <>
                      <Reply exchange={exchange}>
                        {result.closest.length > 0 ? (
                          <div className="flex flex-col gap-1.5">
                            <p className="text-[13px] font-bold text-muted-foreground">Lo más cercano que sí sé:</p>
                            {result.closest.map((option) => (
                              <Button key={option.label} type="button" variant="outline" className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left sm:min-h-10" onClick={() => askQuery(option.query, option.label)}>
                                {option.label}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                        {exchange.sent === undefined ? <p>¿Lo envío a odentIA como pedido? Las cifras más pedidas pasan a la lista.</p> : null}
                      </Reply>
                      {exchange.sent === "enviada" ? (
                        <p role="status" className="text-sm font-semibold">
                          Enviado a odentIA. La respuesta te llega en Ayuda.
                        </p>
                      ) : exchange.sent === "no" ? null : (
                        <WhatIsSent
                          id={`argos-enviar-${exchange.id}`}
                          label="Tu pregunta · puedes cambiarla"
                          value={exchange.toSend ?? exchange.question}
                          onChange={(text) => setExchanges((current) => current.map((item) => (item.id === exchange.id ? { ...item, toSend: text } : item)))}
                          attached={screen.data?.attached}
                          error={send.isError && send.variables?.id === exchange.id ? mutationErrorMessage(send.error) : null}
                          pending={send.isPending && send.variables?.id === exchange.id}
                          onSend={() => send.mutate({ id: exchange.id, text: (exchange.toSend ?? exchange.question).trim() })}
                          onCancel={() => setExchanges((current) => current.map((item) => (item.id === exchange.id ? { ...item, sent: "no" } : item)))}
                          cancelLabel="No, gracias"
                        />
                      )}
                    </>
                  ) : result.kind === "accion" ? (
                    <Reply exchange={exchange}>
                      {result.line && canAgent ? (
                        <Link
                          to="/agent/administrador"
                          search={{ linea: result.line.key }}
                          className={cn(buttonVariants({ size: "sm" }), "min-h-11 self-start sm:min-h-9")}
                        >
                          Ver la línea
                        </Link>
                      ) : null}
                    </Reply>
                  ) : (
                    <Reply exchange={exchange} />
                  )}
                </li>
              )
            })}
          </ol>
        )}
        <div ref={end} />
        <div className="flex flex-col gap-2 border-t pt-3.5">
          <form onSubmit={submit}>
            <FieldLabel htmlFor="argos-otra" className="sr-only">
              Escribe otra pregunta
            </FieldLabel>
            <InputGroup className="border-input bg-card">
              <InputGroupTextarea
                id="argos-otra"
                rows={1}
                maxLength={500}
                className="max-h-32 min-h-11"
                value={draft}
                disabled={conversation.down}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder="Escribe otra pregunta"
              />
              <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  className="size-11 rounded-xl sm:size-9"
                  aria-label="Preguntar"
                  disabled={draft.trim().length < 3 || conversation.pending || conversation.down}
                  aria-busy={conversation.pending}
                >
                  <ArrowRight aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <p className="text-[13px] text-muted-foreground">
            Responde solo con cifras que puede consultar y ve lo mismo que tú. Nunca cambia nada sin que lo prendas.
          </p>
        </div>
      </div>
    </DetailDrawer>
  )
}

/** Lo que dice la burbuja al tocar una opción: «¿Y en agosto?», «Por sede». */
function followUpLabel(answer: ReportAnswer, query: ReportAskQuery): string {
  return answer.followUps.find((follow) => "query" in follow && follow.query === query)?.label ?? answer.title
}
