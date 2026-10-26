/**
 * Plan y precios por acción (ADR 0031 y 0085, tablero O1). La cuota vuelve
 * como crédito; cada tipo de acción tiene su precio base, si se negocia y
 * hasta dónde. La comprobación contra el peor costo, tipo por tipo, se ve
 * antes de guardar; el servidor la exige igual.
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
  isActive: boolean
  creditCents: number
  /** Gestiona y Completa (ADR 0085). */
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  conversationInformMicros: number | null
  conversationAgendaMicros: number | null
  consultationSimpleMicros: number | null
  consultationStandardMicros: number | null
  argosIncludedQuestions: number
  argosPackQuestions: number
  argosPackMicros: number | null
  storageIncludedGb: number
  storageGbMicros: number | null
  /** Lo que no admite descuento negociado. */
  fixedPriceTiers: string[]
  maxDiscountBps: number
  sellerDiscountBps: number
  trialCreditCents: number
  trialDays: number
  trialMaxCreditCents: number
  trialMaxDays: number
  isDefault: boolean
  /** La web lo publica (Fundadores, decisión 14). */
  showOnWeb: boolean
  /** Plan por invitación: lugares; null = sin tope. */
  seatLimit: number | null
  guaranteeMonths: number | null
}

interface PriceCheck {
  kind: string
  baseMicros: number | null
  minimumMicros: number | null
  worstMicros?: number | null
  baseMultiple: number | null
  minimumMultiple: number | null
  fixed?: boolean
  ok: boolean
  /** Fijo por debajo del doble: se guarda igual (D6). */
  watch?: boolean
}

const KIND_WORDS: Record<string, string> = {
  informa: "Informa",
  gestiona: "Gestiona",
  agenda: "Agenda",
  simple: "Simple",
  estandar: "Estándar",
  completa: "Completa",
  cita: "Cita recuperada",
  preguntas: "Paquete de preguntas",
  almacenamiento: "GB extra",
}

/** Los precios del plan, por tipo (ADR 0085): el campo de la API y lo que dice el formulario. */
const PRICE_FIELDS = [
  { key: "informa", field: "conversationInformMicros", label: "Informa" },
  { key: "gestiona", field: "conversationMicros", label: "Gestiona" },
  { key: "agenda", field: "conversationAgendaMicros", label: "Agenda (si viene)", hint: "Se cobra la diferencia con Gestiona" },
  { key: "simple", field: "consultationSimpleMicros", label: "Simple" },
  { key: "estandar", field: "consultationStandardMicros", label: "Estándar" },
  { key: "completa", field: "consultationMicros", label: "Completa (presupuesto)" },
  { key: "cita", field: "recoveryMicros", label: "Cita recuperada" },
  { key: "preguntas", field: "argosPackMicros", label: "Paquete de preguntas" },
  { key: "almacenamiento", field: "storageGbMicros", label: "Cada GB extra al mes" },
] as const
type PriceKey = (typeof PRICE_FIELDS)[number]["key"]
type PriceField = (typeof PRICE_FIELDS)[number]["field"]
const GROUPS: Array<{ title: string; keys: PriceKey[] }> = [
  { title: "Sofi · según lo que pasó en la agenda", keys: ["informa", "gestiona", "agenda"] },
  { title: "Clío · según lo que dejó hecho", keys: ["simple", "estandar", "completa"] },
  { title: "Argos", keys: ["cita", "preguntas"] },
  { title: "Almacenamiento", keys: ["almacenamiento"] },
]

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

/** «40 % menos que la lista»: compara un precio con el del plan de lista. */
function againstList(own: number | null, list: number | null | undefined): string | undefined {
  if (own === null || !list) return undefined
  const percent = Math.round((1 - own / list) * 100)
  if (percent > 0) return `${percent} % menos que la lista`
  if (percent < 0) return `${-percent} % más que la lista`
  return "Igual que la lista"
}

/** Un número entero positivo o vacío (null); NaN si no lo es. */
const optionalInt = (text: string) => (text.trim() ? (Number.isInteger(Number(text.trim())) ? Number(text.trim()) : Number.NaN) : null)

export function PlanDrawer({
  plan,
  listPlan,
  onClose,
  onSaved,
}: {
  plan?: AdminPlan
  /** El plan por defecto (la lista), para decir cuánto menos cuesta cada acción en este. */
  listPlan?: AdminPlan
  onClose: () => void
  onSaved: () => void
}) {
  const [code, setCode] = useState(plan?.code ?? "")
  const [name, setName] = useState(plan?.name ?? "")
  const [currency, setCurrency] = useState(plan?.currency ?? "USD")
  const [price, setPrice] = useState(plan ? centsToMajor(plan.priceCents, plan.currency) : "")
  const [credit, setCredit] = useState(plan ? centsToMajor(plan.creditCents, plan.currency) : "")
  const [prices, setPrices] = useState<Record<PriceKey, string>>(
    () => Object.fromEntries(PRICE_FIELDS.map((item) => [item.key, fromMicros(plan?.[item.field] ?? null)])) as Record<PriceKey, string>,
  )
  const [fixed, setFixed] = useState<ReadonlySet<string>>(() => new Set(plan?.fixedPriceTiers ?? ["informa", "simple", "estandar", "preguntas", "almacenamiento"]))
  const [included, setIncluded] = useState(String(plan?.argosIncludedQuestions ?? 300))
  const [packQuestions, setPackQuestions] = useState(String(plan?.argosPackQuestions ?? 100))
  const [includedGb, setIncludedGb] = useState(String(plan?.storageIncludedGb ?? 20))
  const [maxDiscount, setMaxDiscount] = useState(String((plan?.maxDiscountBps ?? 6000) / 100))
  const [sellerDiscount, setSellerDiscount] = useState(String((plan?.sellerDiscountBps ?? 1000) / 100))
  const [trialCredit, setTrialCredit] = useState(plan ? centsToMajor(plan.trialCreditCents, plan.currency) : "")
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 30))
  const [trialMaxCredit, setTrialMaxCredit] = useState(plan ? centsToMajor(plan.trialMaxCreditCents, plan.currency) : "")
  const [trialMaxDays, setTrialMaxDays] = useState(String(plan?.trialMaxDays ?? 60))
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? false)
  // Un plan nuevo nace sin publicar en la web (decisión 14 de Fundadores).
  const [showOnWeb, setShowOnWeb] = useState(plan?.showOnWeb ?? false)
  const [seatLimit, setSeatLimit] = useState(plan?.seatLimit ? String(plan.seatLimit) : "")
  const [guaranteeMonths, setGuaranteeMonths] = useState(plan?.guaranteeMonths ? String(plan.guaranteeMonths) : "")
  const [error, setError] = useState<string | null>(null)
  const compareTo = listPlan && listPlan.id !== plan?.id && listPlan.currency === currency.trim().toUpperCase() ? listPlan : undefined

  const terms = {
    currency: currency.trim().toUpperCase(),
    priceCents: majorToCents(price, currency) ?? 0,
    creditCents: majorToCents(credit || "0", currency) ?? 0,
    ...(Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, toMicros(prices[item.key])])) as Record<PriceField, number | null>),
    fixedPriceTiers: PRICE_FIELDS.map((item) => item.key).filter((key) => fixed.has(key)),
    maxDiscountBps: toBps(maxDiscount) ?? 0,
  }
  // La comprobación sigue a lo que se escribe, con una pausa para no pedirla en cada tecla.
  const [checked, setChecked] = useState(terms)
  const key = JSON.stringify(terms)
  useEffect(() => {
    const timer = setTimeout(() => setChecked(JSON.parse(key) as typeof terms), 400)
    return () => clearTimeout(timer)
  }, [key])
  // Con cuántos días de aviso termina lo garantizado: las condiciones comerciales (ADR 0074).
  const notice = useQuery({
    queryKey: ["admin", "billing", "terms"],
    queryFn: () => api<{ values: { guaranteeNoticeDays: number } }>("/api/admin/billing/terms"),
  }).data?.values.guaranteeNoticeDays
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
        ...Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, terms[item.field]])),
        fixedPriceTiers: terms.fixedPriceTiers,
        argosIncludedQuestions: Number(included),
        argosPackQuestions: Number(packQuestions),
        storageIncludedGb: Number(includedGb),
        maxDiscountBps: terms.maxDiscountBps,
        sellerDiscountBps: toBps(sellerDiscount) ?? 0,
        trialCreditCents: majorToCents(trialCredit || "0", currency) ?? 0,
        trialDays: Number(trialDays),
        trialMaxCreditCents: majorToCents(trialMaxCredit || "0", currency) ?? 0,
        trialMaxDays: Number(trialMaxDays),
        isDefault,
        showOnWeb,
        seatLimit: optionalInt(seatLimit),
        guaranteeMonths: optionalInt(guaranteeMonths),
      }
      if (Number.isNaN(body.seatLimit) || Number.isNaN(body.guaranteeMonths)) throw new Error("Lugares y meses van como números enteros, o vacíos")
      if (![body.argosIncludedQuestions, body.argosPackQuestions, body.storageIncludedGb].every((value) => Number.isInteger(value) && value >= 0)) {
        throw new Error("Las preguntas y los GB van como números enteros")
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
          <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Plan de lista" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="plan-currency">Moneda</Label>
          <CurrencySelect id="plan-currency" value={currency} onChange={setCurrency} />
        </div>
        {field("plan-price", "Cuota al mes (sin descuento)", price, setPrice)}
        {field("plan-credit", "Crédito para los agentes", credit, setCredit, "Lo que vuelve de la cuota cada mes; igual a la cuota en el plan de la ADR 0031.")}
      </div>

      {GROUPS.map((group) => (
        <fieldset key={group.title} className="flex flex-col gap-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">
            {group.title} ({currency})
          </legend>
          <div className="grid grid-cols-2 gap-3">
            {group.keys.map((key) => {
              const item = PRICE_FIELDS.find((entry) => entry.key === key)!
              return (
                <div key={key} className="flex flex-col gap-1">
                  <Label htmlFor={`plan-${key}`}>{item.label}</Label>
                  <Input
                    id={`plan-${key}`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={prices[key]}
                    onChange={(event) => setPrices({ ...prices, [key]: event.target.value })}
                  />
                  {"hint" in item ? <p className="text-xs text-muted-foreground">{item.hint}</p> : null}
                  {againstList(toMicros(prices[key]), compareTo?.[item.field]) ? (
                    <p className="text-xs text-muted-foreground">{againstList(toMicros(prices[key]), compareTo?.[item.field])}</p>
                  ) : null}
                  <div className="flex items-center gap-1.5">
                    <Checkbox
                      id={`plan-${key}-fijo`}
                      checked={fixed.has(key)}
                      onCheckedChange={(value) => {
                        const next = new Set(fixed)
                        if (value === true) next.add(key)
                        else next.delete(key)
                        setFixed(next)
                      }}
                    />
                    <Label htmlFor={`plan-${key}-fijo`} className="text-xs font-normal">
                      No se negocia
                    </Label>
                  </div>
                </div>
              )
            })}
            {group.keys.includes("preguntas") ? (
              <>
                {field("plan-included", "Preguntas incluidas al mes", included, setIncluded, undefined, "numeric")}
                {field("plan-pack", "Preguntas por paquete", packQuestions, setPackQuestions, undefined, "numeric")}
              </>
            ) : null}
            {group.keys.includes("almacenamiento") ? field("plan-gb", "GB incluidos", includedGb, setIncludedGb, undefined, "numeric") : null}
          </div>
        </fieldset>
      ))}
      <p className="-mt-2 text-xs text-muted-foreground">Vacío: el plan no cobra ese tipo. Lo que no se negocia queda siempre a su precio base.</p>

      <fieldset className="grid grid-cols-2 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Quién puede negociar</legend>
        {field("plan-seller", "El vendedor, sin pedir aprobación (%)", sellerDiscount, setSellerDiscount)}
        {field("plan-max", "La administración, hasta (%)", maxDiscount, setMaxDiscount, "Solo en lo que se negocia. La cuota no admite descuento.")}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Prueba</legend>
        {field("plan-trial-credit", "Saldo de regalo", trialCredit, setTrialCredit)}
        {field("plan-trial-days", "Días", trialDays, setTrialDays, undefined, "numeric")}
        {field("plan-trial-max-credit", "Saldo máximo con aprobación", trialMaxCredit, setTrialMaxCredit)}
        {field("plan-trial-max-days", "Días máximos con aprobación", trialMaxDays, setTrialMaxDays, undefined, "numeric")}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Por invitación (Fundadores)</legend>
        {field(
          "plan-seats",
          "Lugares (clínicas como máximo)",
          seatLimit,
          setSeatLimit,
          "Con lugares, el plan solo se entra con invitación. Vacío: es un plan normal. Bajarlo no saca a nadie.",
          "numeric",
        )}
        {field(
          "plan-guarantee",
          "Condiciones garantizadas (meses)",
          guaranteeMonths,
          setGuaranteeMonths,
          `Desde que la clínica entra; después pasa al plan por defecto${notice ? `, con aviso ${notice} días antes` : ""}.`,
          "numeric",
        )}
      </fieldset>

      <div className="flex items-start gap-2">
        <Checkbox id="plan-web" checked={showOnWeb} onCheckedChange={(value) => setShowOnWeb(value === true)} />
        <Label htmlFor="plan-web" className="flex flex-col items-start gap-0.5 font-normal">
          <span>Mostrar en la web</span>
          <span className="text-xs text-muted-foreground">Apagado al crear un plan. Al guardar, la web lo muestra en menos de un minuto.</span>
        </Label>
      </div>

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
          <>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 text-left font-medium">
                    Acción
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Precio
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Al mínimo
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Peor costo
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Veces
                  </th>
                  <th scope="col" className="py-1 pl-2 text-left font-medium">
                    <span className="sr-only">Estado</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {check.data.checks
                  .filter((item) => item.baseMicros !== null)
                  .map((item) => (
                    <tr key={item.kind} className={item.ok ? "" : "text-destructive"}>
                      <td className="py-1">{KIND_WORDS[item.kind] ?? item.kind}</td>
                      <td className="py-1 text-right tabular-nums">{money(item.baseMicros ?? 0, currency)}</td>
                      <td className="py-1 text-right tabular-nums">{money(item.minimumMicros ?? 0, currency)}</td>
                      <td className="py-1 text-right tabular-nums">{item.worstMicros != null ? money(item.worstMicros, currency) : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{item.minimumMultiple ?? "—"}</td>
                      <td className="py-1 pl-2">
                        {!item.ok ? "Menos del doble" : item.watch ? <span className="font-medium text-warning">Atento</span> : "Bien"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {check.data.checks.some((item) => item.watch) ? (
              <p className="text-xs text-muted-foreground">
                «Atento»: un precio que no se negocia y vale menos del doble de su peor costo, que es un caso extremo (una atención de 60 pausas que deja
                una sola receta). Se guarda igual y deja ganancia.
              </p>
            ) : null}
            {check.data.checks.some((item) => !item.ok) ? (
              <p className="text-xs text-destructive">Lo que se negocia debe valer, al descuento máximo, al menos el doble de su peor costo.</p>
            ) : null}
            {check.data.margin.atBase !== null ? (
              <p className="text-xs">
                Si una clínica gasta todo su crédito en el peor caso: margen de {check.data.margin.atBase} %; negociada al mínimo,{" "}
                {check.data.margin.atMinimum} %.
              </p>
            ) : null}
          </>
        )}
      </section>
    </FormDrawer>
  )
}
