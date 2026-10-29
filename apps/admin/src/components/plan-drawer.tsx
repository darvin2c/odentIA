/**
 * Plan y precios por acción (ADR 0031 y 0085, tablero O1). La cuota vuelve
 * como crédito; cada tipo de acción tiene su precio base, si se negocia y
 * hasta dónde. La comprobación contra el peor costo, tipo por tipo, se ve
 * antes de guardar; el servidor la exige igual.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import {
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api } from "../lib/api"
import { domainOf } from "../lib/host"
import { CurrencySelect, centsToMajor, majorToCents } from "./billing-fields"
import { ProductMark } from "./product"

export interface AdminPlan {
  id: string
  code: string
  name: string
  /** De qué producto es (ADR 0093): lo usan sus clínicas y su web. */
  product: ClinicalProduct
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
  /** Mensajes de la persona que cubre cada Informa (ADR 0105); null = sin tope. Por ahora solo se mide. */
  informMessageLimit: number | null
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

const NO_TEMPLATE = "ninguno"

export function PlanDrawer({
  plan,
  plans = [],
  product: initialProduct = "dental",
  onClose,
  onSaved,
}: {
  plan?: AdminPlan
  /** Todos los planes: el de lista de cada producto y los que se pueden copiar al crear uno. */
  plans?: AdminPlan[]
  /** El producto con que empieza un plan nuevo: el que se está mirando. */
  product?: ClinicalProduct
  onClose: () => void
  onSaved: () => void
}) {
  // El producto se elige al crear y no cambia después (ADR 0093).
  const [product, setProduct] = useState<ClinicalProduct>(plan?.product ?? initialProduct)
  // Un plan nuevo empieza con los precios del de lista de su producto, o de otro si se elige.
  const listOf = (of: ClinicalProduct) => plans.find((item) => item.product === of && item.isDefault && item.isActive)
  const listPlan = listOf(product)
  const [template, setTemplate] = useState(plan ? NO_TEMPLATE : (listOf(initialProduct)?.id ?? NO_TEMPLATE))
  const seed = plan ?? plans.find((item) => item.id === template)
  const [code, setCode] = useState(plan?.code ?? "")
  const [name, setName] = useState(plan?.name ?? "")
  const [currency, setCurrency] = useState(seed?.currency ?? "USD")
  const [price, setPrice] = useState(seed ? centsToMajor(seed.priceCents, seed.currency) : "")
  const [credit, setCredit] = useState(seed ? centsToMajor(seed.creditCents, seed.currency) : "")
  const [prices, setPrices] = useState<Record<PriceKey, string>>(
    () => Object.fromEntries(PRICE_FIELDS.map((item) => [item.key, fromMicros(seed?.[item.field] ?? null)])) as Record<PriceKey, string>,
  )
  const [fixed, setFixed] = useState<ReadonlySet<string>>(() => new Set(seed?.fixedPriceTiers ?? ["informa", "simple", "estandar", "preguntas", "almacenamiento"]))
  const [included, setIncluded] = useState(String(seed?.argosIncludedQuestions ?? 100))
  const [packQuestions, setPackQuestions] = useState(String(seed?.argosPackQuestions ?? 100))
  const [includedGb, setIncludedGb] = useState(String(seed?.storageIncludedGb ?? 20))
  const [informMessages, setInformMessages] = useState(seed?.informMessageLimit ? String(seed.informMessageLimit) : "")
  const [maxDiscount, setMaxDiscount] = useState(String((seed?.maxDiscountBps ?? 6000) / 100))
  const [sellerDiscount, setSellerDiscount] = useState(String((seed?.sellerDiscountBps ?? 1000) / 100))
  const [trialCredit, setTrialCredit] = useState(seed ? centsToMajor(seed.trialCreditCents, seed.currency) : "")
  const [trialDays, setTrialDays] = useState(String(seed?.trialDays ?? 30))
  const [trialMaxCredit, setTrialMaxCredit] = useState(seed ? centsToMajor(seed.trialMaxCreditCents, seed.currency) : "")
  const [trialMaxDays, setTrialMaxDays] = useState(String(seed?.trialMaxDays ?? 60))
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? false)
  // Un plan nuevo nace sin publicar en la web (decisión 14 de Fundadores).
  const [showOnWeb, setShowOnWeb] = useState(plan?.showOnWeb ?? false)
  const [seatLimit, setSeatLimit] = useState(seed?.seatLimit ? String(seed.seatLimit) : "")
  const [guaranteeMonths, setGuaranteeMonths] = useState(seed?.guaranteeMonths ? String(seed.guaranteeMonths) : "")
  const [error, setError] = useState<string | null>(null)

  /** «Empezar con los precios de»: copia los precios y la prueba de otro plan; nombre y código no. */
  function copyFrom(id: string) {
    setTemplate(id)
    const from = plans.find((item) => item.id === id)
    if (!from) return
    setCurrency(from.currency)
    setPrice(centsToMajor(from.priceCents, from.currency))
    setCredit(centsToMajor(from.creditCents, from.currency))
    setPrices(Object.fromEntries(PRICE_FIELDS.map((item) => [item.key, fromMicros(from[item.field])])) as Record<PriceKey, string>)
    setFixed(new Set(from.fixedPriceTiers))
    setIncluded(String(from.argosIncludedQuestions))
    setPackQuestions(String(from.argosPackQuestions))
    setIncludedGb(String(from.storageIncludedGb))
    setInformMessages(from.informMessageLimit ? String(from.informMessageLimit) : "")
    setMaxDiscount(String(from.maxDiscountBps / 100))
    setSellerDiscount(String(from.sellerDiscountBps / 100))
    setTrialCredit(centsToMajor(from.trialCreditCents, from.currency))
    setTrialDays(String(from.trialDays))
    setTrialMaxCredit(centsToMajor(from.trialMaxCreditCents, from.currency))
    setTrialMaxDays(String(from.trialMaxDays))
    setSeatLimit(from.seatLimit ? String(from.seatLimit) : "")
    setGuaranteeMonths(from.guaranteeMonths ? String(from.guaranteeMonths) : "")
  }
  const words = productWords(product)
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
        // Solo al crear: el servidor no deja cambiarlo después.
        ...(plan ? {} : { product }),
        currency: currency.trim().toUpperCase(),
        priceCents,
        creditCents: terms.creditCents,
        ...Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, terms[item.field]])),
        fixedPriceTiers: terms.fixedPriceTiers,
        argosIncludedQuestions: Number(included),
        argosPackQuestions: Number(packQuestions),
        storageIncludedGb: Number(includedGb),
        informMessageLimit: optionalInt(informMessages),
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
      if (body.informMessageLimit !== null && !(body.informMessageLimit >= 1 && body.informMessageLimit <= 1000)) {
        throw new Error("Los mensajes por Informa van de 1 a 1000, o vacío para no poner tope")
      }
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
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode={inputMode}
        autoComplete="off"
        value={value}
        onChange={(event) => set(event.target.value)}
        aria-describedby={hint ? `${id}-ayuda` : undefined}
      />
      {hint ? <FieldDescription id={`${id}-ayuda`}>{hint}</FieldDescription> : null}
    </Field>
  )

  return (
    <FormDrawer
      open
      title={plan ? "Editar plan" : "Nuevo plan"}
      description={
        plan
          ? "Cambiar un precio rige desde ahora: lo ya contado y los cargos emitidos no cambian."
          : "Cada plan es de un producto: lo usan sus clínicas y su web."
      }
      submitLabel={plan ? "Guardar" : "Crear plan"}
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
      error={error}
      // Muchos campos con su ayuda: a 24rem quedaban dos columnas de 160 px.
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(40rem,calc(100vw-2rem))]"
    >
      <FieldGroup>
        {plan ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ProductMark product={plan.product} /> · {domainOf(plan.product)}
          </p>
        ) : (
          <>
            <FieldSet className="gap-3">
              <FieldLegend variant="label" className="mb-0">
                Producto
              </FieldLegend>
              <RadioGroup
                aria-label="Producto"
                value={product}
                onValueChange={(value) => {
                  if (value !== "dental" && value !== "medical") return
                  setProduct(value)
                  // Se marca por defecto o se publica en la web del producto nuevo, no del anterior.
                  setIsDefault(false)
                }}
                className="flex flex-wrap gap-2"
              >
                {CLINICAL_PRODUCTS.map((option) => (
                  <FieldLabel
                    key={option}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 font-normal has-data-checked:border-foreground"
                  >
                    <RadioGroupItem value={option} />
                    <ProductMark product={option} className="text-sm" />
                  </FieldLabel>
                ))}
              </RadioGroup>
              <FieldDescription>No se cambia después: sus clínicas y su web son de ese producto.</FieldDescription>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="plan-template">Empezar con los precios de</FieldLabel>
              <Select
                value={template}
                onValueChange={(value) => (value === null || value === NO_TEMPLATE ? setTemplate(NO_TEMPLATE) : copyFrom(String(value)))}
                items={{ [NO_TEMPLATE]: "Ninguno: en blanco", ...Object.fromEntries(plans.map((item) => [item.id, `${item.name} · ${productWords(item.product).name}`])) }}
              >
                <SelectTrigger id="plan-template" className="w-full" aria-describedby="plan-template-ayuda">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name} · {productWords(item.product).name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_TEMPLATE}>Ninguno: en blanco</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription id="plan-template-ayuda">Copia precios, crédito y prueba; después cambias lo que quieras.</FieldDescription>
            </Field>
          </>
        )}

        <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="plan-code">Código</FieldLabel>
            <Input id="plan-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="odentia" />
          </Field>
          <Field>
            <FieldLabel htmlFor="plan-name">Nombre</FieldLabel>
            <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Plan de lista" />
          </Field>
          <Field>
            <FieldLabel htmlFor="plan-currency">Moneda</FieldLabel>
            <CurrencySelect id="plan-currency" value={currency} onChange={setCurrency} />
          </Field>
          {field("plan-price", "Cuota al mes (sin descuento)", price, setPrice)}
        </div>
        {field("plan-credit", "Crédito para los agentes", credit, setCredit, "Lo que vuelve de la cuota cada mes.")}

        <FieldSet>
          <FieldLegend>Precios por acción ({currency})</FieldLegend>
          <FieldDescription>Vacío: el plan no cobra ese tipo. Lo que no se negocia queda siempre a su precio base.</FieldDescription>
          {GROUPS.map((group) => (
            <FieldSet key={group.title} className="gap-4">
              <FieldLegend variant="label" className="mb-0">
                {group.title}
              </FieldLegend>
              <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
                {group.keys.map((key) => {
                  const item = PRICE_FIELDS.find((entry) => entry.key === key)!
                  const hint = ["hint" in item ? item.hint : undefined, againstList(toMicros(prices[key]), compareTo?.[item.field])].filter(Boolean).join(" · ")
                  return (
                    <Field key={key}>
                      <FieldLabel htmlFor={`plan-${key}`}>{item.label}</FieldLabel>
                      <Input
                        id={`plan-${key}`}
                        inputMode="decimal"
                        autoComplete="off"
                        value={prices[key]}
                        onChange={(event) => setPrices({ ...prices, [key]: event.target.value })}
                        aria-describedby={hint ? `plan-${key}-ayuda` : undefined}
                      />
                      {hint ? <FieldDescription id={`plan-${key}-ayuda`}>{hint}</FieldDescription> : null}
                      <div className="flex items-center gap-2">
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
                        <FieldLabel htmlFor={`plan-${key}-fijo`} className="font-normal">
                          No se negocia
                        </FieldLabel>
                      </div>
                    </Field>
                  )
                })}
                {group.keys.includes("informa")
                  ? field(
                      "plan-inform-messages",
                      "Mensajes por Informa",
                      informMessages,
                      setInformMessages,
                      "Mensajes de la persona que cubre cada Informa en su ventana. Por ahora solo se mide en Costo y margen: nadie lo paga. Vacío: sin tope.",
                      "numeric",
                    )
                  : null}
                {group.keys.includes("preguntas") ? (
                  <>
                    {field("plan-included", "Preguntas incluidas al mes", included, setIncluded, undefined, "numeric")}
                    {field("plan-pack", "Preguntas por paquete", packQuestions, setPackQuestions, undefined, "numeric")}
                  </>
                ) : null}
                {group.keys.includes("almacenamiento") ? field("plan-gb", "GB incluidos", includedGb, setIncludedGb, undefined, "numeric") : null}
              </div>
            </FieldSet>
          ))}
        </FieldSet>

        <FieldSet>
          <FieldLegend>Quién puede negociar</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
            {field("plan-seller", "El vendedor, sin pedir aprobación (%)", sellerDiscount, setSellerDiscount)}
            {field("plan-max", "La administración, hasta (%)", maxDiscount, setMaxDiscount, "Solo en lo que se negocia. La cuota no admite descuento.")}
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Prueba</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
            {field("plan-trial-credit", "Saldo de regalo", trialCredit, setTrialCredit)}
            {field("plan-trial-days", "Días", trialDays, setTrialDays, undefined, "numeric")}
            {field("plan-trial-max-credit", "Saldo máximo con aprobación", trialMaxCredit, setTrialMaxCredit)}
            {field("plan-trial-max-days", "Días máximos con aprobación", trialMaxDays, setTrialMaxDays, undefined, "numeric")}
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Por invitación (Fundadores)</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
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
          </div>
        </FieldSet>

        <FieldGroup>
          <Field orientation="horizontal">
            <Checkbox id="plan-web" aria-describedby="plan-web-ayuda" checked={showOnWeb} onCheckedChange={(value) => setShowOnWeb(value === true)} />
            <FieldContent>
              <FieldLabel htmlFor="plan-web">Mostrar en {domainOf(product)}</FieldLabel>
              <FieldDescription id="plan-web-ayuda">
                Sus precios salen en la web de {words.name}. Apagado al crear un plan; al guardar, la web lo muestra en menos de un minuto.
              </FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="plan-default" aria-describedby="plan-default-ayuda" checked={isDefault} onCheckedChange={(value) => setIsDefault(value === true)} />
            <FieldContent>
              <FieldLabel htmlFor="plan-default">Plan por defecto de {words.name}</FieldLabel>
              <FieldDescription id="plan-default-ayuda">
                Con él abren, prueban y se cuentan las clínicas de {words.name} que no eligen otro. El de{" "}
                {productWords(product === "dental" ? "medical" : "dental").name} no cambia.
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>

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
      </FieldGroup>
    </FormDrawer>
  )
}
