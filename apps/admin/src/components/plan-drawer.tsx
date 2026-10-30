/**
 * Plan y precios por acción (ADR 0031 y 0085, tablero O1). La cuota vuelve
 * como crédito; cada tipo de acción tiene su precio base, si se negocia y
 * hasta dónde. La comprobación contra el peor costo, tipo por tipo, se ve
 * antes de guardar; el servidor la exige igual.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import {
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
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

const NO_TEMPLATE = "ninguno"

const PRICE_KEYS = PRICE_FIELDS.map((item) => item.key) as [PriceKey, ...PriceKey[]]
/** Lo que no se negocia en un plan en blanco (ADR 0085). */
const DEFAULT_FIXED: readonly string[] = ["informa", "simple", "estandar", "preguntas", "almacenamiento"]

/** Los precios, el crédito y la prueba de un plan, como se escriben: lo que copia «Empezar con los precios de». */
function termsOf(seed: AdminPlan | undefined) {
  return {
    currency: seed?.currency ?? "USD",
    price: seed ? centsToMajor(seed.priceCents, seed.currency) : "",
    credit: seed ? centsToMajor(seed.creditCents, seed.currency) : "0",
    prices: Object.fromEntries(PRICE_FIELDS.map((item) => [item.key, fromMicros(seed?.[item.field] ?? null)])) as Record<PriceKey, string>,
    fixed: Object.fromEntries(PRICE_FIELDS.map((item) => [item.key, (seed?.fixedPriceTiers ?? DEFAULT_FIXED).includes(item.key)])) as Record<
      PriceKey,
      boolean
    >,
    included: String(seed?.argosIncludedQuestions ?? 100),
    packQuestions: String(seed?.argosPackQuestions ?? 100),
    includedGb: String(seed?.storageIncludedGb ?? 20),
    informMessages: seed?.informMessageLimit ? String(seed.informMessageLimit) : "",
    maxDiscount: String((seed?.maxDiscountBps ?? 6000) / 100),
    sellerDiscount: String((seed?.sellerDiscountBps ?? 1000) / 100),
    trialCredit: seed ? centsToMajor(seed.trialCreditCents, seed.currency) : "0",
    trialDays: String(seed?.trialDays ?? 30),
    trialMaxCredit: seed ? centsToMajor(seed.trialMaxCreditCents, seed.currency) : "0",
    trialMaxDays: String(seed?.trialMaxDays ?? 60),
    seatLimit: seed?.seatLimit ? String(seed.seatLimit) : "",
    guaranteeMonths: seed?.guaranteeMonths ? String(seed.guaranteeMonths) : "",
  }
}

const INTEGER = /^\d+$/
const AMOUNT = /^\d+(?:[.,]\d+)?$/
const PERCENT = /^\d+(?:[.,]\d{1,2})?$/
const MAX_CENTS = 2147483647
/** El precio por acción más alto que admite la API: 1 000 000 000 millonésimas. */
const MAX_PRICE_MICROS = 1_000_000_000

/**
 * El plan como se escribe, con los mismos límites que la ruta: cada número es
 * texto y cada error va en su campo. Un precio por acción vacío es «no cobra
 * ese tipo» (lo dice la pantalla); los lugares, los meses y los mensajes por
 * Informa vacíos, «sin tope».
 */
const planSchema = z
  .object({
    product: z.enum(CLINICAL_PRODUCTS),
    template: z.string(),
    code: z.string().trim().min(1, "Escribe el código del plan").max(80, "Escribe como mucho 80 caracteres"),
    name: z.string().trim().min(1, "Escribe el nombre del plan").max(120, "Escribe como mucho 120 caracteres"),
    currency: z.string().regex(/^[A-Z]{3}$/, "Elige la moneda"),
    price: z.string(),
    credit: z.string(),
    prices: z.record(z.enum(PRICE_KEYS), z.string()),
    fixed: z.record(z.enum(PRICE_KEYS), z.boolean()),
    included: z.string(),
    packQuestions: z.string(),
    includedGb: z.string(),
    informMessages: z.string(),
    maxDiscount: z.string(),
    sellerDiscount: z.string(),
    trialCredit: z.string(),
    trialDays: z.string(),
    trialMaxCredit: z.string(),
    trialMaxDays: z.string(),
    isDefault: z.boolean(),
    showOnWeb: z.boolean(),
    seatLimit: z.string(),
    guaranteeMonths: z.string(),
  })
  .superRefine((value, ctx) => {
    const say = (path: Array<string>, message: string) => ctx.addIssue({ code: "custom", path, message })
    const amount = (text: string) => {
      const cents = AMOUNT.test(text.trim()) ? majorToCents(text, value.currency) : null
      return cents !== null && cents <= MAX_CENTS ? cents : null
    }
    const integer = (text: string, min: number, max: number) =>
      INTEGER.test(text.trim()) && Number(text.trim()) >= min && Number(text.trim()) <= max ? Number(text.trim()) : null
    const percent = (text: string) => {
      const bps = PERCENT.test(text.trim()) ? toBps(text) : null
      return bps !== null && bps <= 9000 ? bps : null
    }

    if (amount(value.price) === null) say(["price"], "Escribe la cuota en números, por ejemplo 29 o 29.90")
    if (amount(value.credit) === null) say(["credit"], "Escribe un importe en números (0 si no tiene)")
    for (const key of PRICE_KEYS) {
      const text = value.prices[key].trim()
      if (!text) continue
      const micros = AMOUNT.test(text) ? toMicros(text) : null
      if (micros === null || micros > MAX_PRICE_MICROS) say(["prices", key], "Escribe un importe, o déjalo vacío si el plan no cobra este tipo")
    }
    if (integer(value.included, 0, 100_000) === null) say(["included"], "Escribe un número entero de 0 a 100000")
    if (integer(value.packQuestions, 1, 10_000) === null) say(["packQuestions"], "Escribe un número entero de 1 a 10000")
    if (integer(value.includedGb, 0, 100_000) === null) say(["includedGb"], "Escribe un número entero de 0 a 100000")
    if (value.informMessages.trim() && integer(value.informMessages, 1, 1000) === null) {
      say(["informMessages"], "Escribe de 1 a 1000 mensajes, o déjalo vacío para no poner tope")
    }

    const maxDiscount = percent(value.maxDiscount)
    const sellerDiscount = percent(value.sellerDiscount)
    if (maxDiscount === null) say(["maxDiscount"], "Escribe un porcentaje de 0 a 90")
    if (sellerDiscount === null) say(["sellerDiscount"], "Escribe un porcentaje de 0 a 90")
    else if (maxDiscount !== null && sellerDiscount > maxDiscount) say(["sellerDiscount"], "El vendedor no puede dar más que el descuento máximo")

    const trialCredit = amount(value.trialCredit)
    const trialMaxCredit = amount(value.trialMaxCredit)
    if (trialCredit === null) say(["trialCredit"], "Escribe un importe en números (0 si no tiene)")
    if (trialMaxCredit === null) say(["trialMaxCredit"], "Escribe un importe en números (0 si no tiene)")
    else if (trialCredit !== null && trialMaxCredit < trialCredit) say(["trialMaxCredit"], "El saldo máximo de prueba no puede ser menor que el de siempre")
    const trialDays = integer(value.trialDays, 1, 365)
    const trialMaxDays = integer(value.trialMaxDays, 1, 365)
    if (trialDays === null) say(["trialDays"], "Escribe de 1 a 365 días")
    if (trialMaxDays === null) say(["trialMaxDays"], "Escribe de 1 a 365 días")
    else if (trialDays !== null && trialMaxDays < trialDays) say(["trialMaxDays"], "Los días máximos de prueba no pueden ser menos que los de siempre")

    if (value.seatLimit.trim() && integer(value.seatLimit, 1, 100_000) === null) {
      say(["seatLimit"], "Escribe un número entero mayor que cero, o déjalo vacío")
    }
    if (value.guaranteeMonths.trim() && integer(value.guaranteeMonths, 1, 120) === null) {
      say(["guaranteeMonths"], "Escribe de 1 a 120 meses, o déjalo vacío")
    }
  })
type PlanValues = z.input<typeof planSchema>
type NumberKey = Exclude<keyof PlanValues, "product" | "template" | "code" | "name" | "currency" | "prices" | "fixed" | "isDefault" | "showOnWeb">

/** Cómo llama la API a cada dato del formulario (`priceCents` → la cuota escrita). */
const PLAN_FIELD_MAP: Record<string, string> = {
  priceCents: "price",
  creditCents: "credit",
  argosIncludedQuestions: "included",
  argosPackQuestions: "packQuestions",
  storageIncludedGb: "includedGb",
  informMessageLimit: "informMessages",
  maxDiscountBps: "maxDiscount",
  sellerDiscountBps: "sellerDiscount",
  trialCreditCents: "trialCredit",
  trialMaxCreditCents: "trialMaxCredit",
  ...Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, `prices.${item.key}`])),
}

/** El cuerpo de la API desde lo escrito, ya validado por `planSchema`: ninguna conversión cae en silencio. */
function planBody(value: PlanValues, isNew: boolean) {
  const currency = value.currency.trim().toUpperCase()
  // planSchema ya comprobó que cada importe se lee: el null no llega; si llegara, es un error de programa.
  const cents = (text: string) => {
    const value = majorToCents(text, currency)
    if (value === null) throw new Error(`Importe sin validar: ${text}`)
    return value
  }
  const optional = (text: string) => (text.trim() ? Number(text.trim()) : null)
  return {
    code: value.code.trim(),
    name: value.name.trim(),
    // Solo al crear: el servidor no deja cambiarlo después.
    ...(isNew ? { product: value.product } : {}),
    currency,
    priceCents: cents(value.price),
    creditCents: cents(value.credit),
    ...Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, toMicros(value.prices[item.key])])),
    fixedPriceTiers: PRICE_KEYS.filter((key) => value.fixed[key]),
    argosIncludedQuestions: Number(value.included.trim()),
    argosPackQuestions: Number(value.packQuestions.trim()),
    storageIncludedGb: Number(value.includedGb.trim()),
    informMessageLimit: optional(value.informMessages),
    maxDiscountBps: toBps(value.maxDiscount),
    sellerDiscountBps: toBps(value.sellerDiscount),
    trialCreditCents: cents(value.trialCredit),
    trialDays: Number(value.trialDays.trim()),
    trialMaxCreditCents: cents(value.trialMaxCredit),
    trialMaxDays: Number(value.trialMaxDays.trim()),
    isDefault: value.isDefault,
    showOnWeb: value.showOnWeb,
    seatLimit: optional(value.seatLimit),
    guaranteeMonths: optional(value.guaranteeMonths),
  }
}

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
  // Un plan nuevo empieza con los precios del de lista de su producto, o de otro si se elige.
  const listOf = (of: ClinicalProduct) => plans.find((item) => item.product === of && item.isDefault && item.isActive)
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof planBody>) =>
      plan
        ? api(`/api/admin/billing/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api("/api/admin/billing/plans", { method: "POST", body: JSON.stringify(body) }),
  })
  // Los valores iniciales se fijan al abrir: la lista de planes que llega después no reinicia el borrador.
  const [initial] = useState((): PlanValues => {
    const template = plan ? NO_TEMPLATE : (listOf(initialProduct)?.id ?? NO_TEMPLATE)
    return {
      // El producto se elige al crear y no cambia después (ADR 0093).
      product: plan?.product ?? initialProduct,
      template,
      code: plan?.code ?? "",
      name: plan?.name ?? "",
      ...termsOf(plan ?? plans.find((item) => item.id === template)),
      isDefault: plan?.isDefault ?? false,
      // Un plan nuevo nace sin publicar en la web (decisión 14 de Fundadores).
      showOnWeb: plan?.showOnWeb ?? false,
    }
  })
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: planSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(planBody(value, !plan))
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: PLAN_FIELD_MAP })
  const values = useStore(form.store, (state) => state.values)
  const { product, currency } = values

  /** «Empezar con los precios de»: copia los precios y la prueba de otro plan; nombre y código no. */
  function copyFrom(id: string) {
    form.setFieldValue("template", id)
    const from = plans.find((item) => item.id === id)
    if (!from) return
    const { prices, fixed, ...texts } = termsOf(from)
    for (const key of Object.keys(texts) as Array<keyof typeof texts>) form.setFieldValue(key, texts[key])
    form.setFieldValue("prices", prices)
    form.setFieldValue("fixed", fixed)
  }
  const words = productWords(product)
  const listPlan = listOf(product)
  const compareTo = listPlan && listPlan.id !== plan?.id && listPlan.currency === currency.trim().toUpperCase() ? listPlan : undefined

  // Solo para ver la comprobación mientras se escribe: lo que aún no es un número no se compara. Guardar valida cada campo.
  const terms = {
    currency: currency.trim().toUpperCase(),
    priceCents: majorToCents(values.price, currency) ?? 0,
    creditCents: majorToCents(values.credit, currency) ?? 0,
    ...(Object.fromEntries(PRICE_FIELDS.map((item) => [item.field, toMicros(values.prices[item.key])])) as Record<PriceField, number | null>),
    fixedPriceTiers: PRICE_KEYS.filter((key) => values.fixed[key]),
    maxDiscountBps: toBps(values.maxDiscount) ?? 0,
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

  const numberField = (name: NumberKey, id: string, label: string, description?: string, inputMode: "decimal" | "numeric" = "decimal") => (
    <form.AppField name={name}>
      {(field) => <field.TextField id={id} label={label} description={description} inputMode={inputMode} autoComplete="off" />}
    </form.AppField>
  )

  return (
    <FormDrawer
      {...surface}
      open
      title={plan ? "Editar plan" : "Nuevo plan"}
      description={
        plan
          ? "Cambiar un precio rige desde ahora: lo ya contado y los cargos emitidos no cambian."
          : "Cada plan es de un producto: lo usan sus clínicas y su web."
      }
      submitLabel={plan ? "Guardar" : "Crear plan"}
      onClose={onClose}
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
            <form.AppField name="product">
              {(field) => (
                <field.Group legend="Producto" description="No se cambia después: sus clínicas y su web son de ese producto." className="gap-3">
                  {(control) => (
                    <RadioGroup
                      aria-label="Producto"
                      aria-describedby={control.describedBy}
                      aria-invalid={control.invalid || undefined}
                      value={field.state.value}
                      onValueChange={(value) => {
                        if (value !== "dental" && value !== "medical") return
                        field.handleChange(value)
                        // Se marca por defecto o se publica en la web del producto nuevo, no del anterior.
                        form.setFieldValue("isDefault", false)
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
                  )}
                </field.Group>
              )}
            </form.AppField>
            <form.AppField name="template">
              {(field) => (
                <field.Control
                  id="plan-template"
                  label="Empezar con los precios de"
                  description="Copia precios, crédito y prueba; después cambias lo que quieras."
                >
                  {(control) => (
                    <Select
                      value={field.state.value}
                      onValueChange={(value) => (value === null || value === NO_TEMPLATE ? field.handleChange(NO_TEMPLATE) : copyFrom(String(value)))}
                      items={{
                        [NO_TEMPLATE]: "Ninguno: en blanco",
                        ...Object.fromEntries(plans.map((item) => [item.id, `${item.name} · ${productWords(item.product).name}`])),
                      }}
                    >
                      <SelectTrigger {...control.props} className="w-full">
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
                  )}
                </field.Control>
              )}
            </form.AppField>
          </>
        )}

        <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
          <form.AppField name="code">{(field) => <field.TextField id="plan-code" label="Código" placeholder="odentia" />}</form.AppField>
          <form.AppField name="name">{(field) => <field.TextField id="plan-name" label="Nombre" placeholder="Plan de lista" />}</form.AppField>
          <form.AppField name="currency">
            {(field) => (
              <field.Control id="plan-currency" label="Moneda">
                {(control) => (
                  <CurrencySelect
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(code) => field.handleChange(code)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          {numberField("price", "plan-price", "Cuota al mes (sin descuento)")}
        </div>
        {numberField("credit", "plan-credit", "Crédito para los agentes", "Lo que vuelve de la cuota cada mes.")}

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
                  const hint = ["hint" in item ? item.hint : undefined, againstList(toMicros(values.prices[key]), compareTo?.[item.field])]
                    .filter(Boolean)
                    .join(" · ")
                  return (
                    <div key={key} className="flex flex-col gap-3">
                      <form.AppField name={`prices.${key}`}>
                        {(field) => (
                          <field.TextField id={`plan-${key}`} label={item.label} description={hint || undefined} inputMode="decimal" autoComplete="off" />
                        )}
                      </form.AppField>
                      <form.AppField name={`fixed.${key}`}>{(field) => <field.CheckboxField id={`plan-${key}-fijo`} label="No se negocia" />}</form.AppField>
                    </div>
                  )
                })}
                {group.keys.includes("informa")
                  ? numberField(
                      "informMessages",
                      "plan-inform-messages",
                      "Mensajes por Informa",
                      "Mensajes de la persona que cubre cada Informa en su ventana. Por ahora solo se mide en Costo y margen: nadie lo paga. Vacío: sin tope.",
                      "numeric",
                    )
                  : null}
                {group.keys.includes("preguntas") ? (
                  <>
                    {numberField("included", "plan-included", "Preguntas incluidas al mes", undefined, "numeric")}
                    {numberField("packQuestions", "plan-pack", "Preguntas por paquete", undefined, "numeric")}
                  </>
                ) : null}
                {group.keys.includes("almacenamiento") ? numberField("includedGb", "plan-gb", "GB incluidos", undefined, "numeric") : null}
              </div>
            </FieldSet>
          ))}
        </FieldSet>

        <FieldSet>
          <FieldLegend>Quién puede negociar</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
            {numberField("sellerDiscount", "plan-seller", "El vendedor, sin pedir aprobación (%)")}
            {numberField("maxDiscount", "plan-max", "La administración, hasta (%)", "Solo en lo que se negocia. La cuota no admite descuento.")}
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Prueba</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
            {numberField("trialCredit", "plan-trial-credit", "Saldo de regalo")}
            {numberField("trialDays", "plan-trial-days", "Días", undefined, "numeric")}
            {numberField("trialMaxCredit", "plan-trial-max-credit", "Saldo máximo con aprobación")}
            {numberField("trialMaxDays", "plan-trial-max-days", "Días máximos con aprobación", undefined, "numeric")}
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Por invitación (Fundadores)</FieldLegend>
          <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
            {numberField(
              "seatLimit",
              "plan-seats",
              "Lugares (clínicas como máximo)",
              "Con lugares, el plan solo se entra con invitación. Vacío: es un plan normal. Bajarlo no saca a nadie.",
              "numeric",
            )}
            {numberField(
              "guaranteeMonths",
              "plan-guarantee",
              "Condiciones garantizadas (meses)",
              `Desde que la clínica entra; después pasa al plan por defecto${notice ? `, con aviso ${notice} días antes` : ""}.`,
              "numeric",
            )}
          </div>
        </FieldSet>

        <FieldGroup>
          <form.AppField name="showOnWeb">
            {(field) => (
              <field.CheckboxField
                id="plan-web"
                label={`Mostrar en ${domainOf(product)}`}
                description={`Sus precios salen en la web de ${words.name}. Apagado al crear un plan; al guardar, la web lo muestra en menos de un minuto.`}
              />
            )}
          </form.AppField>
          <form.AppField name="isDefault">
            {(field) => (
              <field.CheckboxField
                id="plan-default"
                label={`Plan por defecto de ${words.name}`}
                description={`Con él abren, prueban y se cuentan las clínicas de ${words.name} que no eligen otro. El de ${productWords(product === "dental" ? "medical" : "dental").name} no cambia.`}
              />
            )}
          </form.AppField>
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
