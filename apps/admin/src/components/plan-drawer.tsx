/**
 * Plan y precios por acción (ADR 0030, tablero O1). La cuota vuelve como
 * crédito; cada acción tiene su precio base y hasta dónde se negocia. La
 * comprobación contra el peor costo se ve antes de guardar; el servidor la
 * exige igual.
 */
import { Checkbox, Input, Label } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api } from "../lib/api"
import { CurrencySelect, centsToMajor, majorToCents } from "./billing-fields"

export interface AdminPlan {
  id: string
  code: string
  name: string
  description: string | null
  currency: string
  priceCents: number
  billingPeriod: string
  maxBranches: number | null
  maxSeats: number | null
  isActive: boolean
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  maxDiscountBps: number
  sellerDiscountBps: number
  trialCreditCents: number
  trialDays: number
  trialMaxCreditCents: number
  trialMaxDays: number
  isDefault: boolean
}

interface PriceCheck {
  kind: "conversacion" | "consulta" | "cita"
  baseMicros: number | null
  minimumMicros: number | null
  baseMultiple: number | null
  minimumMultiple: number | null
  ok: boolean
}

const KIND_WORDS = { conversacion: "Conversación", consulta: "Consulta dictada y confirmada", cita: "Cita recuperada" } as const

/** «0.50» → 500000 millonésimas; null si está vacío o no es un importe. */
function toMicros(text: string): number | null {
  if (!text.trim()) return null
  const value = Number(text.trim().replace(",", "."))
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : null
}
const fromMicros = (micros: number | null) => (micros === null ? "" : String(micros / 1_000_000))
/** «10» → 1000 puntos básicos. */
const toBps = (text: string) => {
  const value = Number(text.trim().replace(",", "."))
  return Number.isFinite(value) ? Math.round(value * 100) : null
}

function money(micros: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micros / 1_000_000)
}

export function PlanDrawer({ plan, onClose, onSaved }: { plan?: AdminPlan; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(plan?.code ?? "")
  const [name, setName] = useState(plan?.name ?? "")
  const [currency, setCurrency] = useState(plan?.currency ?? "USD")
  const [price, setPrice] = useState(plan ? centsToMajor(plan.priceCents, plan.currency) : "")
  const [credit, setCredit] = useState(plan ? centsToMajor(plan.creditCents, plan.currency) : "")
  const [conversation, setConversation] = useState(fromMicros(plan?.conversationMicros ?? null))
  const [consultation, setConsultation] = useState(fromMicros(plan?.consultationMicros ?? null))
  const [recovery, setRecovery] = useState(fromMicros(plan?.recoveryMicros ?? null))
  const [maxDiscount, setMaxDiscount] = useState(String((plan?.maxDiscountBps ?? 6000) / 100))
  const [sellerDiscount, setSellerDiscount] = useState(String((plan?.sellerDiscountBps ?? 1000) / 100))
  const [trialCredit, setTrialCredit] = useState(plan ? centsToMajor(plan.trialCreditCents, plan.currency) : "")
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 30))
  const [trialMaxCredit, setTrialMaxCredit] = useState(plan ? centsToMajor(plan.trialMaxCreditCents, plan.currency) : "")
  const [trialMaxDays, setTrialMaxDays] = useState(String(plan?.trialMaxDays ?? 60))
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? false)
  const [error, setError] = useState<string | null>(null)

  const terms = {
    currency: currency.trim().toUpperCase(),
    priceCents: majorToCents(price, currency) ?? 0,
    creditCents: majorToCents(credit || "0", currency) ?? 0,
    conversationMicros: toMicros(conversation),
    consultationMicros: toMicros(consultation),
    recoveryMicros: toMicros(recovery),
    maxDiscountBps: toBps(maxDiscount) ?? 0,
  }
  // La comprobación sigue a lo que se escribe, con una pausa para no pedirla en cada tecla.
  const [checked, setChecked] = useState(terms)
  const key = JSON.stringify(terms)
  useEffect(() => {
    const timer = setTimeout(() => setChecked(JSON.parse(key) as typeof terms), 400)
    return () => clearTimeout(timer)
  }, [key])
  const check = useQuery({
    queryKey: ["admin", "billing", "plan-check", checked],
    queryFn: () =>
      api<{ checks: PriceCheck[]; margin: { atBase: number | null; atMinimum: number | null } }>("/api/admin/billing/plans/check", {
        method: "POST",
        body: JSON.stringify(checked),
      }),
    enabled: /^[A-Z]{3}$/.test(checked.currency),
    retry: false,
  })

  const save = useMutation({
    mutationFn: () => {
      const priceCents = majorToCents(price, currency)
      if (priceCents === null) throw new Error("Precio inválido")
      const body = {
        code: code.trim(),
        name: name.trim(),
        currency: currency.trim().toUpperCase(),
        priceCents,
        creditCents: terms.creditCents,
        conversationMicros: terms.conversationMicros,
        consultationMicros: terms.consultationMicros,
        recoveryMicros: terms.recoveryMicros,
        maxDiscountBps: terms.maxDiscountBps,
        sellerDiscountBps: toBps(sellerDiscount) ?? 0,
        trialCreditCents: majorToCents(trialCredit || "0", currency) ?? 0,
        trialDays: Number(trialDays),
        trialMaxCreditCents: majorToCents(trialMaxCredit || "0", currency) ?? 0,
        trialMaxDays: Number(trialMaxDays),
        isDefault,
      }
      return plan
        ? api(`/api/admin/billing/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api("/api/admin/billing/plans", { method: "POST", body: JSON.stringify(body) })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) => setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar") : e instanceof Error ? e.message : "No se pudo guardar"),
  })

  const field = (id: string, label: string, value: string, set: (value: string) => void, hint?: string, inputMode: "decimal" | "numeric" = "decimal") => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode={inputMode} autoComplete="off" value={value} onChange={(event) => set(event.target.value)} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )

  return (
    <FormDrawer
      open
      title={plan ? "Editar plan" : "Nuevo plan"}
      description="Planes y precios se configuran aquí, sin tocar código. Cambiar un precio rige desde ahora: lo ya contado y los cargos emitidos no cambian."
      submitLabel="Guardar"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
      error={error}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="plan-code">Código</Label>
          <Input id="plan-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="odentia" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="plan-name">Nombre</Label>
          <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Plan odentIA" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="plan-currency">Moneda</Label>
          <CurrencySelect id="plan-currency" value={currency} onChange={setCurrency} />
        </div>
        {field("plan-price", "Cuota al mes (sin descuento)", price, setPrice)}
        {field("plan-credit", "Crédito para los agentes", credit, setCredit, "Lo que vuelve de la cuota cada mes; igual a la cuota en el plan de la ADR 0030.")}
      </div>

      <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Precio base por acción ({currency})</legend>
        <div className="grid grid-cols-3 gap-3">
          {field("plan-conversation", "Conversación", conversation, setConversation)}
          {field("plan-consultation", "Consulta", consultation, setConsultation)}
          {field("plan-recovery", "Cita recuperada", recovery, setRecovery)}
        </div>
        <p className="text-xs text-muted-foreground">Vacío: el plan no cobra esa acción.</p>
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Quién puede negociar</legend>
        {field("plan-seller", "El vendedor, sin pedir aprobación (%)", sellerDiscount, setSellerDiscount)}
        {field("plan-max", "La administración, hasta (%)", maxDiscount, setMaxDiscount, "Es el precio mínimo. La cuota no admite descuento.")}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Prueba</legend>
        {field("plan-trial-credit", "Saldo de regalo", trialCredit, setTrialCredit)}
        {field("plan-trial-days", "Días", trialDays, setTrialDays, undefined, "numeric")}
        {field("plan-trial-max-credit", "Saldo máximo con aprobación", trialMaxCredit, setTrialMaxCredit)}
        {field("plan-trial-max-days", "Días máximos con aprobación", trialMaxDays, setTrialMaxDays, undefined, "numeric")}
      </fieldset>

      <div className="flex items-start gap-2">
        <Checkbox id="plan-default" checked={isDefault} onCheckedChange={(value) => setIsDefault(value === true)} />
        <Label htmlFor="plan-default" className="font-normal">
          Plan por defecto: con él se cuenta y se prueba mientras la clínica no elige otro.
        </Label>
      </div>

      <section aria-label="Comprobación antes de guardar" className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
        <p className="font-medium">Comprobación antes de guardar</p>
        {check.isPending ? (
          <p className="text-muted-foreground">Comprobando…</p>
        ) : check.isError || !check.data ? (
          <p className="text-muted-foreground">No se pudo comprobar ahora; el servidor lo comprobará igual al guardar.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {check.data.checks
              .filter((item) => item.baseMicros !== null)
              .map((item) => (
                <li key={item.kind} className={item.ok ? "" : "text-destructive"}>
                  <span aria-hidden="true">{item.ok ? "✓ " : "✕ "}</span>
                  {item.baseMultiple === null
                    ? `${KIND_WORDS[item.kind]}: sin peor costo en ${currency} para comparar.`
                    : `${KIND_WORDS[item.kind]} a ${money(item.baseMicros ?? 0, currency)}: ${item.baseMultiple} veces su peor costo. Al mínimo, ${money(item.minimumMicros ?? 0, currency)}: ${item.minimumMultiple} veces.`}
                  {item.ok ? null : " Debe valer al menos el doble de su peor costo."}
                </li>
              ))}
            {check.data.margin.atBase !== null ? (
              <li>
                <span aria-hidden="true">✓ </span>
                Si una clínica gasta todo su crédito en el peor caso: margen de {check.data.margin.atBase} %; negociada al mínimo,{" "}
                {check.data.margin.atMinimum} %.
              </li>
            ) : null}
          </ul>
        )}
      </section>
    </FormDrawer>
  )
}
