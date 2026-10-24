/**
 * Cambiar el presupuesto del mes (ADR 0031 y 0085): cuánto como mucho al mes
 * por encima del crédito, con lo que se usará a este ritmo y lo que pasa al
 * llegar, dicho antes de guardar. Es el único límite de los agentes. Desde la
 * franja de avisos se abre igual, con «+10» y «+25» para subirlo sin hacer la
 * cuenta (ADR 0065).
 */
import { Button, Input, Label } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useEffect, useState } from "react"
import { centsToMajor, formatPlanMoney, majorToCents } from "./money"
import { useReceptionName } from "../../lib/agent-names"
import { useSaasTerms } from "../../lib/billing"

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
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) {
      setText(currentCents === null ? "" : centsToMajor(currentCents, currency))
      setError(null)
    }
  }, [open, currentCents, currency])
  const cents = text.trim() ? majorToCents(text, currency) : null
  const money = (value: number) => formatPlanMoney(value, currency)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (text.trim() && cents === null) {
      setError("Escribe un importe válido, por ejemplo 1000")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(cents)
      onClose()
    } catch {
      setError("No se pudo guardar el presupuesto. Reintenta en un momento.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Presupuesto del mes"
      description="Es lo máximo que pagarás al mes por encima de tu crédito. El almacenamiento no cuenta."
      onSubmit={submit}
      isDirty={text !== (currentCents === null ? "" : centsToMajor(currentCents, currency))}
      isSubmitting={saving}
      error={error}
      submitLabel="Guardar presupuesto"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="spend-cap">Presupuesto mensual ({currency}, sin impuestos)</Label>
        <Input id="spend-cap" inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} placeholder="Sin presupuesto" />
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
                onClick={() => setText(centsToMajor((cents ?? currentCents) + step, currency))}
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
