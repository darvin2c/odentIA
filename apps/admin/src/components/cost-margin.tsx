/**
 * Costo y margen (ADR 0085, tableros O2 y O3): lo cobrado a cada clínica sin
 * impuesto frente a lo que nos costó, por agente y tipo, con la alarma
 * interna y la Fundadora sin uso. Solo lo ve odentIA (rol admin).
 */
import { Badge, Button, ScrollArea, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Fragment, useState } from "react"
import { api } from "../lib/api"
import { matchesProduct, type ProductChoice, ProductMark, useOrgProducts } from "./product"

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
  /** Una demo para presentar: no se cobra. */
  demo?: boolean
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
  /** Informa por bloques de mensajes de la persona (ADR 0105), en sombra; null si el plan no tiene tope. */
  informBlocks?: {
    messageLimit: number
    windows: number
    over: number
    extraInforma: number
    extraCents: number
    maxMessages: number
  } | null
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
/** Costo y margen de todas las clínicas, con «Para revisar» arriba (tablero O3). */
/** Los totales de las clínicas que se ven, como los suma el servidor (`getCostMarginOverview`). */
function summaryOf(clinics: ClinicCostMargin[]): Overview {
  const charged = clinics.reduce((sum, item) => sum + item.chargedCents, 0)
  const costTotal = clinics.reduce((sum, item) => sum + item.costMicros, 0)
  const commission = clinics.reduce((sum, item) => sum + item.commissionCents, 0)
  const pct = (base: number, spent: number) => (base > 0 ? Math.round((1 - spent / base) * 100) : null)
  return {
    clinics,
    founders: clinics.filter((item) => item.founder).length,
    chargedCents: charged,
    costMicros: costTotal,
    aiMicros: clinics.reduce((sum, item) => sum + item.aiMicros, 0),
    storageMicros: clinics.reduce((sum, item) => sum + item.storageMicros, 0),
    fixedMicros: clinics.reduce((sum, item) => sum + item.fixedMicros, 0),
    marginPct: pct(charged * 10_000, costTotal),
    marginAfterCommissionPct: pct(charged * 10_000, costTotal + commission * 10_000),
  }
}

export function CostMarginOverviewSection({ product = "todos" }: { product?: ProductChoice }) {
  const [order, setOrder] = useState<"margen" | "costo">("margen")
  const query = useQuery({
    queryKey: ["admin", "billing", "cost-margin"],
    queryFn: () => api<Overview>("/api/admin/billing/cost-margin"),
    retry: false,
  })
  const products = useOrgProducts().data ?? {}
  // Soporte no ve importes: sin acceso, la sección no aparece.
  if (!query.data || query.data.clinics.length === 0) return null
  // Con un producto elegido, los totales se suman solo de sus clínicas.
  const data =
    product === "todos"
      ? query.data
      : summaryOf(query.data.clinics.filter((item) => matchesProduct(product, products[item.organizationId])))
  if (data.clinics.length === 0) return null
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
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Badge variant={stateOf(item).variant}>{stateOf(item).label}</Badge>
                    {item.organizationName}
                    {products[item.organizationId] ? <ProductMark product={products[item.organizationId]} /> : null}
                  </p>
                  <p className="text-muted-foreground">{reviewReason(item)}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/organizations/$organizationId" params={{ organizationId: item.organizationId }} search={{ tab: "gastos" }} />}
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
      <ScrollArea horizontal className="max-w-full rounded-xl border bg-card">
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
                    to="/organizations/$organizationId"
                    params={{ organizationId: item.organizationId }}
                    search={{ tab: "gastos" }}
                    className="hover:underline"
                  >
                    {item.organizationName}
                  </Link>
                  {products[item.organizationId] ? (
                    <ProductMark product={products[item.organizationId]} className="mt-0.5 flex" />
                  ) : null}
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
      </ScrollArea>
      <p className="text-xs text-muted-foreground">
        La alarma avisa cuando la IA de una clínica pasa del 20 % de lo que paga o de USD 30 al mes.
        Nunca corta nada: es para revisar si hay un error o un abuso. El servidor y los gastos fijos
        son estimados y se reparten entre las clínicas activas.
      </p>
    </section>
  )
}
