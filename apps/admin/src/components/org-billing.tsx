/**
 * Ficha de la clínica › Precio y prueba (ADR 0031, tablero O2): prueba y
 * descuento negociados (por encima de lo de siempre queda pedido para
 * aprobar), cada cuánto se factura y «Pasar a Fundadores» para la clínica
 * en prueba que entró sin la invitación (ADR 0192). Lo que hicieron los
 * agentes y el crédito del mes están en Resumen y Gastos. Solo la
 * administración (ADR 0094).
 */
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DatePickerButton,
  ErrorState,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useRef, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { focusInsideLater } from "../lib/focus"
import { centsToMajor, majorToCents } from "./billing-fields"
import { OrgBillingSkeleton } from "./skeletons/organization-detail"

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
  /** El plan que rige cuando terminan sus condiciones de Fundadora, desde `startsAt`; null si nada cambia solo. */
  next: {
    name: string
    currency: string
    priceCents: number
    creditCents: number
    prices: Record<string, number | null>
    startsAt: string
  } | null
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
  /** «Pasar a Fundadores»: lo que tendría si pasa ahora; null si no puede (ADR 0192). */
  founders?: FoundersMove | null
  /** «Cambios del plan»: de las dos auditorías, del más nuevo al más viejo (ADR 0196). */
  changes?: Array<{ id: string; at: string; action: string; words: string; by: { userId: string; name: string } | null }>
}

interface FoundersMove {
  planName: string
  currency: string
  /** Lugares usados, sin esta clínica, y los del plan. */
  used: number
  limit: number
  guaranteeMonths: number | null
  guaranteedUntil: string | null
  listPlanName: string | null
  trialDays: number
  trialCreditCents: number
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
  cargo_emitido: "Cargo del mes emitido",
  restriccion_manana: "Aviso: mañana pasa a solo lectura",
  plan_activo: "Plan activo",
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
const moneyText = (cents: number, currency: string) => new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100)
const discounted = (base: number, bps: number) => Math.round((base * (10_000 - bps)) / 10_000)

type Plan = NonNullable<BillingTerms["plan"]>
type Outcome = { status: "aplicado" | "pendiente" }

/** Lo que se dice al guardar: aplicado o pedido para aprobar. */
const outcomeWords = (result: Outcome) =>
  result.status === "pendiente" ? "Quedó pedido: debe aprobarlo alguien con el rol Administración." : "Guardado."

/** El descuento escrito en % → puntos básicos (NaN si no es un número). */
const bpsOf = (text: string) => (text.trim() ? Math.round(Number(text.replace(",", ".")) * 100) : Number.NaN)

export function OrgBillingSection({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient()
  const terms = useQuery({
    queryKey: ["admin", "organizations", organizationId, "billing"],
    queryFn: () => api<BillingTerms | null>(`/api/admin/organizations/${organizationId}/billing`),
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin", "organizations", organizationId] })
  // Pasar a Fundadores cambia también la cabecera de la ficha y la del cliente: su historial y lo que muestran Hoy y Kairós.
  const refreshAll = () => {
    refresh()
    void queryClient.invalidateQueries({ queryKey: ["admin-organization", organizationId] })
    for (const key of ["client", "clients", "kairos", "overview"]) void queryClient.invalidateQueries({ queryKey: ["admin", key] })
  }
  // El ciclo se guarda al elegir: es una acción suelta, con su error junto al control.
  const saveCycle = useMutation({
    mutationFn: (cycle: "mensual" | "quincenal") =>
      api(`/api/admin/organizations/${organizationId}/billing/cycle`, { method: "POST", body: JSON.stringify({ cycle }) }),
    onSuccess: () => {
      toast.success("Guardado.")
      refresh()
    },
  })

  if (terms.isPending)
    return (
      <SkeletonRegion message="Cargando el cobro…">
        <OrgBillingSkeleton />
      </SkeletonRegion>
    )
  if (terms.isError) return <ErrorState title="No se pudo cargar el cobro" onRetry={() => void terms.refetch()} />
  const data = terms.data
  if (!data) return <p className="text-sm text-muted-foreground">Esta clínica no tiene suscripción: no se le cuenta ni se le cobra.</p>
  const plan = data.plan
  const currency = plan?.currency ?? "USD"
  const money = (cents: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100)
  const pending = data.negotiations.filter((item) => item.status === "pendiente")
  const halfWords = `a los ${data.halfCycleDays} días y al cerrar el mes`
  const cycleError = saveCycle.isError ? submitErrorMessage(saveCycle.error) : null

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Precio y prueba</h2>
      <PlanSummary data={data} halfWords={halfWords} />
      <PlanChanges changes={data.changes ?? []} />

      {data.founders ? (
        <FoundersMoveSection
          organizationId={organizationId}
          move={data.founders}
          discountBps={data.discountBps}
          spendCapCents={data.spendCapCents}
          onChanged={refreshAll}
        />
      ) : null}

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
          <TrialForm organizationId={organizationId} data={data} plan={plan} money={money} onSaved={refresh} />
          {/* Un plan sin descuento (Fundadores) no se negocia: no se ofrece. */}
          {plan.maxDiscountBps > 0 || data.discountBps > 0 ? (
            <DiscountForm organizationId={organizationId} data={data} plan={plan} onSaved={refresh} />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No hay un plan con precios por acción: configúralo en Facturación › Planes.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor="org-cycle">Lo que pasa del crédito se factura</Label>
        <Select
          value={data.billingCycle}
          disabled={saveCycle.isPending}
          onValueChange={(value) => saveCycle.mutate(value as "mensual" | "quincenal")}
        >
          <SelectTrigger
            id="org-cycle"
            className="w-64"
            aria-invalid={cycleError ? true : undefined}
            aria-describedby={cycleError ? "org-cycle-error" : undefined}
          >
            <SelectValue>{data.billingCycle === "quincenal" ? `A los ${data.halfCycleDays} días y al cerrar` : "Al cerrar el mes"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mensual">Al cerrar el mes</SelectItem>
            <SelectItem value="quincenal">A los {data.halfCycleDays} días y al cerrar</SelectItem>
          </SelectContent>
        </Select>
        {cycleError ? (
          <p id="org-cycle-error" role="alert" className="basis-full text-sm text-destructive">
            {cycleError}
          </p>
        ) : null}
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
    </div>
  )
}

/** El estado del plan en palabras, cuando no es el de siempre (en prueba o activo). */
const STATUS_WORDS: Record<string, string> = {
  gracia: "En gracia",
  restringida: "Restringida: la clínica solo puede leer",
  pausada: "Pausada",
  cancelada: "Cancelada",
}

/**
 * Lo que rige hoy y lo que viene, en filas (ADR 0196): «Hoy rige» (el plan, su cuota y su
 * crédito del mes, y hasta cuándo si termina), «Después» (el plan que sigue, su cuota y desde
 * cuándo), «Prueba» (el día que va, cuándo termina y el regalo que le queda) y «Cobro» (cada cuánto
 * se factura y quién vende). El precio de cada acción, en «Ver los precios de cada acción».
 */
function PlanSummary({ data, halfWords }: { data: BillingTerms; halfWords: string }) {
  const { plan, next } = data
  const ends = next?.startsAt ?? data.guaranteedUntil
  const trialDay =
    data.status === "prueba" && data.trial.startedAt
      ? Math.max(1, Math.ceil((Date.now() - new Date(data.trial.startedAt).getTime()) / 86_400_000))
      : null
  const gift =
    data.status === "prueba" && data.consumption.period.credit === "prueba" && data.consumption.creditCents > 0
      ? {
          left: Math.max(0, data.consumption.creditCents - data.consumption.subtotalCents),
          total: data.consumption.creditCents,
          currency: data.consumption.currency ?? plan?.currency ?? "USD",
        }
      : null
  const rows = plan
    ? PRICE_ROWS.filter((row) => (plan.prices?.[row.key] ?? null) !== null || (next?.prices[row.key] ?? null) !== null)
    : []
  const cell = "py-1 text-right tabular-nums"
  const line = "grid gap-0.5 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"
  const label = "text-xs font-medium text-muted-foreground sm:pt-0.5"
  return (
    <Collapsible className="flex flex-col gap-2 rounded-lg border p-3">
      <dl className="flex flex-col divide-y text-sm">
        <div className={line}>
          <dt className={label}>Hoy rige</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {plan ? (
              <>
                <span className="font-medium">{plan.name}</span> · {moneyText(plan.priceCents, plan.currency)} al mes ·{" "}
                {moneyText(plan.creditCents, plan.currency)} de crédito al mes
                {/* «Hasta el … después»: lo mismo que se le dice a la clínica, y el cambio ocurre ese día. */}
                {ends ? <> · hasta el {shortDay(ends)}</> : null}
                {data.guaranteedUntil && !next ? <span className="text-muted-foreground"> (condiciones de Fundadora)</span> : null}
              </>
            ) : (
              <span className="text-muted-foreground">Sin un plan con precios por acción</span>
            )}
            {STATUS_WORDS[data.status] ? <span className="block text-muted-foreground">{STATUS_WORDS[data.status]}</span> : null}
          </dd>
        </div>
        {next ? (
          <div className={line}>
            <dt className={label}>Después</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium">{next.name}</span> · {moneyText(next.priceCents, next.currency)} al mes ·{" "}
              {moneyText(next.creditCents, next.currency)} de crédito · desde el {shortDay(next.startsAt)}
            </dd>
          </div>
        ) : null}
        {trialDay !== null ? (
          <div className={line}>
            <dt className={label}>Prueba</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              Día {Math.min(trialDay, data.trial.days || trialDay)} de {data.trial.days}
              {data.trial.endsAt ? ` · termina el ${shortDay(data.trial.endsAt)}` : ""}
              {gift ? ` · le quedan ${moneyText(gift.left, gift.currency)} de ${moneyText(gift.total, gift.currency)} de regalo` : ""}
            </dd>
          </div>
        ) : null}
        <div className={line}>
          <dt className={label}>Cobro</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            Lo que pasa del crédito se factura {data.billingCycle === "quincenal" ? halfWords : "al cerrar el mes"} ·{" "}
            {data.seller ? `vende ${data.seller.name}` : "sin vendedor"}
          </dd>
        </div>
      </dl>
      {plan && rows.length ? (
        <>
          <div>
            <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="group" />}>
              Ver los precios de cada acción
              <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180" />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <table className="w-full max-w-2xl text-sm">
              <caption className="sr-only">{next ? `Precios de ${plan.name} y de ${next.name}` : `Precios de ${plan.name}`}</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1 font-medium">
                    Concepto
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {next ? `${plan.name} (hasta el ${shortDay(next.startsAt)})` : plan.name}
                  </th>
                  {next ? (
                    <th scope="col" className="py-1 text-right font-medium">
                      {next.name} (después)
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const today = plan.prices?.[row.key] ?? null
                  const later = next?.prices[row.key] ?? null
                  return (
                    <tr key={row.key}>
                      <td className="py-1">{row.label}</td>
                      <td className={cell}>{today === null ? "—" : priceText(today, plan.currency)}</td>
                      {next ? <td className={cell}>{later === null ? "—" : priceText(later, next.currency)}</td> : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CollapsibleContent>
        </>
      ) : null}
    </Collapsible>
  )
}

/** Cuántos cambios se ven de entrada; «Ver todos» muestra el resto. */
const CHANGES_SHOWN = 6

/**
 * «Cambios del plan»: una línea por cambio (el día, qué cambió y quién), del más nuevo al más viejo,
 * de las dos auditorías (`listSaasPlanChanges`). Lo que hizo el sistema dice «Sistema».
 */
function PlanChanges({ changes }: { changes: NonNullable<BillingTerms["changes"]> }) {
  const [all, setAll] = useState(false)
  const shown = all ? changes : changes.slice(0, CHANGES_SHOWN)
  return (
    <section aria-labelledby="plan-cambios" className="flex flex-col gap-1">
      <h3 id="plan-cambios" className="text-sm font-medium">
        Cambios del plan
      </h3>
      {changes.length ? (
        <>
          <ul className="flex flex-col divide-y text-sm">
            {shown.map((change) => (
              <li key={change.id} className="flex flex-wrap gap-x-2 gap-y-0.5 py-1.5">
                <time dateTime={change.at} className="w-20 shrink-0 text-muted-foreground tabular-nums">
                  {shortDay(change.at)}
                </time>
                <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">{change.words}</span>
                <span className="text-muted-foreground">{change.by?.name ?? "Sistema"}</span>
              </li>
            ))}
          </ul>
          {changes.length > CHANGES_SHOWN ? (
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAll((current) => !current)}>
                {all ? "Ver menos" : `Ver todos (${changes.length})`}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Todavía no cambió nada de su plan.</p>
      )}
    </section>
  )
}

/**
 * «Pasar a Fundadores» (ADR 0192): la clínica toma el plan por invitación como si entrara
 * hoy con la invitación. Lo que cambia se dice antes de confirmar; el servidor vuelve a
 * mirar si puede y si queda lugar. Si lo rechaza, el motivo queda en la pregunta y lo de
 * hoy se vuelve a leer al cerrarla.
 */
function FoundersMoveSection({
  organizationId,
  move,
  discountBps,
  spendCapCents,
  onChanged,
}: {
  organizationId: string
  move: FoundersMove
  /** El precio especial negociado que tiene hoy: al pasar se quita. */
  discountBps: number
  /** El presupuesto del mes: al pasar queda igual. */
  spendCapCents: number | null
  onChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const box = useRef<HTMLElement>(null)
  const left = Math.max(0, move.limit - move.used)
  const money = (cents: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency: move.currency }).format(cents / 100)
  // Cuando la sección se va (pasó, u otra persona ya la pasó), el foco queda en Precio y prueba.
  const keepFocus = () => {
    const around = box.current?.parentElement ?? null
    focusInsideLater(() => around)
  }
  const enter = useMutation({
    mutationFn: () =>
      api<{ planName: string; guaranteedUntil: string | null }>(`/api/admin/organizations/${organizationId}/billing/founders`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (result) => {
      toast.success(result.guaranteedUntil ? `Pasó a ${result.planName} hasta el ${shortDay(result.guaranteedUntil)}` : `Pasó a ${result.planName}`)
      setConfirming(false)
      keepFocus()
      onChanged()
    },
  })
  const months = move.guaranteeMonths ?? 0
  const conditions = move.guaranteedUntil
    ? ` Sus condiciones valen ${months} ${months === 1 ? "mes" : "meses"}, hasta el ${shortDay(move.guaranteedUntil)}${move.listPlanName ? `; después pasa al ${move.listPlanName}` : ""}.`
    : ""
  const discount = discountBps > 0 ? ` Su precio especial de ${discountBps / 100} % se quita: Fundadores trae sus precios.` : ""
  const cap = spendCapCents !== null ? ` Su presupuesto del mes sigue en ${money(spendCapCents)}.` : ""
  return (
    <section ref={box} aria-labelledby="org-founders" className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 id="org-founders" className="text-sm font-medium">
        Fundadores
      </h3>
      <p className="text-sm text-muted-foreground">
        No está en {move.planName}. {left ? `Quedan ${left} de ${move.limit} lugares.` : `Los ${move.limit} lugares están ocupados.`}
      </p>
      {left ? null : <p className="text-sm">Para pasarla, sube los lugares de {move.planName} en Cobros y planes.</p>}
      <div>
        <Button size="sm" variant="outline" type="button" disabled={!left || enter.isPending} onClick={() => setConfirming(true)}>
          Pasar a Fundadores
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="¿Pasar a Fundadores?"
        description={`Queda en ${move.planName}, con sus precios.${conditions} Su prueba empieza de nuevo hoy: ${move.trialDays} días con ${money(move.trialCreditCents)}.${discount}${cap} Ocupa uno de los ${move.limit} lugares y no se deshace desde aquí.`}
        confirmLabel="Pasar a Fundadores"
        variant="default"
        pending={enter.isPending}
        // Un rechazo no se reintenta desde la misma pregunta: al cerrarla se lee lo de hoy.
        confirmDisabled={!left || enter.isError}
        error={enter.isError ? submitErrorMessage(enter.error) : null}
        onConfirm={() => enter.mutate()}
        onClose={() => {
          setConfirming(false)
          if (enter.isError) {
            keepFocus()
            onChanged()
          }
          enter.reset()
        }}
      />
    </section>
  )
}

/** «Prueba»: saldo de regalo y días, hasta los máximos del plan que se ven en pantalla. */
function TrialForm({
  organizationId,
  data,
  plan,
  money,
  onSaved,
}: {
  organizationId: string
  data: BillingTerms
  plan: Plan
  money: (cents: number) => string
  onSaved: () => void
}) {
  const currency = plan.currency
  const save = useMutation({
    mutationFn: (body: { trialCreditCents: number; trialDays: number }) =>
      api<Outcome>(`/api/admin/organizations/${organizationId}/billing/trial`, { method: "POST", body: JSON.stringify(body) }),
  })
  const schema = z.object({
    trialCredit: z
      .string()
      .trim()
      .min(1, { message: "Escribe el saldo de regalo", abort: true })
      .refine((text) => majorToCents(text, currency) !== null, { message: "Escribe un importe válido, sin signo", abort: true })
      .refine(
        (text) => (majorToCents(text, currency) ?? 0) <= plan.trialMaxCreditCents,
        `El saldo de regalo es como mucho ${money(plan.trialMaxCreditCents)}`,
      ),
    trialDays: z
      .string()
      .trim()
      .regex(/^\d+$/, { message: "Escribe los días como un número entero", abort: true })
      .refine((text) => Number(text) >= 1, { message: "La prueba debe durar al menos un día", abort: true })
      .refine((text) => Number(text) <= plan.trialMaxDays, `La prueba dura como mucho ${plan.trialMaxDays} días`),
  })
  const form = useAppForm({
    defaultValues: { trialCredit: centsToMajor(data.trial.creditCents, currency), trialDays: String(data.trial.days) },
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      const result = await save.mutateAsync({
        // El esquema ya comprobó que es un importe válido.
        trialCreditCents: majorToCents(value.trialCredit, currency) as number,
        trialDays: Number(value.trialDays.trim()),
      })
      formApi.reset(value)
      toast.success(outcomeWords(result))
      onSaved()
    },
  })
  const onSubmit = useFormSubmit(form, { fieldMap: { trialCreditCents: "trialCredit" } })
  const error = useFormSubmitError(form)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const trialAbove = useStore(
    form.store,
    (state) =>
      (majorToCents(state.values.trialCredit, currency) ?? 0) > plan.trialCreditCents || Number(state.values.trialDays) > plan.trialDays,
  )

  return (
    <form noValidate className="flex flex-col gap-2 rounded-lg border p-3" onSubmit={onSubmit}>
      <p className="text-sm font-medium">Prueba</p>
      <div className="grid grid-cols-2 gap-2">
        <form.AppField name="trialCredit">
          {(field) => (
            <field.TextField
              id="org-trial-credit"
              label={`Saldo de regalo (${currency})`}
              description={`Hasta ${money(plan.trialMaxCreditCents)}`}
              inputMode="decimal"
            />
          )}
        </form.AppField>
        <form.AppField name="trialDays">
          {(field) => <field.TextField id="org-trial-days" label="Días" description={`Hasta ${plan.trialMaxDays}`} inputMode="numeric" />}
        </form.AppField>
      </div>
      {trialAbove ? (
        <p className="text-xs text-muted-foreground">
          Está por encima de {money(plan.trialCreditCents)} y {plan.trialDays} días: si no eres de la administración, queda pedido para aprobar. El
          saldo de regalo no genera comisión.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button size="sm" type="submit" disabled={saving}>
          Guardar prueba
        </Button>
      </div>
    </form>
  )
}

/** «Precio negociado»: descuento hasta el máximo del plan y, si se quiere, cuándo vence. */
function DiscountForm({
  organizationId,
  data,
  plan,
  onSaved,
}: {
  organizationId: string
  data: BillingTerms
  plan: Plan
  onSaved: () => void
}) {
  const currency = plan.currency
  const save = useMutation({
    mutationFn: (body: { discountBps: number; discountEndsAt: string | null }) =>
      api<Outcome>(`/api/admin/organizations/${organizationId}/billing/discount`, { method: "POST", body: JSON.stringify(body) }),
  })
  const maxWords = `El descuento máximo es ${plan.maxDiscountBps / 100} %: con más, los precios quedarían bajo el precio mínimo`
  const schema = z.object({
    discount: z
      .string()
      .trim()
      .min(1, { message: "Escribe el descuento (0 si no tiene)", abort: true })
      .refine((text) => Number.isFinite(bpsOf(text)) && bpsOf(text) >= 0, {
        message: "Escribe el descuento como un porcentaje, sin signo",
        abort: true,
      })
      .refine((text) => !(bpsOf(text) > plan.maxDiscountBps), maxWords),
    discountEnd: z
      .string()
      .refine((day) => !day || new Date(endOfDay(day)).getTime() > Date.now(), "El vencimiento tiene que ser una fecha futura"),
  })
  const box = useRef<HTMLFormElement>(null)
  const form = useAppForm({
    defaultValues: { discount: String(data.discountBps / 100), discountEnd: dayOf(data.discountEndsAt) },
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      const result = await save.mutateAsync({
        discountBps: bpsOf(value.discount),
        discountEndsAt: value.discountEnd ? endOfDay(value.discountEnd) : null,
      })
      formApi.reset(value)
      toast.success(outcomeWords(result))
      // En un plan sin descuento, quitar el que tenía hace desaparecer esta tarjeta: el foco queda en Precio y prueba.
      const around = box.current?.parentElement ?? null
      focusInsideLater(() => around)
      onSaved()
    },
  })
  const onSubmit = useFormSubmit(form, { fieldMap: { discountBps: "discount", discountEndsAt: "discountEnd" } })
  const error = useFormSubmitError(form)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const bps = useStore(form.store, (state) => bpsOf(state.values.discount))

  return (
    <form ref={box} noValidate className="flex flex-col gap-2 rounded-lg border p-3" onSubmit={onSubmit}>
      <p className="text-sm font-medium">Precio negociado</p>
      <div className="grid grid-cols-2 gap-2">
        <form.AppField name="discount">
          {(field) => <field.TextField id="org-discount" label="Descuento en lo que se negocia (%)" inputMode="decimal" />}
        </form.AppField>
        <form.AppField name="discountEnd">
          {(field) => (
            <field.Control
              id="org-discount-end"
              label={
                <>
                  Vence <span className="font-normal text-muted-foreground">(opcional)</span>
                </>
              }
            >
              {(control) => (
                <DatePickerButton
                  id={control.id}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(day) => {
                    field.handleChange(day)
                    field.handleBlur()
                  }}
                  min={dayOf(new Date(Date.now() + 86_400_000).toISOString())}
                  emptyLabel="No vence"
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
      <p className="text-xs text-muted-foreground">
        El vendedor da hasta {plan.sellerDiscountBps / 100} % sin aprobación; la administración, hasta {plan.maxDiscountBps / 100} %. La cuota no
        cambia. Sin fecha, no vence; con fecha, se avisa a la clínica y aquí {data.discountNoticeDays} días antes.
      </p>
      {Number.isFinite(bps) && bps >= 0 ? (
        <table className="w-full text-sm">
          <caption className="sr-only">Precio del plan y lo que paga esta clínica</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 font-medium">
                Acción
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Precio del plan
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
        <p className="text-xs text-muted-foreground">Si sube el precio del plan, esta clínica sigue pagando {bps / 100} % menos sobre el precio nuevo.</p>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button size="sm" type="submit" disabled={saving}>
          Guardar descuento
        </Button>
      </div>
    </form>
  )
}
