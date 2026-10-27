/**
 * Ficha de la clínica › Precio y prueba (ADR 0031, tablero O2): prueba y
 * descuento negociados (por encima de lo de siempre queda pedido para
 * aprobar) y cada cuánto se factura. Lo que hicieron los agentes y el crédito
 * del mes están en Resumen y Gastos. Solo la administración (ADR 0094).
 */
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { DatePickerButton, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api } from "../lib/api"
import { centsToMajor, majorToCents } from "./billing-fields"

type Kind = "conversacion" | "consulta" | "cita"

/** Los precios de cada tipo, en el orden de la lista (ADR 0085). */
const PRICE_ROWS = [
  { key: "informa", label: "Sofi · Informa" },
  { key: "gestiona", label: "Sofi · Gestiona" },
  { key: "agenda", label: "Sofi · Agenda" },
  { key: "simple", label: "Clío · Simple" },
  { key: "estandar", label: "Clío · Estándar" },
  { key: "completa", label: "Clío · Completa" },
  { key: "cita", label: "Cita recuperada" },
  { key: "preguntas", label: "Paquete de preguntas" },
  { key: "almacenamiento", label: "GB extra" },
] as const

interface BillingTerms {
  plan: {
    name: string
    currency: string
    priceCents: number
    creditCents: number
    maxDiscountBps: number
    sellerDiscountBps: number
    trialCreditCents: number
    trialDays: number
    trialMaxCreditCents: number
    trialMaxDays: number
    base: Record<Kind, number | null>
    /** El precio de cada tipo y lo que no se negocia (ADR 0085). */
    prices?: Record<string, number | null>
    fixed?: string[]
  } | null
  status: string
  trial: { creditCents: number; days: number; startedAt: string | null; endsAt: string | null }
  discountBps: number
  /** Último instante del descuento (issue 168); null = no vence. */
  discountEndsAt: string | null
  guaranteedUntil: string | null
  spendCapCents: number | null
  billingCycle: "mensual" | "quincenal"
  /** Con ciclo quincenal, a los cuántos días del tramo se cobra (condiciones comerciales). */
  halfCycleDays: number
  warnPercent: number
  alarmPercent: number
  /** Días antes del fin de un precio especial en que se avisa (condiciones comerciales). */
  discountNoticeDays: number
  seller: { name: string } | null
  consumption: {
    currency: string | null
    priced: boolean
    lines: Array<{ kind: Kind; count: number; amountCents: number }>
    subtotalCents: number
    creditCents: number
    period: { credit: "prueba" | "mes" }
  }
  negotiations: Array<{
    id: string
    kind: "descuento" | "prueba"
    status: string
    discountBps: number | null
    discountEndsAt: string | null
    trialCreditCents: number | null
    trialDays: number | null
    requestedByName: string | null
    createdAt: string
    decidedAt: string | null
  }>
  notices: Array<{ kind: string; sentAt: string | null }>
}

const NOTICE_WORDS: Record<string, string> = {
  saldo_prueba_aviso: "Aviso de saldo de prueba",
  saldo_prueba_alarma: "Alarma de saldo de prueba",
  saldo_prueba_limite: "Agentes en pausa por saldo",
  dias_prueba_aviso: "Aviso: la prueba termina pronto",
  dias_prueba_alarma: "Alarma: la prueba termina en 2 días",
  credito_aviso: "Aviso de crédito del mes",
  credito_alarma: "Alarma de crédito del mes",
  credito_limite: "Crédito del mes usado",
  tope_aviso: "Aviso de tope",
  tope_alarma: "Alarma de tope",
  tope_limite: "Tope alcanzado",
  prueba_vencida_sin_plan: "Prueba terminada sin plan",
  gracia_inicio: "Inicio de gracia",
  restriccion_inicio: "Acceso restringido",
  precio_especial_aviso: "Aviso: su precio especial termina",
  precio_especial_alarma: "Alarma: su precio especial termina en 3 días",
  condiciones_aviso: "Aviso: sus condiciones de Fundador terminan",
  condiciones_alarma: "Alarma: sus condiciones de Fundador terminan en 7 días",
}

/** El día elegido (`yyyy-MM-dd`) vale completo: el descuento termina al final de ese día, en la hora de este equipo. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999`).toISOString()
const dayOf = (iso: string | null) => {
  if (!iso) return ""
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)).replaceAll(".", "")

function priceText(micros: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micros / 1_000_000)
}
const discounted = (base: number, bps: number) => Math.round((base * (10_000 - bps)) / 10_000)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const errorText = (error: unknown) => (error instanceof ApiError ? (error.shape.message ?? "No se pudo guardar") : "No se pudo guardar")

export function OrgBillingSection({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient()
  const terms = useQuery({
    queryKey: ["admin", "organizations", organizationId, "billing"],
    queryFn: () => api<BillingTerms | null>(`/api/admin/organizations/${organizationId}/billing`),
  })
  const [trialCredit, setTrialCredit] = useState("")
  const [trialDays, setTrialDays] = useState("")
  const [discount, setDiscount] = useState("")
  const [discountEnd, setDiscountEnd] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!terms.data) return
    const currency = terms.data.plan?.currency ?? "USD"
    setTrialCredit(centsToMajor(terms.data.trial.creditCents, currency))
    setTrialDays(String(terms.data.trial.days))
    setDiscount(String(terms.data.discountBps / 100))
    setDiscountEnd(dayOf(terms.data.discountEndsAt))
  }, [terms.data])
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin", "organizations", organizationId] })
  const outcome = (result: { status: "aplicado" | "pendiente" }) =>
    setMessage(result.status === "pendiente" ? "Quedó pedido: debe aprobarlo alguien con el rol Administración." : "Guardado.")
  const saveTrial = useMutation({
    mutationFn: () =>
      api<{ status: "aplicado" | "pendiente" }>(`/api/admin/organizations/${organizationId}/billing/trial`, {
        method: "POST",
        body: JSON.stringify({ trialCreditCents: majorToCents(trialCredit, terms.data?.plan?.currency ?? "USD") ?? -1, trialDays: Number(trialDays) }),
      }),
    onSuccess: (res) => {
      outcome(res)
      refresh()
    },
    onError: (e) => setMessage(errorText(e)),
  })
  const saveDiscount = useMutation({
    mutationFn: () =>
      api<{ status: "aplicado" | "pendiente" }>(`/api/admin/organizations/${organizationId}/billing/discount`, {
        method: "POST",
        body: JSON.stringify({
          discountBps: Math.round(Number(discount.replace(",", ".")) * 100),
          discountEndsAt: discountEnd ? endOfDay(discountEnd) : null,
        }),
      }),
    onSuccess: (res) => {
      outcome(res)
      refresh()
    },
    onError: (e) => setMessage(errorText(e)),
  })
  const saveCycle = useMutation({
    mutationFn: (cycle: "mensual" | "quincenal") =>
      api(`/api/admin/organizations/${organizationId}/billing/cycle`, { method: "POST", body: JSON.stringify({ cycle }) }),
    onSuccess: () => {
      setMessage("Guardado.")
      refresh()
    },
    onError: (e) => setMessage(errorText(e)),
  })

  if (terms.isPending) return <LoadingState message="Cargando el cobro…" />
  if (terms.isError) return <ErrorState title="No se pudo cargar el cobro" onRetry={() => void terms.refetch()} />
  const data = terms.data
  if (!data) return <p className="text-sm text-muted-foreground">Esta clínica no tiene suscripción: no se le cuenta ni se le cobra.</p>
  const plan = data.plan
  const currency = plan?.currency ?? "USD"
  const money = (cents: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100)
  const bps = Math.round(Number(discount.replace(",", ".")) * 100)
  const trialAbove = plan ? (majorToCents(trialCredit, currency) ?? 0) > plan.trialCreditCents || Number(trialDays) > plan.trialDays : false
  const pending = data.negotiations.filter((item) => item.status === "pendiente")
  const count = (kind: Kind) => data.consumption.lines.find((line) => line.kind === kind)?.count ?? 0
  const halfWords = `a los ${data.halfCycleDays} días y al cerrar el mes`

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Precio y prueba</h2>
      <p className="text-sm text-muted-foreground">
        {data.status === "prueba" && data.trial.startedAt
          ? `En prueba · día ${Math.max(1, Math.ceil((Date.now() - new Date(data.trial.startedAt).getTime()) / 86_400_000))} de ${data.trial.days}`
          : `Estado: ${data.status}`}
        {data.seller ? ` · vendedor: ${data.seller.name}` : " · sin vendedor"} · se factura {data.billingCycle === "quincenal" ? halfWords : "cada mes"}
      </p>

      {pending.length ? (
        <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm">
          Pedido esperando aprobación:{" "}
          {pending
            .map((item) =>
              item.kind === "descuento"
                ? `descuento de ${(item.discountBps ?? 0) / 100} %${item.discountEndsAt ? ` hasta el ${shortDay(item.discountEndsAt)}` : ""}`
                : `prueba con ${money(item.trialCreditCents ?? 0)} y ${item.trialDays} días`,
            )
            .join(" · ")}
          . Se aprueba en Facturación › Pedidos por aprobar.
        </p>
      ) : null}

      {plan ? (
        <div className="grid gap-4 md:grid-cols-2">
          <form
            className="flex flex-col gap-2 rounded-lg border p-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveTrial.mutate()
            }}
          >
            <p className="text-sm font-medium">Prueba</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="org-trial-credit">Saldo de regalo ({currency})</Label>
                <Input id="org-trial-credit" inputMode="decimal" value={trialCredit} onChange={(event) => setTrialCredit(event.target.value)} />
                <p className="text-xs text-muted-foreground">Hasta {money(plan.trialMaxCreditCents)}</p>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="org-trial-days">Días</Label>
                <Input id="org-trial-days" inputMode="numeric" value={trialDays} onChange={(event) => setTrialDays(event.target.value)} />
                <p className="text-xs text-muted-foreground">Hasta {plan.trialMaxDays}</p>
              </div>
            </div>
            {trialAbove ? (
              <p className="text-xs text-muted-foreground">
                Está por encima de {money(plan.trialCreditCents)} y {plan.trialDays} días: si no eres de la administración, queda pedido para aprobar. El
                saldo de regalo no genera comisión.
              </p>
            ) : null}
            <div>
              <Button size="sm" type="submit" disabled={saveTrial.isPending}>
                Guardar prueba
              </Button>
            </div>
          </form>

          <form
            className="flex flex-col gap-2 rounded-lg border p-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveDiscount.mutate()
            }}
          >
            <p className="text-sm font-medium">Precio negociado</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="org-discount">Descuento en lo que se negocia (%)</Label>
                <Input id="org-discount" inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="org-discount-end">
                  Vence <span className="font-normal text-muted-foreground">(opcional)</span>
                </Label>
                <DatePickerButton
                  id="org-discount-end"
                  value={discountEnd}
                  onChange={setDiscountEnd}
                  min={dayOf(new Date(Date.now() + 86_400_000).toISOString())}
                  emptyLabel="No vence"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              El vendedor da hasta {plan.sellerDiscountBps / 100} % sin aprobación; la administración, hasta {plan.maxDiscountBps / 100} %. La cuota no
              cambia. Sin fecha, no vence; con fecha, se avisa a la clínica y aquí {data.discountNoticeDays} días antes.
            </p>
            {Number.isFinite(bps) && bps >= 0 ? (
              <table className="w-full text-sm">
                <caption className="sr-only">Precio de lista y lo que paga esta clínica</caption>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1 font-medium">
                      Acción
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Lista
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Paga esta clínica
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PRICE_ROWS.filter((row) => (plan.prices?.[row.key] ?? null) !== null).map((row) => {
                    const base = plan.prices?.[row.key] ?? 0
                    // Lo que no se negocia queda siempre a su precio de lista (ADR 0085).
                    const fixed = plan.fixed?.includes(row.key) ?? false
                    const own = fixed ? base : discounted(base, Math.min(bps, plan.maxDiscountBps))
                    return (
                      <tr key={row.key}>
                        <td className="py-1">
                          {row.label}
                          {fixed ? <span className="block text-xs text-muted-foreground">No se negocia</span> : null}
                        </td>
                        <td className="py-1 text-right text-muted-foreground tabular-nums">
                          {own !== base ? <s>{priceText(base, currency)}</s> : priceText(base, currency)}
                        </td>
                        <td className="py-1 text-right font-semibold tabular-nums">{priceText(own, currency)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : null}
            {bps > 0 ? (
              <p className="text-xs text-muted-foreground">Si sube el precio de lista, esta clínica sigue pagando {bps / 100} % menos sobre el precio nuevo.</p>
            ) : null}
            {data.negotiations.some((item) => item.kind === "descuento" && item.status !== "pendiente") ? (
              <p className="text-xs text-muted-foreground">
                Historial:{" "}
                {data.negotiations
                  .filter((item) => item.kind === "descuento" && item.status !== "pendiente")
                  .slice(0, 3)
                  .map(
                    (item) =>
                      `${(item.discountBps ?? 0) / 100} % ${item.status === "aprobada" ? "aprobado" : "rechazado"}${
                        item.decidedAt ? ` el ${shortDay(item.decidedAt)}` : ""
                      }${item.requestedByName ? ` (lo pidió ${item.requestedByName})` : ""}`,
                  )
                  .join(" · ")}
              </p>
            ) : null}
            <div>
              <Button size="sm" type="submit" disabled={saveDiscount.isPending}>
                Guardar descuento
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No hay un plan con precios por acción: configúralo en Facturación › Planes.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor="org-cycle">Lo que pasa del crédito se factura</Label>
        <Select value={data.billingCycle} onValueChange={(value) => saveCycle.mutate(value as "mensual" | "quincenal")}>
          <SelectTrigger id="org-cycle" className="w-64">
            <SelectValue>{data.billingCycle === "quincenal" ? `A los ${data.halfCycleDays} días y al cerrar` : "Al cerrar el mes"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mensual">Al cerrar el mes</SelectItem>
            <SelectItem value="quincenal">A los {data.halfCycleDays} días y al cerrar</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {data.notices.length ? (
        <div className="text-sm">
          <p className="font-medium">Avisos enviados</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {data.notices.map((notice) => (
              <li key={`${notice.kind}-${notice.sentAt ?? "sin-fecha"}`}>
                {NOTICE_WORDS[notice.kind] ?? notice.kind}
                {notice.sentAt ? ` · ${new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" }).format(new Date(notice.sentAt))}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  )
}
