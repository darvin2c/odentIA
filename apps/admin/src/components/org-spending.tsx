/**
 * Ficha de la clínica › Gastos (lienzo «Gastos por organización», tableros 2
 * a 6): el mes con lo que paga, lo que nos costó y el margen, el costo de IA
 * por día, la tabla por agente y tipo y cada acción, que se abre para ver de
 * qué se compone. Solo lo ve el rol admin (ADR 0094).
 */
import { Badge, Button, ScrollArea, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { ColumnChart, EmptyState, ErrorState, LoadingState, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ReceiptText } from "lucide-react"
import { Fragment, type ReactNode, useState } from "react"
import { api } from "../lib/api"
import { cost, costNumber, money, plural, priceNumber } from "../lib/cost-format"
import type { ClinicCostMargin } from "./cost-margin"
import { OrgSpendingSkeleton } from "./skeletons/organization-detail"

export type SpendingAgent = "todo" | "sofi" | "clio" | "argos" | "sin_cobro"
export type SpendingMonth = "actual" | "anterior"

interface CostActionItem {
  key: string
  agent: "sofi" | "clio" | "argos"
  type: string
  occurredAt: string
  who: string | null
  whoDetail: string | null
  what: string
  chargedMicros: number | null
  chargedNote: string | null
  costMicros: number
  calls: number
  spread: boolean
  free: boolean
  professionalId: string | null
  channel: string | null
  steps: number | null
  outcome?: string
}

interface CostActionList {
  period: { start: string; end: string; credit: "prueba" | "mes" }
  timezone: string
  items: CostActionItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<SpendingAgent, number>
  freeCounts: Record<"sofi" | "clio", number>
  professionals: Array<{ id: string; name: string; count: number }>
  channels: Array<{ channel: string; count: number }>
  askers: Array<{ name: string; count: number }>
  days: Array<{ day: string; costMicros: number; ahead: boolean }>
  questions: { counted: number; included: number; free: number }
}

interface CostActionDetail {
  key: string
  agent: "sofi" | "clio" | "argos"
  steps: Array<{
    id: string
    at: string
    what: string
    model: string
    calls: number
    inputTokens: number | null
    outputTokens: number | null
    costMicros: number
  }>
  facts: Array<{ label: string; value: string }>
  costMicros: number
  spread: boolean
}

export interface SpendingSearch {
  agente: SpendingAgent
  mes: SpendingMonth
  profesional?: string
  canal?: string
  pagina: number
}

const AGENT_NAME: Record<CostActionItem["agent"], string> = {
  sofi: "Sofi",
  clio: "Clío",
  argos: "Argos",
}
const CHIPS: Array<{ value: SpendingAgent; label: string }> = [
  { value: "todo", label: "Todo" },
  { value: "sofi", label: "Sofi" },
  { value: "clio", label: "Clío" },
  { value: "argos", label: "Argos" },
  { value: "sin_cobro", label: "Sin cobro" },
]
const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  facebook: "Facebook",
  telegram: "Telegram",
  webchat: "Chat web",
  email: "Correo",
}

function useClock(timezone: string) {
  const when = new Intl.DateTimeFormat("es-PE", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const hour = new Intl.DateTimeFormat("es-PE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  })
  return {
    when: (iso: string) => when.format(new Date(iso)),
    hour: (iso: string) => hour.format(new Date(iso)),
  }
}

const dayLabel = (day: string, long = false) =>
  new Intl.DateTimeFormat(
    "es-PE",
    long ? { day: "numeric", month: "long", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" },
  ).format(new Date(`${day}T12:00:00Z`))

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail?: string
  tone?: "alarma" | "bien"
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-lg font-semibold tabular-nums ${tone === "alarma" ? "text-destructive" : tone === "bien" ? "text-success" : ""}`}
      >
        {value}
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

/** Lo cobrado de una acción, o lo que se dice en su lugar («Incluida», «12 de 300»). */
function chargedText(item: CostActionItem): string {
  if (item.chargedMicros !== null) return priceNumber(item.chargedMicros)
  return item.chargedNote ?? "—"
}

function CostCell({ item }: { item: CostActionItem }) {
  return (
    <span className="tabular-nums">
      {costNumber(item.costMicros)}
      {item.spread ? <span className="ml-1 text-xs text-muted-foreground">repartido</span> : null}
    </span>
  )
}

/** Las columnas de cada vista: la de todo y las de cada agente (tableros 2 a 5). */
function columnsOf(
  agent: SpendingAgent,
  clock: ReturnType<typeof useClock>,
): Array<{ heading: string; numeric?: boolean; cell: (item: CostActionItem) => ReactNode }> {
  const when = {
    heading: "Cuándo",
    cell: (item: CostActionItem) => (
      <span className="whitespace-nowrap tabular-nums">{clock.when(item.occurredAt)}</span>
    ),
  }
  const who = (heading: string) => ({
    heading,
    cell: (item: CostActionItem) => (
      <span className="whitespace-nowrap">
        {item.who ?? "—"}
        {item.whoDetail ? (
          <span className="block text-xs text-muted-foreground">{item.whoDetail}</span>
        ) : null}
      </span>
    ),
  })
  const charged = {
    heading: "Cobrado",
    numeric: true,
    cell: (item: CostActionItem) => (
      <span
        className={`whitespace-nowrap ${item.chargedMicros === null ? "text-muted-foreground" : "tabular-nums"}`}
      >
        {chargedText(item)}
      </span>
    ),
  }
  const costed = {
    heading: "Nos costó",
    numeric: true,
    cell: (item: CostActionItem) => <CostCell item={item} />,
  }
  const what = (heading: string) => ({
    heading,
    cell: (item: CostActionItem) => (
      <span className={item.free ? "text-muted-foreground" : ""}>{item.what}</span>
    ),
  })
  if (agent === "sofi")
    return [
      when,
      who("Persona"),
      { heading: "Tipo", cell: (item) => item.type },
      what("Qué pasó"),
      {
        heading: "Respuestas",
        numeric: true,
        cell: (item) => (item.steps === null ? "—" : item.steps),
      },
      charged,
      costed,
    ]
  if (agent === "clio")
    return [
      when,
      {
        heading: "Profesional",
        cell: (item) => <span className="whitespace-nowrap">{item.who ?? "—"}</span>,
      },
      {
        heading: "Paciente",
        cell: (item) => (
          <span className="whitespace-nowrap">{item.whoDetail?.replace(/^con /, "") ?? "—"}</span>
        ),
      },
      { heading: "Tipo", cell: (item) => item.type },
      what("Qué dejó hecho"),
      { heading: "Pausas", numeric: true, cell: (item) => item.steps ?? "—" },
      charged,
      costed,
    ]
  if (agent === "argos")
    return [
      when,
      who("Quién"),
      what("Lo que entendió Argos"),
      {
        heading: "Cómo terminó",
        cell: (item) => (
          <Badge
            variant={
              item.outcome === "Respondida"
                ? "success"
                : item.free || item.outcome === "Sin la cifra"
                  ? "warning"
                  : "outline"
            }
          >
            {item.outcome ?? item.type}
          </Badge>
        ),
      },
      {
        heading: "Cuenta",
        numeric: true,
        cell: (item) => (
          <span
            className={
              item.chargedMicros === null
                ? "whitespace-nowrap text-muted-foreground"
                : "tabular-nums"
            }
          >
            {chargedText(item)}
          </span>
        ),
      },
      costed,
    ]
  return [
    when,
    {
      heading: "Agente y tipo",
      cell: (item) => (
        <span className="whitespace-nowrap">{`${AGENT_NAME[item.agent]} · ${item.type}`}</span>
      ),
    },
    who("Quién"),
    what("Qué hizo"),
    charged,
    costed,
  ]
}

/** De qué se compone una acción, al abrirla: pausas, respuestas o llamadas, con su costo. */
function ActionDetail({
  organizationId,
  month,
  item,
  clock,
}: {
  organizationId: string
  month: SpendingMonth
  item: CostActionItem
  clock: ReturnType<typeof useClock>
}) {
  const detail = useQuery({
    queryKey: ["admin", "cost-action", organizationId, month, item.key],
    queryFn: () =>
      api<CostActionDetail>(
        `/api/admin/billing/cost-margin/${organizationId}/actions/${item.key}?periodo=${month}`,
      ),
  })
  if (detail.isPending) return <LoadingState message="Cargando el detalle…" />
  if (detail.isError)
    return <ErrorState title="No se pudo cargar el detalle" onRetry={() => void detail.refetch()} />
  const data = detail.data
  const stepName =
    item.agent === "clio"
      ? "Lo que sugirió"
      : item.agent === "sofi" || item.type === "Cita recuperada"
        ? "Qué hizo"
        : "Llamada"
  return (
    <div className="flex flex-col gap-3 py-1">
      {data.facts.length ? (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
          {data.facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {data.steps.length ? (
        <ScrollArea horizontal className="max-w-full">
          <table className="relative w-full text-sm">
            <caption className="sr-only">
              {item.agent === "clio"
                ? "Pausas de la atención"
                : item.agent === "sofi" || item.type === "Cita recuperada"
                  ? "Respuestas de Sofi"
                  : "Llamadas al proveedor"}
            </caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                {item.agent === "clio" ? (
                  <th scope="col" className="px-2 py-1 font-medium">
                    Pausa
                  </th>
                ) : null}
                <th scope="col" className="px-2 py-1 font-medium">
                  Hora
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {stepName}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  Modelo
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Llamadas
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Tokens (entra / sale)
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Nos costó
                </th>
              </tr>
            </thead>
            <tbody>
              {data.steps.map((step, index) => (
                <tr key={step.id} className="border-t border-border/60">
                  {item.agent === "clio" ? (
                    <td className="px-2 py-1 tabular-nums">{index + 1}</td>
                  ) : null}
                  <td className="px-2 py-1 tabular-nums">{clock.hour(step.at)}</td>
                  <td className="px-2 py-1">{step.what}</td>
                  <td className="px-2 py-1 text-muted-foreground">{step.model}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{step.calls}</td>
                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                    {step.inputTokens === null ? "—" : step.inputTokens.toLocaleString("es-PE")} /{" "}
                    {step.outputTokens === null ? "—" : step.outputTokens.toLocaleString("es-PE")}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {costNumber(step.costMicros)}
                  </td>
                </tr>
              ))}
              <tr className="border-t font-medium">
                <td className="px-2 py-1" colSpan={item.agent === "clio" ? 6 : 5}>
                  Nos costó
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{costNumber(data.costMicros)}</td>
              </tr>
            </tbody>
          </table>
        </ScrollArea>
      ) : (
        <p className="text-sm text-muted-foreground">
          {data.spread
            ? `Esta pregunta es de antes de anotarse el costo por pregunta: se repartió lo del día entre sus preguntas (${cost(data.costMicros)}).`
            : item.costMicros > 0
              ? "No hay llamadas que mostrar."
              : "No llamó a ningún modelo: no costó nada."}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {item.agent === "clio"
          ? "La voz se convierte en texto en el navegador del profesional: no hay audio ni costo de transcripción. Lo que cuesta es que Clío entienda cada pausa. No se muestra lo dictado ni el diagnóstico: son datos clínicos."
          : item.agent === "sofi" || item.type === "Cita recuperada"
            ? "La conversación no se abre desde aquí: se lee solo con el permiso de la clínica, en una revisión de cobro. Cada fila sale del registro de lo que hizo Sofi, sin el texto de los mensajes."
            : "Lo que escribió la persona no se guarda: puede llevar nombres de pacientes. Esto es lo que Argos entendió."}
      </p>
    </div>
  )
}

function Paging({ data, onPage }: { data: CostActionList; onPage: (page: number) => void }) {
  const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0
  const to = Math.min(data.total, data.page * data.pageSize)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        {from}–{to} de {data.total}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={data.page <= 1}
          onClick={() => onPage(data.page - 1)}
        >
          Anteriores
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={to >= data.total}
          onClick={() => onPage(data.page + 1)}
        >
          Siguientes
        </Button>
      </div>
    </div>
  )
}

/** Cada acción: una tabla en la computadora y tarjetas en el teléfono, cada una se abre. */
function ActionList({
  organizationId,
  search,
  data,
  onPage,
}: {
  organizationId: string
  search: SpendingSearch
  data: CostActionList
  onPage: (page: number) => void
}) {
  const clock = useClock(data.timezone)
  const [open, setOpen] = useState<string | null>(null)
  const columns = columnsOf(search.agente, clock)
  if (!data.items.length)
    return (
      <EmptyState
        icon={ReceiptText}
        title="Sin acciones"
        description={
          search.profesional || search.canal
            ? "No hay acciones con este filtro en el mes."
            : "Los agentes no hicieron nada que cuente en este mes."
        }
      />
    )
  const toggle = (key: string) => setOpen((current) => (current === key ? null : key))
  return (
    <div className="flex flex-col gap-3">
      <ScrollArea horizontal className="hidden max-w-full rounded-xl border bg-card px-2 md:block">
        <table className="relative w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="w-10 px-2 py-2 font-medium">
                <span className="sr-only">Abrir</span>
              </th>
              {columns.map((column) => (
                <th
                  key={column.heading}
                  scope="col"
                  className={`whitespace-nowrap px-2 py-2 font-medium ${column.numeric ? "text-right" : ""}`}
                >
                  {column.heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const isOpen = open === item.key
              return (
                <Fragment key={item.key}>
                  <tr
                    className={`border-b border-border/60 align-top ${isOpen ? "bg-muted/40" : ""}`}
                  >
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Cerrar" : "Abrir"} el detalle: ${AGENT_NAME[item.agent]} · ${item.type}, ${clock.when(item.occurredAt)}`}
                        onClick={() => toggle(item.key)}
                      >
                        {isOpen ? "−" : "+"}
                      </Button>
                    </td>
                    {columns.map((column) => (
                      <td
                        key={column.heading}
                        className={`px-2 py-2 ${column.numeric ? "text-right" : ""}`}
                      >
                        {column.cell(item)}
                      </td>
                    ))}
                  </tr>
                  {isOpen ? (
                    <tr className="border-b bg-muted/40">
                      <td />
                      <td colSpan={columns.length} className="px-2 pb-3">
                        <ActionDetail
                          organizationId={organizationId}
                          month={search.mes}
                          item={item}
                          clock={clock}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </ScrollArea>
      <ul className="flex flex-col gap-2 md:hidden">
        {data.items.map((item) => {
          const isOpen = open === item.key
          return (
            <li
              key={item.key}
              className={`flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm ${isOpen ? "border-muted-foreground" : ""}`}
            >
              <div className="flex justify-between gap-2">
                <b>{`${AGENT_NAME[item.agent]} · ${item.outcome ?? item.type}`}</b>
                <span
                  className={item.chargedMicros === null ? "text-muted-foreground" : "tabular-nums"}
                >
                  {chargedText(item)}
                </span>
              </div>
              <p className={item.free ? "text-muted-foreground" : ""}>{item.what}</p>
              <p className="text-xs text-muted-foreground">
                {clock.when(item.occurredAt)}
                {item.who ? ` · ${item.who}` : ""}
                {item.whoDetail
                  ? ` ${item.agent === "clio" ? item.whoDetail : `· ${item.whoDetail}`}`
                  : ""}
                {` · nos costó ${costNumber(item.costMicros)}`}
                {item.spread ? " (repartido)" : ""}
              </p>
              {isOpen ? (
                <ActionDetail
                  organizationId={organizationId}
                  month={search.mes}
                  item={item}
                  clock={clock}
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Ocultar" : "Ver"} el detalle: ${AGENT_NAME[item.agent]} · ${item.type}, ${clock.when(item.occurredAt)}`}
                onClick={() => toggle(item.key)}
              >
                {isOpen ? "Ocultar el detalle" : "Ver el detalle"}
              </Button>
            </li>
          )
        })}
      </ul>
      <Paging data={data} onPage={onPage} />
    </div>
  )
}

/** La tabla por agente y tipo: lo que se cobra, lo que no y lo que no es IA, con el total. */
function ByTypeTable({
  margin,
  onAgent,
}: {
  margin: ClinicCostMargin
  onAgent: (agent: SpendingAgent) => void
}) {
  const groups: Array<{ title: string; lines: ClinicCostMargin["lines"] }> = [
    {
      title: "Se cobra",
      lines: margin.lines.filter(
        (line) => line.group !== "regalo" && line.group !== "no_ia" && (line.count ?? 0) > 0,
      ),
    },
    {
      title: "No se cobra",
      lines: margin.lines.filter(
        (line) => line.group === "regalo" && ((line.count ?? 0) > 0 || line.costMicros > 0),
      ),
    },
    { title: "Lo que no es IA", lines: margin.lines.filter((line) => line.group === "no_ia") },
  ]
  const agentOf = (key: string): SpendingAgent | null => {
    if (key.endsWith("sin_cobro")) return "sin_cobro"
    if (key.startsWith("sofi")) return "sofi"
    if (key.startsWith("clio")) return "clio"
    if (
      key.startsWith("argos:cita") ||
      key.startsWith("argos:preguntas") ||
      key.startsWith("argos:paquetes")
    )
      return "argos"
    return null
  }
  const label = (line: ClinicCostMargin["lines"][number]) => {
    const name = { sofi: "Sofi", clio: "Clío", argos: "Argos" }[
      line.group as "sofi" | "clio" | "argos"
    ]
    return name ? (
      <>
        <b>{name}</b> · {line.label}
      </>
    ) : (
      line.label
    )
  }
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
      aria-labelledby="por-tipo"
    >
      <h2 id="por-tipo" className="px-1 text-base font-medium">
        Por agente y tipo
      </h2>
      <ScrollArea horizontal className="max-w-full">
        <table className="relative w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-2 font-medium">
                Agente · tipo
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Cuántas
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Cobrado
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Nos costó
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Margen
              </th>
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">Ver</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) =>
              group.lines.length ? (
                <Fragment key={group.title}>
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={6}
                      className="bg-muted/50 px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {group.title}
                    </th>
                  </tr>
                  {group.lines.map((line) => {
                    const agent = agentOf(line.key)
                    return (
                      <tr key={line.key} className="border-b border-border/60">
                        <td className="px-2 py-1.5">
                          {label(line)}
                          {line.note ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              {line.note.toLocaleLowerCase("es")}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{line.count ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {money(line.chargedCents, margin.currency)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {cost(line.costMicros, margin.currency)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {line.marginPct === null ? "—" : `${line.marginPct} %`}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {agent ? (
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              className="h-auto p-0"
                              onClick={() => onAgent(agent)}
                            >
                              Ver
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ) : null,
            )}
            <tr className="font-semibold">
              <td className="px-2 py-2">Total</td>
              <td />
              <td className="px-2 py-2 text-right tabular-nums">
                {money(margin.chargedCents, margin.currency)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {cost(margin.costMicros, margin.currency)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {margin.marginPct === null ? "—" : `${margin.marginPct} %`}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </ScrollArea>
      <p className="px-1 text-xs text-muted-foreground">
        La cuota vuelve como crédito: ya está dentro de lo cobrado. El costo de IA es lo que reportó
        cada proveedor en cada llamada. WhatsApp lo paga la clínica a Meta y no aparece aquí.
        {margin.unpricedCalls
          ? ` ${plural(margin.unpricedCalls, "llamada no tiene", "llamadas no tienen")} precio conocido y no están en el total.`
          : ""}
      </p>
      {margin.informBlocks?.windows ? <InformBlocksNote margin={margin} blocks={margin.informBlocks} /> : null}
    </section>
  )
}

/**
 * Informa por bloques de mensajes de la persona (ADR 0105), en sombra: lo que
 * se contaría con el tope del plan. Sirve para decidir el tope; nadie lo paga.
 */
function InformBlocksNote({
  margin,
  blocks,
}: {
  margin: ClinicCostMargin
  blocks: NonNullable<ClinicCostMargin["informBlocks"]>
}) {
  const over = blocks.over
    ? `${blocks.over} de ${plural(blocks.windows, "conversación", "conversaciones")} Informa ${blocks.over === 1 ? "pasaría" : "pasarían"} el tope; se ${blocks.extraInforma === 1 ? "contaría" : "contarían"} ${blocks.extraInforma} Informa más, ${money(blocks.extraCents, margin.currency)}.`
    : blocks.windows === 1
      ? "la única conversación Informa no pasó el tope."
      : `ninguna de las ${blocks.windows} conversaciones Informa pasó el tope.`
  const longest = blocks.maxMessages ? ` La más larga tuvo ${plural(blocks.maxMessages, "mensaje", "mensajes")} de la persona.` : ""
  return (
    <p className="px-1 text-xs text-muted-foreground">
      <b className="font-medium text-foreground">
        Informa por bloques de {plural(blocks.messageLimit, "mensaje", "mensajes")}, en sombra:
      </b>{" "}
      {over}
      {longest} No se cobra: solo se mide para decidir el tope.
    </p>
  )
}

/** Las cifras de arriba de cada agente: sus tipos con lo cobrado y lo que costó. */
function AgentCards({
  margin,
  agent,
  list,
}: {
  margin: ClinicCostMargin
  agent: "sofi" | "clio" | "argos"
  list: CostActionList
}) {
  const lines = margin.lines.filter(
    (line) =>
      line.group === agent &&
      (agent !== "argos" || line.key !== "argos:paquetes" || (line.count ?? 0) > 0),
  )
  const free = margin.lines.find((line) => line.key === `${agent}:sin_cobro`)
  if (agent === "argos") {
    const questions = margin.lines.find((line) => line.key === "argos:preguntas")
    const recovered = margin.lines.find((line) => line.key === "argos:cita")
    const messages = margin.lines.find((line) => line.key === "argos:mensajes")
    const q = list.questions
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <Stat
          label="Preguntas del mes"
          value={q.included ? `${q.counted} de ${q.included}` : String(q.counted)}
          detail={`${q.free ? `${plural(q.free, "más no contó", "más no contaron")} · ` : ""}nos costó ${cost(questions?.costMicros ?? 0)}`}
        />
        <Stat
          label="Citas recuperadas"
          value={`${recovered?.count ?? 0} · ${money(recovered?.chargedCents ?? 0, margin.currency)}`}
          detail={`Nos costó ${cost(recovered?.costMicros ?? 0)}${recovered?.marginPct === null || recovered?.marginPct === undefined ? "" : ` · margen ${recovered.marginPct} %`}`}
        />
        <Stat
          label="Recordatorios y pedidos"
          value={String(messages?.count ?? 0)}
          detail={`Son servicio: no se cobran · nos costó ${cost(messages?.costMicros ?? 0)}`}
        />
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {lines.map((line) => (
        <Stat
          key={line.key}
          label={`${line.label} · ${line.count ?? 0}`}
          value={money(line.chargedCents, margin.currency)}
          detail={`Nos costó ${cost(line.costMicros)}`}
        />
      ))}
      {free ? (
        <Stat
          label={`Sin cobro · ${list.freeCounts[agent]}`}
          value={money(0, margin.currency)}
          detail={`${agent === "sofi" ? "Pasó al equipo, ajeno o spam" : "Escuchó y no quedó nada confirmado"} · ${cost(free.costMicros)}`}
        />
      ) : null}
    </div>
  )
}

export function OrgSpending({
  organizationId,
  search,
  onSearch,
}: {
  organizationId: string
  search: SpendingSearch
  onSearch: (next: Partial<SpendingSearch>) => void
}) {
  const margin = useQuery({
    queryKey: ["admin", "cost-margin", organizationId, search.mes],
    queryFn: () =>
      api<ClinicCostMargin>(
        `/api/admin/billing/cost-margin/${organizationId}?periodo=${search.mes}`,
      ),
  })
  const params = new URLSearchParams({
    periodo: search.mes,
    agente: search.agente,
    pagina: String(search.pagina),
  })
  if (search.profesional) params.set("profesional", search.profesional)
  if (search.canal) params.set("canal", search.canal)
  const list = useQuery({
    queryKey: ["admin", "cost-actions", organizationId, params.toString()],
    queryFn: () =>
      api<CostActionList>(
        `/api/admin/billing/cost-margin/${organizationId}/actions?${params.toString()}`,
      ),
    placeholderData: (previous) => previous,
  })

  if (margin.isPending || list.isPending)
    return (
      <SkeletonRegion message="Cargando los gastos…">
        <OrgSpendingSkeleton overview={search.agente === "todo"} />
      </SkeletonRegion>
    )
  if (margin.isError)
    return <ErrorState title="No se pudo cargar el costo" onRetry={() => void margin.refetch()} />
  if (list.isError)
    return (
      <ErrorState title="No se pudieron cargar las acciones" onRetry={() => void list.refetch()} />
    )
  const data = margin.data
  const actions = list.data
  const overview = search.agente === "todo"
  const peak = actions.days.reduce<CostActionList["days"][number] | null>(
    (best, day) => (!best || day.costMicros > best.costMicros ? day : best),
    null,
  )
  const share = data.aiShareBps === null ? null : Math.round(data.aiShareBps / 100)
  const included = data.lines.filter((line) => line.group !== "regalo" && line.group !== "no_ia")
  const subtotal = included.reduce((sum, line) => sum + line.chargedCents, 0)

  const chips = (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Qué agente</legend>
      {CHIPS.map((chip) => (
        <Button
          key={chip.value}
          type="button"
          size="sm"
          variant={search.agente === chip.value ? "default" : "outline"}
          aria-pressed={search.agente === chip.value}
          className="rounded-full"
          onClick={() =>
            onSearch({ agente: chip.value, pagina: 1, profesional: undefined, canal: undefined })
          }
        >
          {`${chip.label} · ${actions.counts[chip.value]}`}
        </Button>
      ))}
    </fieldset>
  )
  const monthTabs = (
    <Tabs
      value={search.mes}
      onValueChange={(value) =>
        onSearch({
          mes: value as SpendingMonth,
          pagina: 1,
          profesional: undefined,
          canal: undefined,
        })
      }
    >
      <TabsList aria-label="Qué mes">
        <TabsTrigger value="actual">
          {data.period.credit === "prueba" ? "La prueba" : "Este mes"}
        </TabsTrigger>
        <TabsTrigger value="anterior">El anterior</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {overview ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {monthTabs}
            <p className="text-xs text-muted-foreground">Solo lo ve la administración</p>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat
              label="Lo que paga, sin impuestos"
              value={money(data.chargedCents, data.currency)}
              detail={
                data.period.credit === "prueba"
                  ? "La prueba es de regalo"
                  : `Lo que hicieron los agentes: ${money(subtotal, data.currency)}`
              }
            />
            <Stat
              label="Nos costó"
              value={cost(data.costMicros, data.currency)}
              detail={`IA ${cost(data.aiMicros)} · espacio ${cost(data.storageMicros)} · servidor ${cost(data.fixedMicros)}`}
            />
            <Stat
              label="Margen"
              value={data.marginPct === null ? "Sin cobro" : `${data.marginPct} %`}
              detail={
                data.sellerName
                  ? `Con la comisión de ${data.sellerName}: ${data.marginAfterCommissionPct ?? "—"} %`
                  : "Sin vendedor: no hay comisión"
              }
            />
            <Stat
              label="Alarma interna"
              value={data.alarm ? "Para revisar" : "Sin alarma"}
              tone={data.alarm ? "alarma" : "bien"}
              detail={`${share === null ? "Sin cobro todavía" : `La IA es el ${share} % de lo que paga`}. Avisa desde el 20 % o USD 30.`}
            />
          </div>
          <section
            className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
            aria-labelledby="costo-dia"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="costo-dia" className="text-base font-medium">
                Costo de IA por día
              </h2>
              {peak && peak.costMicros > 0 ? (
                <p className="text-xs text-muted-foreground">
                  El día más alto: {dayLabel(peak.day, true)}, {cost(peak.costMicros)}
                </p>
              ) : null}
            </div>
            <ColumnChart
              title="Costo de IA por día"
              tableHeading="Día"
              categories={actions.days.map((day) => ({
                key: day.day,
                label: dayLabel(day.day, true),
                short: dayLabel(day.day),
                partial: day.ahead,
              }))}
              bars={[
                {
                  key: "ia",
                  label: "Costo de IA",
                  tone: "series-1",
                  values: actions.days.map((day) => (day.ahead ? null : day.costMicros)),
                },
              ]}
              format={(value) => cost(value)}
              axis={(value) => costNumber(value)}
              height={160}
            />
          </section>
          <ByTypeTable margin={data} onAgent={(agent) => onSearch({ agente: agent, pagina: 1 })} />
          <section className="flex flex-col gap-3" aria-labelledby="cada-accion">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="cada-accion" className="text-base font-medium">
                Cada acción
              </h2>
              {chips}
            </div>
            <ActionList
              organizationId={organizationId}
              search={search}
              data={actions}
              onPage={(pagina) => onSearch({ pagina })}
            />
          </section>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {chips}
            {monthTabs}
          </div>
          {search.agente === "sofi" || search.agente === "clio" || search.agente === "argos" ? (
            <AgentCards margin={data} agent={search.agente} list={actions} />
          ) : null}
          <section className="flex flex-col gap-3" aria-labelledby="lista-agente">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="lista-agente" className="text-base font-medium">
                {
                  {
                    todo: "Cada acción",
                    sofi: "Conversaciones",
                    clio: "Atenciones dictadas",
                    argos: "Preguntas y citas recuperadas",
                    sin_cobro: "Lo que no se cobró",
                  }[search.agente]
                }
              </h2>
              {search.agente === "clio" &&
              (actions.professionals.length > 1 || search.profesional) ? (
                <Tabs
                  className="max-w-full"
                  value={search.profesional ?? "todos"}
                  onValueChange={(value) =>
                    onSearch({ profesional: value === "todos" ? undefined : value, pagina: 1 })
                  }
                >
                  <ScrollArea horizontal className="min-w-0 max-w-full">
                    <TabsList aria-label="Profesional" className="max-w-full justify-start">
                      <TabsTrigger value="todos">Todos</TabsTrigger>
                      {actions.professionals.map((item) => (
                        <TabsTrigger
                          key={item.id}
                          value={item.id}
                        >{`${item.name} · ${item.count}`}</TabsTrigger>
                      ))}
                    </TabsList>
                  </ScrollArea>
                </Tabs>
              ) : null}
              {search.agente === "sofi" && (actions.channels.length > 1 || search.canal) ? (
                <Tabs
                  className="max-w-full"
                  value={search.canal ?? "todos"}
                  onValueChange={(value) =>
                    onSearch({ canal: value === "todos" ? undefined : value, pagina: 1 })
                  }
                >
                  <ScrollArea horizontal className="min-w-0 max-w-full">
                    <TabsList aria-label="Canal" className="max-w-full justify-start">
                      <TabsTrigger value="todos">Todos</TabsTrigger>
                      {actions.channels.map((item) => (
                        <TabsTrigger
                          key={item.channel}
                          value={item.channel}
                        >{`${CHANNEL_NAMES[item.channel] ?? item.channel} · ${item.count}`}</TabsTrigger>
                      ))}
                    </TabsList>
                  </ScrollArea>
                </Tabs>
              ) : null}
            </div>
            <ActionList
              organizationId={organizationId}
              search={search}
              data={actions}
              onPage={(pagina) => onSearch({ pagina })}
            />
            {search.agente === "argos" ? (
              <p className="text-xs text-muted-foreground">
                {actions.askers.length
                  ? `Más preguntaron: ${actions.askers
                      .slice(0, 3)
                      .map((item) => `${item.name} (${item.count})`)
                      .join(", ")}. `
                  : ""}
                «Repartido»: antes de anotarse el costo de cada pregunta, el gasto no decía a qué
                pregunta pertenecía y se divide el del día entre sus preguntas. Tocar una opción
                («¿Y en agosto?») no llama al modelo y no aparece aquí.
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  )
}
