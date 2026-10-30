/**
 * Cambiar el presupuesto del mes (ADR 0031 y 0085): cuánto como mucho al mes
 * por encima del crédito, con lo que se usará a este ritmo y lo que pasa al
 * llegar, dicho antes de guardar. Es el único límite de los agentes. Desde la
 * franja de avisos se abre igual, con «+10» y «+25» para subirlo sin hacer la
 * cuenta (ADR 0065).
 */
import { Button } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useEffect } from "react"
import { z } from "zod"
import { centsToMajor, formatPlanMoney, majorToCents, readMajor } from "./money"
import { useReceptionName } from "../../lib/agent-names"
import { useSaasTerms } from "../../lib/billing"

/** El servidor nombra el presupuesto por lo que guarda (`capCents`); la pantalla, por lo que se escribe. */
const CAP_FIELD_MAP = { capCents: "cap" }

export function SpendCapDrawer({
  open,
  currency,
  currentCents,
  projectedOverCents,
  onClose,
  onSave,
}: {
  open: boolean
  currency: string
  currentCents: number | null
  /** A este ritmo, cuánto pasará del crédito al cierre. */
  projectedOverCents: number | null
  onClose: () => void
  onSave: (capCents: number | null) => Promise<void>
}) {
  const receptionName = useReceptionName()
  const terms = useSaasTerms().data
  const saved = currentCents === null ? "" : centsToMajor(currentCents, currency)
  const form = useAppForm({
    defaultValues: { cap: saved },
    validators: {
      // Vacío quita el presupuesto; lo escrito tiene que ser un importe.
      onSubmit: z.object({
        cap: z.string().superRefine((value, ctx) => {
          if (!value.trim()) return
          const reading = readMajor(value, currency)
          if (!reading.ok) ctx.addIssue({ code: "custom", message: reading.error })
        }),
      }),
    },
    onSubmit: async ({ value }) => {
      await onSave(value.cap.trim() ? majorToCents(value.cap, currency) : null)
      onClose()
    },
  })
  // Al abrir, lo guardado: el borrador anterior no se arrastra.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir; lo guardado que llegue después no pisa lo que se escribe.
  useEffect(() => {
    if (open) form.reset({ cap: saved })
  }, [open])
  const surface = useFormSurface(form, { fieldMap: CAP_FIELD_MAP })
  const text = useStore(form.store, (state) => state.values.cap)
  const cents = text.trim() ? majorToCents(text, currency) : null
  const money = (value: number) => formatPlanMoney(value, currency)
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title="Presupuesto del mes"
      description="Lo que tus agentes pueden gastar al mes por encima de tu crédito. Al llegar no empiezan trabajo nuevo con cobro; lo que ya empezó se termina y se cobra. El almacenamiento va aparte."
      submitLabel="Guardar presupuesto"
    >
      <div className="flex flex-col gap-2">
        <form.AppField name="cap">
          {(field) => (
            <field.TextField
              id="spend-cap"
              label={`Presupuesto mensual (${currency}, sin impuestos)`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="Sin presupuesto"
            />
          )}
        </form.AppField>
        {currentCents !== null ? (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Subir el presupuesto</legend>
            {[1_000, 2_500].map((step) => (
              <Button
                key={step}
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => form.setFieldValue("cap", centsToMajor((cents ?? currentCents) + step, currency))}
              >
                +{money(step)}
              </Button>
            ))}
          </fieldset>
        ) : null}
        {projectedOverCents !== null ? (
          <p className="text-xs text-muted-foreground">A este ritmo pasarás tu crédito en unos {money(projectedOverCents)} este mes.</p>
        ) : null}
      </div>
      <div className="rounded-lg border p-3 text-sm">
        <p className="font-medium">Cuando llegue al presupuesto</p>
        <p className="mt-1 text-muted-foreground">
          {receptionName} pasa todo a tu equipo con un mensaje fijo: nadie se queda sin respuesta. Clío no escucha en las atenciones nuevas y Argos no
          escribe para recuperar ni suma preguntas. Lo que ya empezó se termina y se cobra.
        </p>
      </div>
      {cents !== null && cents > 0 && terms ? (
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Te avisaremos</p>
          <p className="mt-1 text-muted-foreground">
            Al llegar a {money(Math.round((cents * terms.warnPercent) / 100))} ({terms.warnPercent} %), en la clínica; a{" "}
            {money(Math.round((cents * terms.alarmPercent) / 100))} ({terms.alarmPercent} %), también por correo.
          </p>
        </div>
      ) : cents !== null && cents > 0 ? null : (
        <p className="text-xs text-muted-foreground">Déjalo vacío si no quieres presupuesto: los agentes siguen atendiendo y cada acción se cobra con tu precio.</p>
      )}
    </FormDrawer>
  )
}
