/**
 * Lo de otra moneda en los formularios de un gasto: lo que salió, el cambio, cuánto
 * vale y el aviso si el cambio es muy distinto del de hoy. Solo con segunda moneda.
 */
import { formatMoney } from "@odentia/clinical"
import { FormField, useFieldContext } from "@odentia/ui-patterns"
import { type ExpenseMoney, expenseRateWords } from "../../lib/expense-exchange"
import type { OrgSecondCurrency } from "../../lib/org"
import { MoneyInput } from "../inventory/fields"
import { RateFarNote, RateField } from "./rate-input"

function TenderField({ currency }: { currency: string }): React.JSX.Element {
  const field = useFieldContext<string>()
  return (
    <FormField
      label="Lo que salió"
      description="Escríbelo como sale en tu extracto. El cambio se calcula solo."
    >
      {(control) => (
        <MoneyInput
          id={control.id}
          currency={currency}
          value={field.state.value}
          invalid={control.invalid}
          aria-describedby={control.describedBy}
          onChange={(next) => field.handleChange(next)}
        />
      )}
    </FormField>
  )
}

export function ExpenseMoneyFields({
  second,
  money,
  currency,
  business,
  locale,
  crosses = true,
  reportWords,
  field,
}: {
  second: OrgSecondCurrency
  money: ExpenseMoney
  /** La moneda de lo que cancela. */
  currency: string
  business: string
  locale: string
  /** Solo pagar una compra puede salir en otra moneda. */
  crosses?: boolean
  /** Cómo se dice lo que cuenta en los reportes. */
  reportWords: (value: string) => string
  /** Une el campo a su dato del formulario: `form.AppField`. */
  field: (name: "tender" | "rate", control: React.JSX.Element) => React.ReactNode
}): React.JSX.Element {
  const { frozen } = money
  return (
    <>
      {money.crossed && crosses ? field("tender", <TenderField currency={money.payIn} />) : null}
      {money.needsRate
        ? field(
            "rate",
            <RateField
              description="No cambia lo que pagas: es para saber cuánto vale en tus reportes."
              business={business}
              other={second.currency}
              locale={locale}
            />,
          )
        : null}
      {frozen ? (
        <>
          <p role="status" className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            {money.crossed
              ? `Tipo de cambio: ${expenseRateWords({ exchangeRate: frozen.exchangeRate, currency, tenderCurrency: money.payIn }, business, locale)}. `
              : ""}
            {reportWords(formatMoney(frozen.businessCents, business, locale))}
          </p>
          <RateFarNote
            rate={frozen.exchangeRate}
            today={second.rate}
            locale={locale}
            keptIn="guardado"
          />
        </>
      ) : null}
    </>
  )
}
