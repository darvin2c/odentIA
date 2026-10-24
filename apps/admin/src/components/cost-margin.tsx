/**
 * Costo y margen (ADR 0085, tableros O2 y O3): lo cobrado a cada clínica sin
 * impuesto frente a lo que nos costó, por agente y tipo, con la alarma
 * interna y la Fundadora sin uso. Solo lo ve odentIA (rol admin).
 */
import { Badge, Button, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Fragment, useState } from "react"
import { api } from "../lib/api"

interface CostLine {
  key: string
  group: "sofi" | "clio" | "argos" | "regalo" | "no_ia"
  label: string
  count: number | null
  chargedCents: number
  costMicros: number
  marginPct: number | null
  note: string | null
  detail: Array<{
    occurredAt: string
    personName: string | null
    what: string
    calls: number
    chargedCents: number
    costMicros: number
  }>
}

export interface ClinicCostMargin {
  organizationId: string
  organizationName: string
  period: { start: string; end: string; credit: "prueba" | "mes" }
  currency: string
  planName: string | null
  founder: boolean
  chargedCents: number
  aiMicros: number
  storageMicros: number
  fixedMicros: number
  costMicros: number
  marginPct: number | null
  commissionCents: number
  marginAfterCommissionPct: number | null
  aiShareBps: number | null
  alarm: boolean
  idle: boolean
  sellerName: string | null
  unpricedCalls: number
  lines: CostLine[]
}

interface Overview {
  clinics: ClinicCostMargin[]
  founders: number
  chargedCents: number
  costMicros: number
  aiMicros: number
  storageMicros: number
  fixedMicros: number
  marginPct: number | null
  marginAfterCommissionPct: number | null
}

const LOCALE = "es-PE"
const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(cents / 100)
/** Lo que nos cuesta, con los centavos que hacen falta: «USD 0,0031». */
const cost = (micros: number, currency = "USD") =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000)
const day = (iso: string) =>
  new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(iso),
  )
const month = (iso: string) =>
  new Intl.DateTimeFormat(LOCALE, { month: "long", timeZone: "UTC" }).format(
    new Date(new Date(iso).getTime() - 1),
  )

const GROUP_NAME: Record<CostLine["group"], string> = {
  sofi: "Sofi",
  clio: "Clío",
  argos: "Argos",
  regalo: "",
  no_ia: "",
}

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
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "alarma"
            ? "text-lg font-semibold text-destructive"
            : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

function stateOf(item: ClinicCostMargin): {
  label: string
  variant: "destructive" | "warning" | "success"
} {
  if (item.alarm) return { label: "Alarma", variant: "destructive" }
  if (item.idle) return { label: "Sin uso", variant: "warning" }
  return { label: "Bien", variant: "success" }
}

/** Por qué entra en «Para revisar», en una frase. */
function reviewReason(item: ClinicCostMargin): string {
  if (item.alarm) {
    const share =
      item.aiShareBps !== null
        ? `la IA es el ${Math.round(item.aiShareBps / 100)} % de lo que paga`
        : "la IA pasó de USD 30 este mes"
    return `${share} (${cost(item.aiMicros, item.currency)} de ${money(item.chargedCents, item.currency)}). No se cortó nada: revisa si hay un error o un abuso.`
  }
  return "Fundadora sin encender ningún agente en 60 días. No se le cobra nada: sus meses están garantizados. Conviene escribirle."
}

/** La tabla de una clínica: cada agente y tipo, lo regalado y lo que no es IA. */
function CostTable({ data }: { data: ClinicCostMargin }) {
  const [open, setOpen] = useState<string | null>(null)
  const charged = data.lines.filter((line) => line.group !== "regalo" && line.group !== "no_ia")
  const free = data.lines.filter((line) => line.group === "regalo")
  const other = data.lines.filter((line) => line.group === "no_ia")
  const row = (line: CostLine) => (
    <Fragment key={line.key}>
      <tr className="border-t">
        <th scope="row" className="py-1.5 pr-2 text-left font-normal">
          {GROUP_NAME[line.group] ? (
            <span className="font-medium">{GROUP_NAME[line.group]}</span>
          ) : null}
          {GROUP_NAME[line.group] ? " · " : ""}
          {line.label}
          {line.detail.length > 0 ? (
            <Button
              variant="link"
              size="sm"
              className="ml-1 h-auto p-0 text-xs"
              onClick={() => setOpen(open === line.key ? null : line.key)}
            >
              {open === line.key
                ? "Ocultar"
                : `Ver ${line.detail.length === 1 ? "la atención" : `las ${line.detail.length}`}`}
            </Button>
          ) : null}
        </th>
        <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
          {line.count ?? "—"}
        </td>
        <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
          {line.chargedCents ? money(line.chargedCents, data.currency) : "0"}
        </td>
        <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
          {cost(line.costMicros)}
        </td>
        <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
          {line.marginPct !== null ? `${line.marginPct} %` : "—"}
        </td>
        <td className="py-1.5 pl-2 text-xs text-muted-foreground">{line.note ?? ""}</td>
      </tr>
      {open === line.key
        ? line.detail.map((item) => (
            <tr key={`${line.key}:${item.occurredAt}`} className="text-xs text-muted-foreground">
              <td className="py-1 pl-4">
                {new Intl.DateTimeFormat(LOCALE, {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(item.occurredAt))}{" "}
                · {item.personName ?? "Sin persona"} · {item.calls}{" "}
                {item.calls === 1 ? "llamada" : "llamadas"}
              </td>
              <td />
              <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                {money(item.chargedCents, data.currency)}
              </td>
              <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                {cost(item.costMicros)}
              </td>
              <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                {item.chargedCents > 0
                  ? `${Math.round((1 - item.costMicros / (item.chargedCents * 10_000)) * 100)} %`
                  : "—"}
              </td>
              <td />
            </tr>
          ))
        : null}
    </Fragment>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 text-left font-medium">
              Agente · tipo
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-3 text-right font-medium">
              Cuántas
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-3 text-right font-medium">
              Cobrado
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-3 text-right font-medium">
              Nos costó
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-3 text-right font-medium">
              Margen
            </th>
            <th scope="col" className="py-1 pl-2 text-left font-medium">
              <span className="sr-only">Nota</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {charged.map(row)}
          <tr>
            <td colSpan={6} className="pt-3 text-xs font-semibold text-muted-foreground">
              Lo que no se cobra
            </td>
          </tr>
          {free.map(row)}
          <tr>
            <td colSpan={6} className="pt-3 text-xs font-semibold text-muted-foreground">
              Lo que no es IA
            </td>
          </tr>
          {other.map(row)}
          <tr className="border-t font-semibold">
            <th scope="row" className="py-1.5 text-left">
              Total
            </th>
            <td />
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
              {money(data.chargedCents, data.currency)}
            </td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
              {cost(data.costMicros)}
            </td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
              {data.marginPct !== null ? `${data.marginPct} %` : "—"}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** Costo y margen de una clínica en su ficha (tablero O2). */
export function ClinicCostMarginSection({ organizationId }: { organizationId: string }) {
  const [period, setPeriod] = useState<"actual" | "anterior">("actual")
  const query = useQuery({
    queryKey: ["admin", "billing", "cost-margin", organizationId, period],
    queryFn: () =>
      api<ClinicCostMargin>(
        `/api/admin/billing/cost-margin/${encodeURIComponent(organizationId)}?periodo=${period}`,
      ),
    retry: false,
  })
  // Soporte no ve importes: sin acceso, la sección no aparece.
  if (query.isError && query.error instanceof Error && /403|acceso/i.test(query.error.message))
    return null
  const data = query.data
  return (
    <section aria-labelledby="costo-margen" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="costo-margen" className="text-sm font-medium">
            Costo y margen{data ? ` · ${month(data.period.end)}` : ""}
          </h3>
          {data ? (
            <p className="text-xs text-muted-foreground">
              Del {day(data.period.start)} al{" "}
              {day(new Date(new Date(data.period.end).getTime() - 1).toISOString())}. Solo lo ve
              odentIA.
            </p>
          ) : null}
        </div>
        <Tabs value={period} onValueChange={(value) => setPeriod(value as "actual" | "anterior")}>
          <TabsList aria-label="Qué mes">
            <TabsTrigger value="actual">Este mes</TabsTrigger>
            <TabsTrigger value="anterior">El anterior</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {query.isPending ? (
        <LoadingState message="Calculando el costo y el margen…" />
      ) : query.isError || !data ? (
        <ErrorState
          title="No se pudo calcular el costo y el margen"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Cobrado, sin impuestos"
              value={money(data.chargedCents, data.currency)}
              detail={
                data.period.credit === "prueba" ? "En prueba: el saldo es de regalo" : undefined
              }
            />
            <Stat
              label="Nos costó"
              value={cost(data.costMicros)}
              detail={`IA ${cost(data.aiMicros)} · espacio ${cost(data.storageMicros)} · servidor ${cost(data.fixedMicros)}`}
            />
            <Stat
              label="Margen"
              value={data.marginPct !== null ? `${data.marginPct} %` : "—"}
              detail={
                data.commissionCents > 0 && data.marginAfterCommissionPct !== null
                  ? `${data.marginAfterCommissionPct} % tras la comisión (${money(data.commissionCents, data.currency)})${data.sellerName ? `, de ${data.sellerName}` : ""}`
                  : undefined
              }
            />
            <Stat
              label="Alarma interna"
              value={data.alarm ? "Alarma" : "Sin alarma"}
              tone={data.alarm ? "alarma" : "bien"}
              detail={`${data.aiShareBps !== null ? `La IA es el ${Math.round(data.aiShareBps / 100)} % de lo que paga. ` : ""}Avisa desde el 20 % o USD 30.`}
            />
          </div>
          <CostTable data={data} />
          <p className="text-xs text-muted-foreground">
            El costo de IA sale de lo que reportó cada proveedor en cada llamada, unido a su acción.
            El servidor y los gastos fijos son un estimado por clínica. La cuota ya va dentro de lo
            cobrado. WhatsApp lo paga la clínica a Meta y no aparece aquí.
            {data.unpricedCalls > 0
              ? ` ${data.unpricedCalls} llamadas no tienen costo conocido (modelo sin precio o uso no reportado) y no están en el total.`
              : ""}
          </p>
        </>
      )}
    </section>
  )
}

/** Costo y margen de todas las clínicas, con «Para revisar» arriba (tablero O3). */
export function CostMarginOverviewSection() {
  const [order, setOrder] = useState<"margen" | "costo">("margen")
  const query = useQuery({
    queryKey: ["admin", "billing", "cost-margin"],
    queryFn: () => api<Overview>("/api/admin/billing/cost-margin"),
    retry: false,
  })
  // Soporte no ve importes: sin acceso, la sección no aparece.
  if (!query.data || query.data.clinics.length === 0) return null
  const data = query.data
  const review = data.clinics.filter((item) => item.alarm || item.idle)
  const sorted = [...data.clinics].sort((a, b) =>
    order === "margen" ? (a.marginPct ?? -1) - (b.marginPct ?? -1) : b.costMicros - a.costMicros,
  )
  return (
    <section aria-labelledby="costo-margen-todas" className="flex flex-col gap-3">
      <div>
        <h2 id="costo-margen-todas" className="text-base font-semibold">
          Costo y margen
        </h2>
        <p className="text-sm text-muted-foreground">
          Todas las clínicas activas · lo que va del mes de cada una
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Clínicas activas"
          value={String(data.clinics.length)}
          detail={`${data.founders} ${data.founders === 1 ? "Fundadora" : "Fundadoras"} · ${data.clinics.length - data.founders} ${data.clinics.length - data.founders === 1 ? "normal" : "normales"}`}
        />
        <Stat label="Cobrado, sin impuestos" value={money(data.chargedCents)} />
        <Stat
          label="Nos costó"
          value={cost(data.costMicros)}
          detail={`IA ${cost(data.aiMicros)} · espacio ${cost(data.storageMicros)} · servidor ${cost(data.fixedMicros)}`}
        />
        <Stat
          label="Margen"
          value={data.marginPct !== null ? `${data.marginPct} %` : "—"}
          detail={
            data.marginAfterCommissionPct !== null
              ? `${data.marginAfterCommissionPct} % tras comisiones`
              : undefined
          }
        />
      </div>
      {review.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Para revisar</h3>
          <ul className="divide-y rounded-xl border bg-card">
            {review.map((item) => (
              <li
                key={item.organizationId}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm"
              >
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium">
                    <Badge variant={stateOf(item).variant} className="mr-2">
                      {stateOf(item).label}
                    </Badge>
                    {item.organizationName}
                  </p>
                  <p className="text-muted-foreground">{reviewReason(item)}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/organizations" search={{ org: item.organizationId }} />}
                >
                  {item.alarm ? "Ver el detalle" : "Abrir la ficha"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Todas las clínicas</h3>
        <Tabs value={order} onValueChange={(value) => setOrder(value as "margen" | "costo")}>
          <TabsList aria-label="Orden">
            <TabsTrigger value="margen">Menor margen primero</TabsTrigger>
            <TabsTrigger value="costo">Mayor costo primero</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Clínica
              </th>
              <th scope="col" className="py-2 text-left font-medium">
                Plan
              </th>
              <th scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-medium">
                Cobrado
              </th>
              <th scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-medium">
                Nos costó
              </th>
              <th scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-medium">
                IA / cobrado
              </th>
              <th scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-medium">
                Margen
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                <span className="sr-only">Estado</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.organizationId} className="border-t">
                <th scope="row" className="px-4 py-2 text-left font-medium">
                  <Link
                    to="/organizations"
                    search={{ org: item.organizationId }}
                    className="hover:underline"
                  >
                    {item.organizationName}
                  </Link>
                </th>
                <td className="py-2">{item.planName ?? "—"}</td>
                <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                  {money(item.chargedCents, item.currency)}
                </td>
                <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                  {cost(item.costMicros)}
                </td>
                <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                  {item.aiShareBps !== null ? `${Math.round(item.aiShareBps / 100)} %` : "—"}
                </td>
                <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                  {item.marginPct !== null ? `${item.marginPct} %` : "—"}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={stateOf(item).variant}>{stateOf(item).label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        La alarma avisa cuando la IA de una clínica pasa del 20 % de lo que paga o de USD 30 al mes.
        Nunca corta nada: es para revisar si hay un error o un abuso. El servidor y los gastos fijos
        son estimados y se reparten entre las clínicas activas.
      </p>
    </section>
  )
}
