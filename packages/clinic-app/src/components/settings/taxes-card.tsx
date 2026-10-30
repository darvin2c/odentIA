/**
 * «Impuestos» en Datos de la clínica (ADR 0083, tablero 1 del lienzo). Cerrada
 * es una frase con lo que vale; «Cambiar» abre las dos cifras (atenciones y
 * productos), cada una de la lista de su país o «Otra tasa…». México llega
 * abierta con la pregunta de cómo está constituida la clínica. Se guarda con el
 * mismo «Guardar» del formulario; lo que es igual a lo del país no se guarda.
 */
import {
  currencyFractionDigits,
  defaultTaxRates,
  formatMoney,
  includedTaxCents,
  MAX_CUSTOM_TAX_BPS,
  resolveOrgTaxes,
  type TaxCategory,
  taxLegalFormOf,
  type TaxRate,
  taxProfileFor,
  type TaxScope,
} from "@odentia/clinical"
import { Button, InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@odentia/ui"
import { withFieldGroup } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useEffect, useState } from "react"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceSelect } from "../ui/choice-select"
import type { OrgProfile, OrgTaxesInput } from "../../lib/org"
import { appWords, upperFirst } from "../../lib/product-words"

/** Lo que vive en el formulario: "" es «lo del país»; «otra» lleva su porcentaje escrito. */
export interface TaxFormValues {
  taxLegalForm: string
  servicesTax: string
  servicesOther: string
  productsTax: string
  productsOther: string
}

export const OTHER_TAX = "otra"

export const emptyTaxValues: TaxFormValues = {
  taxLegalForm: "",
  servicesTax: "",
  servicesOther: "",
  productsTax: "",
  productsOther: "",
}

function choiceOf(country: string, rate: TaxRate | null): { key: string; other: string } {
  if (!rate) return { key: "", other: "" }
  const known = taxProfileFor(country)?.choices.find((item) => item.category === rate.category && item.rateBps === rate.rateBps)
  if (known) return { key: known.key, other: "" }
  return { key: OTHER_TAX, other: String(rate.rateBps / 100) }
}

/** Lo guardado, como lo pinta el formulario. */
export function taxValuesFromProfile(profile: OrgProfile): TaxFormValues {
  const rate = (category: string | null | undefined, bps: number | null | undefined): TaxRate | null =>
    category && bps != null ? { category: category as TaxCategory, rateBps: bps } : null
  const services = choiceOf(profile.countryCode, rate(profile.servicesTaxCategory, profile.servicesTaxBps))
  const products = choiceOf(profile.countryCode, rate(profile.productsTaxCategory, profile.productsTaxBps))
  return {
    taxLegalForm: profile.taxLegalForm ?? "",
    servicesTax: services.key,
    servicesOther: services.other,
    productsTax: products.key,
    productsOther: products.other,
  }
}

/** «12,5» o «12.5» → 1250; null si no es un porcentaje válido. */
export function parsePercentBps(text: string): number | null {
  const clean = text.trim().replace(",", ".").replace(/\s*%$/, "")
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(clean)) return null
  const bps = Math.round(Number(clean) * 100)
  return bps >= 1 && bps <= MAX_CUSTOM_TAX_BPS ? bps : null
}

/** El error de «Otra tasa…», o null si está bien. */
export function otherTaxError(choice: string, text: string): string | null {
  if (choice !== OTHER_TAX) return null
  return parsePercentBps(text) === null ? `Escribe la tasa: de 0,01 a ${MAX_CUSTOM_TAX_BPS / 100}` : null
}

function rateFrom(country: string, choice: string, other: string): TaxRate | null {
  if (!choice) return null
  if (choice === OTHER_TAX) {
    const bps = parsePercentBps(other)
    return bps === null ? null : { category: "S", rateBps: bps }
  }
  const known = taxProfileFor(country)?.choices.find((item) => item.key === choice)
  return known ? { category: known.category, rateBps: known.rateBps } : null
}

/**
 * Lo que viaja al guardar; el servidor deja nulo lo que es igual a lo del país.
 * Si el país pregunta la forma de la clínica, guardar confirma la que se ve
 * elegida (la primera, si nadie tocó la pregunta).
 */
export function taxesInputFrom(country: string, values: TaxFormValues): OrgTaxesInput {
  const profile = taxProfileFor(country)
  return {
    legalForm: values.taxLegalForm || (profile ? (taxLegalFormOf(profile, null)?.key ?? null) : null),
    servicios: rateFrom(country, values.servicesTax, values.servicesOther),
    productos: rateFrom(country, values.productsTax, values.productsOther),
  }
}

/** Un ejemplo con números: «una limpieza de S/ 118.00 es S/ 100.00 más IGV S/ 18.00». */
function exampleLine(rate: TaxRate, name: string, what: string, currency: string, locale: string): string | null {
  if (rate.category !== "S" || !currency) return null
  try {
    const base = 100 * 10 ** currencyFractionDigits(currency)
    const total = base + Math.round((base * rate.rateBps) / 10_000)
    const tax = includedTaxCents(total, rate.rateBps)
    const money = (cents: number) => formatMoney(cents, currency, locale)
    return `${what} de ${money(total)} es ${money(total - tax)} más ${name} ${money(tax)}.`
  } catch {
    return null
  }
}

/** Los datos de la tarjeta, por su nombre en el formulario: un error en cualquiera la abre. */
const TAX_FIELD_NAMES = ["taxLegalForm", "servicesTax", "servicesOther", "productsTax", "productsOther"] as const

/**
 * La tarjeta pinta sus datos dentro del formulario de «Datos de la clínica»
 * (`<TaxesCard form={form} fields={…} />`): cada impuesto con su campo, su
 * etiqueta y su error, leído del estado del formulario. Si alguno tiene un
 * error, la tarjeta se abre sola para que se vea y el foco llegue a él.
 */
export const TaxesCard = withFieldGroup({
  defaultValues: emptyTaxValues,
  props: {
    country: "",
    /** «Perú». */
    countryLabel: "",
    currency: "",
    locale: "",
    cardClassName: "",
  },
  render: function TaxesCardRender({ group, country, countryLabel, currency, locale, cardClassName }) {
    const profile = taxProfileFor(country)
    const [open, setOpen] = useState(false)
    const values = useStore(group.store, (state) => state.values)
    const hasError = useStore(group.form.store, (state) => {
      const meta = state.fieldMeta as unknown as Record<string, { errors?: readonly unknown[] } | undefined>
      return TAX_FIELD_NAMES.some((name) => (meta[String(group.getFormFieldName(name))]?.errors?.length ?? 0) > 0)
    })
    // Abierta por un error, sigue abierta al corregirlo: no se cierra mientras se escribe.
    useEffect(() => {
      if (hasError) setOpen(true)
    }, [hasError])
    if (country.length !== 2) return null
    if (!profile) {
      return (
        <section aria-labelledby="org-taxes" className={cardClassName}>
          <h2 id="org-taxes" className="font-heading text-base font-medium">
            Impuestos
          </h2>
          <p className="text-sm text-muted-foreground">
            {appWords().name} aún no separa el impuesto de {countryLabel}: lo cobrado se muestra completo. Si lo necesitas, pídelo desde Ayuda.
          </p>
        </section>
      )
    }
    const input = taxesInputFrom(country, values)
    const taxes = resolveOrgTaxes(country, input, locale)
    if (!taxes) return null
    const defaults = defaultTaxRates(profile, input.legalForm)
    const pendingForm = Boolean(profile.legalForms?.length) && !values.taxLegalForm
    const expanded = open || pendingForm || hasError
    const changed = !taxes.servicios.isDefault || !taxes.productos.isDefault
    const sameRate =
      taxes.servicios.category === taxes.productos.category && taxes.servicios.rateBps === taxes.productos.rateBps
    const example =
      exampleLine(taxes.servicios, taxes.name, upperFirst(appWords().examples.service), currency, locale) ??
      exampleLine(taxes.productos, taxes.name, upperFirst(appWords().examples.soldItem), currency, locale)
    const setTaxes = (next: Partial<TaxFormValues>) => {
      for (const [key, value] of Object.entries(next) as [keyof TaxFormValues, string][]) group.setFieldValue(key, value)
    }
    const backToCountry = () => setTaxes({ servicesTax: "", servicesOther: "", productsTax: "", productsOther: "" })
    const legalForm = taxLegalFormOf(profile, values.taxLegalForm)

    const select = (scope: TaxScope) => {
      const services = scope === "servicios"
      const choice = services ? values.servicesTax : values.productsTax
      const fallback = defaults[scope]
      const current = choice || fallback.key
      const id = `org-tax-${scope}`
      return (
        <group.AppField name={services ? "servicesTax" : "productsTax"}>
          {(field) => (
            <field.Control
              id={id}
              label={services ? "Atenciones" : "Productos"}
              description={services ? "Consultas, tratamientos y adelantos." : `Lo que se vende desde Cobrar: ${appWords().examples.soldItems}.`}
            >
              {(control) => (
                <>
                  <ChoiceSelect
                    id={control.id}
                    name={control.name}
                    value={current}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(event) => {
                      const next = event.target.value
                      // Elegir lo del país es volver a él: no se guarda nada.
                      field.handleChange(next === fallback.key ? "" : next)
                    }}
                  >
                    {profile.choices.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.key === fallback.key ? `${item.label} · Lo de ${countryLabel}` : item.note ? `${item.label} · ${item.note}` : item.label}
                      </option>
                    ))}
                    <option value={OTHER_TAX}>Otra tasa…</option>
                  </ChoiceSelect>
                  {choice === OTHER_TAX ? (
                    <group.AppField name={services ? "servicesOther" : "productsOther"}>
                      {(other) => (
                        <other.Control id={`${id}-otra`} label={`Tasa de ${services ? "las atenciones" : "los productos"}`} hideLabel>
                          {(rate) => (
                            <InputGroup className="max-w-40">
                              <InputGroupInput
                                {...rate.props}
                                inputMode="decimal"
                                value={other.state.value}
                                onChange={(event) => other.handleChange(event.target.value)}
                              />
                              <InputGroupAddon align="inline-end">
                                <InputGroupText>%</InputGroupText>
                              </InputGroupAddon>
                            </InputGroup>
                          )}
                        </other.Control>
                      )}
                    </group.AppField>
                  ) : null}
                </>
              )}
            </field.Control>
          )}
        </group.AppField>
      )
    }

    return (
      <section aria-labelledby="org-taxes" className={cardClassName}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
            <h2 id="org-taxes" className="font-heading text-base font-medium">
              Impuestos
            </h2>
            <p className="text-[15px]">
              {sameRate ? (
                <>
                  <strong>{taxes.servicios.label}</strong> en todo lo que cobras
                  {taxes.servicios.category === "S" ? ", ya incluido en tus precios." : "."}
                </>
              ) : (
                <>
                  Atenciones: <strong>{taxes.servicios.label}</strong>. Productos: <strong>{taxes.productos.label}</strong>. El
                  impuesto va incluido en tus precios.
                </>
              )}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {changed ? (
                <>
                  Cambiado por la clínica · Lo de {countryLabel}:{" "}
                  {defaults.servicios.key === defaults.productos.key
                    ? defaults.servicios.label
                    : `${defaults.servicios.label} en atenciones y ${defaults.productos.label} en productos`}{" "}
                  ·{" "}
                  <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={backToCountry}>
                    Volver a lo de {countryLabel}
                  </button>
                </>
              ) : (
                <>
                  {legalForm ? `${legalForm.label}: es lo de ${countryLabel}.` : `Es lo de ${countryLabel}.`} El ticket y Reportes lo separan solos.
                </>
              )}
            </p>
          </div>
          {!expanded ? (
            <Button type="button" variant="secondary" aria-expanded={false} onClick={() => setOpen(true)}>
              Cambiar
            </Button>
          ) : null}
        </div>
        {example ? <p className="rounded-lg bg-muted px-3 py-2.5 text-sm">Ejemplo: {lowerFirst(example)} Ningún precio cambia.</p> : null}
        {expanded ? (
          <div className="flex flex-col gap-4 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Cámbialo solo si tu contador te lo indica. Vale para los cobros desde que guardas; lo ya cobrado no cambia.
            </p>
            {profile.legalForms?.length ? (
              <group.AppField name="taxLegalForm">
                {(field) => (
                  <field.Group
                    id="org-tax-form"
                    legend="¿Cómo está constituida la clínica?"
                    description={`${profile.legalFormHelp ?? ""}${pendingForm ? " Confírmalo con «Guardar»." : ""}`}
                  >
                    {(control) => (
                      <ChoiceButtons
                        id={control.id}
                        tone="primary"
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        value={legalForm?.key ?? null}
                        options={(profile.legalForms ?? []).map((item) => ({ value: item.key, label: item.label }))}
                        onChange={(next) => setTaxes({ taxLegalForm: next, servicesTax: "", servicesOther: "", productsTax: "", productsOther: "" })}
                      />
                    )}
                  </field.Group>
                )}
              </group.AppField>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {select("servicios")}
              {select("productos")}
            </div>
            {open && !pendingForm && !hasError ? (
              <div>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cerrar
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    )
  },
})

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

