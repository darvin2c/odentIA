/**
 * Argos sobre los datos de la clínica (ADR 0075; tableros 2 a 6 del lienzo «Argos
 * conoce la base»). Se abre desde el buscador o desde Reportes, sin botón en la
 * cabecera, y responde al lado: columna si cabe, cajón si no y la hoja de abajo
 * en el teléfono (`DetailDrawer`). La frase con sus cifras, el dibujo cuando
 * ayuda, «Así lo calculé», el periodo (tableros 7 a 12: se cambia sin volver a
 * llamar al modelo), los botones para seguir (ya corridos), «Fijar en Resumen»,
 * «Descargar» y «Abrir…» los entrega el servidor; aquí solo se dibujan. La conversación vive en el panel mientras dura
 * la sesión (D4): el texto de las preguntas no se guarda (D2).
 */
import { Badge, Button, buttonVariants, cn, FieldLabel, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea, ScrollArea, toast } from "@odentia/ui"
import { AgentMark, BarList, ColumnChart, DetailDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, Check, Download, LoaderCircle, Pin, Search } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import { ADMIN_NAME } from "../../lib/agent-names"
import {
  ARGOS_SCREEN_LINKS,
  ASK_ARGOS_EVENT,
  type ArgosAskEvent,
  type ArgosChoice,
  type ArgosResult,
  type ArgosShown,
  type ArgosTable,
  askArgos,
  choiceOf,
  downloadArgos,
  openArgos,
  pinArgos,
  rerunArgos,
} from "../../lib/argos"
import { useMyRole, usePermission } from "../../lib/crm"
import { askHelp, canOpenHref } from "../../lib/global-search"
import { useOrgLocale } from "../../lib/locale"
import { mutationErrorMessage } from "../../lib/query-error"
import type { ReportQuery } from "../../lib/reports"
import { PINS_KEY } from "../../lib/reports-ask"
import { PersonLink } from "../person-link"
import { ArgosPeriodRow } from "./argos-period"

const DESCRIPTION = "Responde con los datos de la clínica que tú puedes ver"
const SAMPLES = ["¿Cuánto cobramos este mes?", "¿Qué pacientes tienen saldos pendientes?", "¿Cuántas citas hay mañana?"]
const ANSWER = "flex min-w-0 flex-col gap-3 rounded-2xl rounded-bl-md border bg-card px-3.5 py-3 text-sm"
/** Filas de la tabla a la vista; el resto con «Ver las N». */
const ROWS_SHOWN = 10

interface Exchange {
  id: number
  question: string
  screen?: ReportQuery
  routed?: boolean
  result: ArgosResult | null
  error: string | null
  /** La opción para seguir que se está viendo; null es la respuesta. */
  option: number | null
  /** Se está calculando con otro periodo o sede (D9). */
  recalculating?: boolean
  /** No se pudo con el periodo elegido: se dice y se sigue viendo lo de antes. */
  recalcError?: string | null
  /** Lo último que se pidió, para «Intentar de nuevo». */
  lastChoice?: ArgosChoice
  /** Lo que Argos va haciendo mientras responde (D22). */
  steps?: string[]
  /** El paciente elegido entre los que se llaman igual (D23); sin él, se pregunta. */
  patientId?: string
  /** Ya llegó la respuesta del paciente elegido: antes no se muestra nada (la del otro no se ve ni atenuada). */
  patientReady?: boolean
}

/** Mientras Argos trabaja: los pasos hechos con su marca y el que va, con su espera (D22). */
function ArgosSteps({ steps }: { steps: string[] }) {
  const done = steps.slice(0, -1)
  const current = steps.at(-1)
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {done.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: los pasos solo se agregan al final.
        <p key={index} className="flex items-start gap-2">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" />
          {step}
        </p>
      ))}
      <p className="flex items-center gap-2 font-semibold text-primary-soft-foreground">
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        {current ?? "Consultando los datos…"}
      </p>
      <span className="text-[13px] text-muted-foreground">Suele tardar entre 20 y 40 segundos. Se puede seguir trabajando en la página.</span>
    </div>
  )
}

function Sentence({ parts }: { parts: ArgosShown["sentence"] }) {
  return (
    <p className="text-[15px] leading-6">
      {parts.map((part, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: las partes de una frase no cambian de orden.
        part.strong ? <strong key={index} className="font-bold tabular-nums">{part.text}</strong> : <span key={index}>{part.text}</span>,
      )}
    </p>
  )
}

type Drawing =
  | { kind: "months"; month: ArgosTable["columns"][number]; value: ArgosTable["columns"][number] }
  | { kind: "bars"; label: ArgosTable["columns"][number]; value: ArgosTable["columns"][number] }

/**
 * El dibujo solo cuando ayuda (tablero 3) y no engaña: una cifra por mes, cada
 * mes una vez, va en columnas; pocas filas con un nombre distinto y una cifra,
 * en barras. Una cifra vacía o negativa, una lista cortada o meses repetidos
 * (por sede, por profesional) van en la tabla.
 */
function drawingOf(table: ArgosTable): Drawing | null {
  if (table.rows.length < 2 || table.truncated) return null
  const numbers = table.columns.filter((column) => column.kind === "number")
  const value = numbers.find((column) => /_dinero$/.test(column.name)) ?? numbers[0]
  if (!value || numbers.length > 2) return null
  if (table.rows.some((row) => typeof row[value.name] !== "number" || (row[value.name] as number) < 0)) return null
  const once = (name: string) => new Set(table.rows.map((row) => row[name])).size === table.rows.length
  const month = table.columns.find((column) => (column.kind === "date" || column.kind === "timestamp") && /(^|_)mes$/.test(column.name))
  if (month) return table.columns.length === 2 && table.rows.length <= 24 && once(month.name) ? { kind: "months", month, value } : null
  const label = table.columns.find((column) => column.kind === "text")
  return label && table.columns.length <= 3 && table.rows.length <= 12 && once(label.name) ? { kind: "bars", label, value } : null
}

function AnswerDrawing({ table, title }: { table: ArgosTable; title: string }) {
  const locale = useOrgLocale() ?? "es"
  const drawing = drawingOf(table)
  if (!drawing) return null
  const valueAt = (index: number) => Number(table.rows[index]?.[drawing.value.name] ?? 0)
  const textAt = (index: number, name: string) => table.display[index]?.[name] ?? ""
  if (drawing.kind === "months") {
    // Los meses de izquierda a derecha aunque la consulta los traiga del último al primero.
    const order = table.rows.map((_, index) => index).sort((a, b) => String(table.rows[a]?.[drawing.month.name]).localeCompare(String(table.rows[b]?.[drawing.month.name])))
    const shown = new Map(order.map((index) => [valueAt(index), textAt(index, drawing.value.name)]))
    return (
      <ColumnChart
        title={title}
        height={140}
        categories={order.map((index) => {
          const label = textAt(index, drawing.month.name)
          return { key: String(index), label, short: label.slice(0, 3), partial: false }
        })}
        bars={[{ key: drawing.value.name, label: drawing.value.label, tone: "series-1", values: order.map((index) => valueAt(index)) }]}
        format={(value) => shown.get(value) ?? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)}
        axis={(value) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)}
        tableHeading={drawing.month.label}
      />
    )
  }
  const others = table.columns.filter((column) => column.name !== drawing.label.name && column.name !== drawing.value.name)
  return (
    <BarList
      title={title}
      size="sm"
      rows={table.rows.map((_, index) => {
        const note = others.map((column) => `${column.label}: ${textAt(index, column.name)}`).join(" · ")
        return { key: String(index), label: textAt(index, drawing.label.name), value: valueAt(index), valueText: textAt(index, drawing.value.name), ...(note ? { note } : {}) }
      })}
      table={{ label: drawing.label.label, value: drawing.value.label, ...(others.length ? { note: "Detalle" } : {}) }}
    />
  )
}

/** La persona de una fila, por los ids que la tabla trae y no muestra. */
function personOf(row: ArgosTable["rows"][number]): { patientId: string | null; contactId: string | null } | null {
  const patientId = typeof row.paciente_id === "string" ? row.paciente_id : null
  const contactId = typeof row.persona_id === "string" ? row.persona_id : null
  return patientId || contactId ? { patientId, contactId } : null
}

/** La tabla cuando no hay dibujo y hay más de una cifra que leer; cada nombre abre su página (`PersonLink`). */
function AnswerRows({ table }: { table: ArgosTable }) {
  const [all, setAll] = useState(false)
  // Sin filas, la frase ya lo dice («En setiembre no se cobró nada»): una tabla vacía no agrega nada.
  if (drawingOf(table) || table.columns.length === 0 || table.rows.length === 0 || (table.rows.length <= 1 && table.columns.length <= 1)) return null
  const rows = all ? table.rows : table.rows.slice(0, ROWS_SHOWN)
  const [lead, ...rest] = table.columns
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ScrollArea horizontal className="max-w-full rounded-lg border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              {table.columns.map((column) => (
                <th key={column.name} scope="col" className={cn("px-2.5 py-1.5 font-semibold", column.kind === "number" && "text-right")}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const person = lead?.kind === "text" ? personOf(row) : null
              const display = table.display[index] ?? {}
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: las filas de una respuesta no se reordenan.
                <tr key={index} className="border-t">
                  <td className="px-2.5 py-1.5">
                    {person && lead ? (
                      <PersonLink
                        patientId={person.patientId}
                        contactId={person.contactId}
                        className="font-semibold text-primary-soft-foreground underline underline-offset-2"
                      >
                        {display[lead.name]}
                      </PersonLink>
                    ) : (
                      (lead ? display[lead.name] : "")
                    )}
                  </td>
                  {rest.map((column) => (
                    <td key={column.name} className={cn("px-2.5 py-1.5", column.kind === "number" && "text-right tabular-nums")}>
                      {display[column.name]}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollArea>
      {table.rows.length > ROWS_SHOWN ? (
        <Button type="button" variant="link" className="min-h-11 self-start px-0 text-[13px] sm:min-h-8" onClick={() => setAll(!all)}>
          {all ? "Ver menos" : `Ver las ${table.truncated ? `más de ${table.rows.length}` : table.rows.length}`}
        </Button>
      ) : null}
    </div>
  )
}

/** Una respuesta ya llena, sin sus acciones: la frase y el dibujo o la tabla. La usa también el Resumen. */
export function ArgosShownView({ shown, title }: { shown: ArgosShown; title: string }) {
  return (
    <>
      <Sentence parts={shown.sentence} />
      <AnswerDrawing table={shown.table} title={title} />
      <AnswerRows table={shown.table} />
    </>
  )
}

/** La respuesta (tableros 2 y 7): el periodo, frase, dibujo o tabla, «Así lo calculé», acciones y los botones para seguir. */
function ArgosAnswer({
  exchange,
  onOption,
  onPeriod,
  onPatient,
}: {
  exchange: Exchange
  onOption: (option: number | null) => void
  onPeriod: (choice: ArgosChoice) => void
  onPatient: (patientId: string | undefined) => void
}) {
  const result = exchange.result
  const role = useMyRole()
  const locale = useOrgLocale() ?? "es"
  const queryClient = useQueryClient()
  const [pinned, setPinned] = useState<Array<number | null>>([])
  const pin = useMutation({
    retry: false,
    mutationFn: (option: number | null) => (result?.kind === "respuesta" ? pinArgos(result.questionId, option, exchange.patientId) : Promise.reject(new Error("sin respuesta"))),
    onSuccess: (_data, option) => {
      setPinned((current) => [...current, option])
      toast.success("Fijada en el Resumen: se vuelve a calcular cada vez que lo abres")
      return queryClient.invalidateQueries({ queryKey: PINS_KEY })
    },
  })
  const download = useMutation({
    retry: false,
    mutationFn: (input: { option: number | null; title: string }) =>
      // Se descarga lo que se ve: la opción, con su periodo y su sede.
      result?.kind === "respuesta"
        ? downloadArgos(result.questionId, input.option, input.title, { ...choiceOf(result.period), ...(exchange.patientId ? { patientId: exchange.patientId } : {}) })
        : Promise.resolve(),
    onError: (error) => toast.error(mutationErrorMessage(error)),
  })
  if (result?.kind !== "respuesta") return null
  // Dos pacientes que se llaman igual (D23): primero se elige; elegir vuelve a calcular sin el modelo.
  if (result.choose && exchange.patientId && !exchange.patientReady)
    return exchange.recalcError ? (
      <div role="alert" className={ANSWER}>
        <p>{exchange.recalcError}</p>
        <Button type="button" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => onPatient(undefined)}>
          Elegir otra vez
        </Button>
      </div>
    ) : (
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-primary-soft-foreground">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        Calculando…
      </p>
    )
  if (result.choose && !exchange.patientId)
    return (
      <div className={ANSWER}>
        <p className="text-[15px] leading-6">{result.choose.message}</p>
        <div className="flex flex-col gap-2">
          {result.choose.options.map((item) => (
            <Button key={item.id} type="button" variant="outline" className="h-auto min-h-11 justify-start whitespace-normal text-left" onClick={() => onPatient(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>
        <p className="text-[13px] text-muted-foreground">Elegir no vuelve a preguntarle a Argos.</p>
      </div>
    )
  const option = exchange.option === null ? null : (result.options.find((item) => item.index === exchange.option) ?? null)
  const shown: ArgosShown = option ? option.answer : result
  const title = option ? `${result.title} · ${option.label}` : result.title
  const link = result.screen === "ninguna" ? null : ARGOS_SCREEN_LINKS[result.screen]
  const isPinned = pinned.includes(exchange.option)
  // «Parcial» y «Falta» son de la respuesta principal; una opción es otra consulta, con su propio cálculo.
  const partial = option ? null : { partial: result.partial, missing: result.missing }
  const how = option ? option.how : result.how
  return (
    <div className={ANSWER}>
      <ArgosPeriodRow
        period={result.period}
        locale={locale}
        disabled={exchange.recalculating === true}
        onChange={(change) => onPeriod({ ...choiceOf(result.period), ...change, ...(exchange.patientId ? { patientId: exchange.patientId } : {}) })}
      />
      {exchange.recalculating ? (
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-primary-soft-foreground">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          Calculando…
        </p>
      ) : null}
      {exchange.recalcError ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-[13px]">
          <p>
            {exchange.recalcError} Sigues viendo {result.period.label.charAt(0).toLocaleLowerCase(locale) + result.period.label.slice(1)}.
          </p>
          {exchange.lastChoice ? (
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => exchange.lastChoice && onPeriod(exchange.lastChoice)}>
              Intentar de nuevo
            </Button>
          ) : null}
        </div>
      ) : null}
      {partial?.partial ? (
        <Badge variant="outline" className="self-start">
          Parcial
        </Badge>
      ) : null}
      {/* Mientras se calcula, lo de antes queda a la vista, atenuado. */}
      <div className={cn("flex min-w-0 flex-col gap-3", exchange.recalculating && "opacity-50")}>
        <ArgosShownView shown={shown} title={title} />
      </div>
      {partial?.missing ? <p className="text-[13px] text-muted-foreground">Falta: {partial.missing}</p> : null}
      {/* De dónde sale (D21): la misma cuenta de Reportes o una lectura de Argos, que se revisa en «Así lo calculé». */}
      <Badge variant={result.source === "oficial" ? "soft" : "outline"} className="self-start">
        {result.source === "oficial" ? "Cifra oficial · la misma cuenta de Reportes" : "Cálculo de Argos"}
      </Badge>
      {how ? (
        <p className="text-[13px] text-muted-foreground">
          <span className="font-bold text-foreground">Así lo calculé:</span> {how}
        </p>
      ) : null}
      {result.choose && exchange.patientId ? (
        <Button type="button" variant="ghost" size="sm" className="min-h-11 self-start text-primary-soft-foreground sm:min-h-8" onClick={() => onPatient(undefined)}>
          Era otro paciente
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {isPinned ? (
          // Sigue en el orden del teclado y dice que ya está, en vez de desaparecer como un botón apagado.
          <Button type="button" variant="outline" aria-disabled className="min-h-11 cursor-default opacity-70 sm:min-h-9">
            <Pin aria-hidden />
            Fijada en Resumen
          </Button>
        ) : (
          <SubmitButton type="button" variant="outline" className="min-h-11 sm:min-h-9" pending={pin.isPending} onClick={() => pin.mutate(exchange.option)}>
            <Pin aria-hidden />
            Fijar en Resumen
          </SubmitButton>
        )}
        {shown.table.rows.length > 0 ? (
          <SubmitButton
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            pending={download.isPending}
            onClick={() => download.mutate({ option: exchange.option, title })}
          >
            <Download aria-hidden />
            Descargar
          </SubmitButton>
        ) : null}
        {link && canOpenHref(role, link.to) ? (
          <Link to={link.to} className={cn(buttonVariants({ variant: "ghost" }), "min-h-11 text-primary-soft-foreground sm:min-h-9")}>
            {link.label}
          </Link>
        ) : null}
      </div>
      {pin.isError ? (
        <p role="alert" className="text-[13px] text-destructive">
          {mutationErrorMessage(pin.error)}
        </p>
      ) : null}
      {result.options.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <fieldset className="flex min-w-0 flex-wrap gap-1.5">
            <legend className="sr-only">Seguir con</legend>
            {result.options.map((item) => {
              const active = exchange.option === item.index
              return (
                <Button
                  key={item.index}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  aria-pressed={active}
                  className="min-h-11 rounded-full sm:min-h-8"
                  onClick={() => onOption(active ? null : item.index)}
                >
                  {item.label}
                </Button>
              )
            })}
          </fieldset>
          <p className="text-[12px] text-muted-foreground">Estos botones muestran la misma respuesta con otro orden o grupo, sin volver a preguntarle a {ADMIN_NAME}.</p>
        </div>
      ) : null}
    </div>
  )
}

/** Lo que dice Argos cuando no hay una respuesta con cifras (tableros 4 y 5), con su salida. */
function ArgosReply({ exchange, onRetry, onClose }: { exchange: Exchange; onRetry: () => void; onClose: () => void }) {
  const role = useMyRole()
  const canAgent = usePermission("agent.write")
  const result = exchange.result
  if (!result || result.kind === "respuesta") return null
  return (
    <div className={ANSWER}>
      <p className="text-[15px] leading-6">{result.message}</p>
      {result.kind === "no_existe" ? (
        <>
          {result.missing && result.missing !== result.message ? <p className="text-[13px] text-muted-foreground">Falta: {result.missing}</p> : null}
          {result.closest ? (
            <div className="flex flex-col gap-2 border-t pt-2.5">
              <p className="text-[13px] font-bold text-muted-foreground">Lo más cercano que sí tengo:</p>
              <Sentence parts={result.closest.sentence} />
              <AnswerDrawing table={result.closest.table} title="Lo más cercano" />
              <AnswerRows table={result.closest.table} />
            </div>
          ) : null}
        </>
      ) : null}
      {result.kind === "apagado" ? (
        canAgent ? (
          <Link to="/agent/administrador" className={cn(buttonVariants({ size: "sm" }), "min-h-11 self-start sm:min-h-9")}>
            Encender a {ADMIN_NAME}
          </Link>
        ) : (
          <p className="text-[13px] text-muted-foreground">Pídeselo a quien administra la clínica.</p>
        )
      ) : null}
      {result.kind === "tope" && canOpenHref(role, "/reports") ? (
        <Link to="/reports" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 self-start sm:min-h-9")}>
          Abrir Reportes
        </Link>
      ) : null}
      {result.kind === "sin_modelo" || result.kind === "no_pudo" ? (
        <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-9" onClick={onRetry}>
          Intentar de nuevo
        </Button>
      ) : null}
      {result.kind === "ayuda" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 self-start sm:min-h-9"
          onClick={() => {
            onClose()
            askHelp(exchange.question)
          }}
        >
          Abrir Ayuda con esta pregunta
        </Button>
      ) : null}
    </div>
  )
}

/**
 * El panel de Argos, montado una vez en el layout para quien ve Reportes. Lo
 * abre el evento del buscador o del campo de Reportes (`openArgos`).
 */
export function ArgosPanel() {
  const allowed = usePermission("reports.read")
  const [open, setOpen] = useState(false)
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [draft, setDraft] = useState("")
  const next = useRef(1)
  const end = useRef<HTMLDivElement>(null)
  // El periodo y la sede de Reportes siguen valiendo para lo que se escribe después en el panel (D7),
  // a la vista y con «Quitar»: así no se queda puesto sin que se sepa.
  const [screen, setScreen] = useState<{ query: ReportQuery; label: string } | null>(null)

  const update = (id: number, patch: Partial<Exchange>) => setExchanges((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  const ask = useMutation({
    retry: false,
    mutationFn: (input: { id: number; body: Parameters<typeof askArgos>[0] }) =>
      askArgos(input.body, (step) => setExchanges((current) => current.map((item) => (item.id === input.id ? { ...item, steps: [...(item.steps ?? []), step] } : item)))),
    onSuccess: (response, input) => update(input.id, { result: response.data }),
    onError: (error, input) =>
      update(input.id, {
        error: error instanceof ApiError && error.status !== 500 && error.shape.message ? error.shape.message : "No pude responder ahora. Vuelve a intentarlo en un momento.",
      }),
  })

  // Otro periodo o sede (D9): la misma consulta en el servidor, sin el modelo. Lo de antes queda hasta que llega lo nuevo.
  const recalc = useMutation({
    retry: false,
    mutationFn: (input: { id: number; questionId: string; choice: ArgosChoice }) => rerunArgos(input.questionId, input.choice),
    onMutate: (input) => update(input.id, { recalculating: true, recalcError: null, lastChoice: input.choice }),
    onSuccess: (response, input) =>
      setExchanges((current) =>
        current.map((item) => {
          if (item.id !== input.id || item.result?.kind !== "respuesta") return item
          const data = response.data
          const option = item.option !== null && data.options.some((offered) => offered.index === item.option) ? item.option : null
          return {
            ...item,
            recalculating: false,
            // La respuesta ya es la del paciente elegido, si se eligió uno.
            patientReady: item.patientId !== undefined,
            option,
            result: { ...item.result, text: data.text, sentence: data.sentence, table: data.table, how: data.how, options: data.options, period: data.period, source: data.source },
          }
        }),
      ),
    onError: (error, input) =>
      update(input.id, {
        recalculating: false,
        recalcError: error instanceof ApiError && error.status < 500 && error.shape.message ? error.shape.message : "No se pudo calcular con ese periodo.",
      }),
  })

  function push(question: string, options: { screen?: ReportQuery | undefined; routed?: boolean } = {}) {
    const id = next.current++
    // La anterior con respuesta viaja con su consulta, nunca con su resultado (D3): la de la opción que se
    // está viendo, para que «¿y de esos…?» hable de lo que está en la pantalla.
    const previous = [...exchanges].reverse().find((item) => item.result?.kind === "respuesta")
    const viewed = previous?.result?.kind === "respuesta" ? previous.result.options.find((item) => item.index === previous.option) : undefined
    const body = {
      text: question,
      ...(options.screen ? { screen: options.screen } : {}),
      previous:
        previous?.result?.kind === "respuesta"
          ? viewed
            ? { text: `${previous.question} (${viewed.label})`, query: viewed.query }
            : { text: previous.question, query: previous.result.query }
          : null,
      ...(options.routed ? { routed: true } : {}),
    }
    setExchanges((current) => [...current, { id, question, ...(options.screen ? { screen: options.screen } : {}), ...(options.routed ? { routed: true } : {}), result: null, error: null, option: null }])
    setOpen(true)
    ask.mutate({ id, body })
  }
  const pushRef = useRef(push)
  pushRef.current = push

  useEffect(() => {
    function onAsk(event: Event) {
      const detail = (event as CustomEvent<ArgosAskEvent>).detail
      const question = detail?.question?.trim() ?? ""
      setScreen(detail?.screen ? { query: detail.screen, label: detail.screenLabel ?? "" } : null)
      setOpen(true)
      if (question.length >= 3) pushRef.current(question, { screen: detail?.screen, ...(detail?.routed ? { routed: true } : {}) })
      else setDraft(question)
    }
    window.addEventListener(ASK_ARGOS_EVENT, onAsk)
    return () => window.removeEventListener(ASK_ARGOS_EVENT, onAsk)
  }, [])

  const last = exchanges[exchanges.length - 1]
  // biome-ignore lint/correctness/useExhaustiveDependencies: baja a la última respuesta cuando llega.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [last?.id, last?.result, last?.error])

  if (!allowed || !open) return null
  const pending = ask.isPending
  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length < 3 || pending) return
    push(text, { screen: screen?.query })
    setDraft("")
  }
  // Un solo aviso para el lector de pantalla con lo último que pasó, no la conversación entera.
  const live = !last
    ? ""
    : last.error
      ? ""
      : !last.result
        ? (last.steps?.at(-1) ?? "Consultando los datos…")
        : last.recalculating
          ? "Calculando…"
          : last.recalcError
            ? last.recalcError
        : last.result.kind === "respuesta"
          ? (last.result.options.find((item) => item.index === last.option)?.answer.text ?? last.result.text)
          : last.result.message
  const retry = (exchange: Exchange) => push(exchange.question, { screen: exchange.screen, ...(exchange.routed ? { routed: true } : {}) })

  return (
    // Se puede cerrar mientras pregunta: la respuesta llega igual a su pregunta y se ve al volver a abrir.
    <DetailDrawer open title={ADMIN_NAME} description={DESCRIPTION} onClose={() => setOpen(false)}>
      <div className="flex flex-col gap-4">
        {exchanges.length === 0 ? (
          <section aria-label="Prueba una pregunta" className="flex flex-col gap-1.5">
            <h3 className="text-[13px] font-bold text-muted-foreground">Prueba una pregunta</h3>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLES.map((sample) => (
                <Button key={sample} type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={pending} onClick={() => push(sample, { screen: screen?.query })}>
                  {sample}
                </Button>
              ))}
            </div>
          </section>
        ) : (
          <ol className="flex flex-col gap-4" aria-label="Preguntas y respuestas">
            {exchanges.map((exchange) => (
              <li key={exchange.id} className="flex flex-col gap-3">
                <p className="max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
                  <span className="sr-only">Preguntaste: </span>
                  {exchange.question}
                </p>
                {exchange.error ? (
                  <div className={ANSWER}>
                    <p role="alert" className="text-[15px] leading-6">
                      {exchange.error}
                    </p>
                    <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-9" disabled={pending} onClick={() => retry(exchange)}>
                      Intentar de nuevo
                    </Button>
                  </div>
                ) : !exchange.result ? (
                  <ArgosSteps steps={exchange.steps ?? []} />
                ) : exchange.result.kind === "respuesta" ? (
                  <ArgosAnswer
                    exchange={exchange}
                    onOption={(option) => update(exchange.id, { option })}
                    onPeriod={(choice) => {
                      if (exchange.result?.kind === "respuesta") recalc.mutate({ id: exchange.id, questionId: exchange.result.questionId, choice })
                    }}
                    onPatient={(patientId) => {
                      if (exchange.result?.kind !== "respuesta") return
                      update(exchange.id, { patientId, patientReady: false, recalcError: null })
                      if (patientId) recalc.mutate({ id: exchange.id, questionId: exchange.result.questionId, choice: { ...choiceOf(exchange.result.period), patientId } })
                    }}
                  />
                ) : (
                  <ArgosReply exchange={exchange} onRetry={() => retry(exchange)} onClose={() => setOpen(false)} />
                )}
              </li>
            ))}
          </ol>
        )}
        <div ref={end} />
        <p role="status" className="sr-only">
          {live}
        </p>
        <div className="flex flex-col gap-2 border-t pt-3.5">
          {screen ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="min-w-0">
                Con lo de Reportes{screen.label ? <>: <span className="font-semibold text-foreground">{screen.label}</span></> : null}
              </span>
              <Button type="button" variant="link" className="min-h-11 px-1 text-[13px] sm:min-h-8" onClick={() => setScreen(null)}>
                Quitar
              </Button>
            </div>
          ) : null}
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
                  disabled={draft.trim().length < 3 || pending}
                  aria-busy={pending}
                >
                  <ArrowRight aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <p className="text-[13px] text-muted-foreground">Ve lo mismo que tú. Nunca cambia nada.</p>
        </div>
      </div>
    </DetailDrawer>
  )
}

/**
 * El campo de Reportes (D7): pregunta con el periodo y la sede de la pantalla y
 * abre el panel. Con Argos apagado lo dice.
 */
export function ArgosReportField({ query, label, enabled }: { query: ReportQuery; label?: string | undefined; enabled: boolean | undefined }) {
  const canAgent = usePermission("agent.write")
  const [draft, setDraft] = useState("")
  const off = enabled === false
  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length < 3 || off) return
    openArgos({ question: text, screen: query, ...(label ? { screenLabel: label } : {}) })
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
            disabled={off}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Pregúntale a ${ADMIN_NAME}: ¿qué se vendió más este mes?`}
          />
          <InputGroupAddon align="inline-end" className="pr-1.5">
            <InputGroupButton type="submit" variant="default" size="sm" className="min-h-11 rounded-lg px-3 sm:min-h-8" disabled={off || draft.trim().length < 3}>
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
      ) : null}
    </div>
  )
}
