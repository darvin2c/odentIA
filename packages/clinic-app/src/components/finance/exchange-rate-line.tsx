/**
 * «Tipo de cambio de hoy: S/ 3.75 por USD 1 · Cambiar»: a la vista de quien cobra, con su
 * misma operación (`saveExchangeRate`). Es la propuesta para los cobros que vienen:
 * cada cobro guarda el suyo. Sin otra moneda no existe.
 */
import {
  exchangeRateWords,
  formatExchangeRateInput,
  parseExchangeRate,
  readExchangeRate,
} from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { usePermission } from "../../lib/crm"
import { financeFormMessage } from "../../lib/finance"
import { rateAuthorWords } from "../../lib/finance-collect"
import { saveExchangeRate, useOrgSecondCurrency } from "../../lib/org"
import { RateField } from "./rate-input"

export function ExchangeRateLine({
  business,
  locale,
  timeZone,
}: {
  business: string
  locale: string
  timeZone: string
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const second = useOrgSecondCurrency()
  const canCollect = usePermission("finance.write")
  const canConfigure = usePermission("settings.write")
  const [open, setOpen] = useState(false)

  const save = useMutation({
    mutationFn: (rate: string) => saveExchangeRate(rate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-profile"] })
      void queryClient.invalidateQueries({ queryKey: ["org-finance-profile"] })
      toast.success("Tipo de cambio de hoy actualizado")
      setOpen(false)
    },
  })
  const form = useAppForm({
    defaultValues: { rate: "" },
    validators: {
      onSubmit: ({ value }) => {
        const { error } = readExchangeRate(value.rate, locale)
        return error ? { fields: { rate: error } } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(parseExchangeRate(value.rate, locale))
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { exchangeRate: "rate" },
    formMessage: financeFormMessage,
  })

  const rate = second?.rate ?? ""
  useEffect(() => {
    if (open && rate) form.reset({ rate: formatExchangeRateInput(rate, locale) })
  }, [open, rate, locale, form])

  if (!second) return null
  const author = rateAuthorWords(second, locale, timeZone)
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Tipo de cambio de hoy: {exchangeRateWords(second.rate, business, second.currency, locale)}
        {author ? `, ${author}` : ""}
        {canCollect || canConfigure ? (
          <>
            {" · "}
            <Button
              variant="link"
              className="h-auto p-0 align-baseline"
              onClick={() => setOpen(true)}
            >
              Cambiar
            </Button>
          </>
        ) : null}
      </p>
      <FormDrawer
        {...surface}
        open={open}
        title="Tipo de cambio de hoy"
        description="Es lo que se propone en los cobros que vienen. Lo ya cobrado no cambia: cada cobro guarda el suyo."
        submitLabel="Guardar"
        onClose={() => {
          if (!surface.isSubmitting) setOpen(false)
        }}
      >
        <form.AppField name="rate">
          {() => <RateField business={business} other={second.currency} locale={locale} />}
        </form.AppField>
      </FormDrawer>
    </>
  )
}
