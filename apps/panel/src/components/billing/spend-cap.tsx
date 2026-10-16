/**
 * Cambiar el tope de gasto (ADR 0030, tablero C5): cuánto como mucho al mes
 * por encima del crédito, con lo que se usará a este ritmo y lo que pasa al
 * llegar, dicho antes de guardar.
 */
import { Input, Label } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useEffect, useState } from "react"
import { centsToMajor, formatPlanMoney, majorToCents } from "./money"

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
      setError("No se pudo guardar el tope. Reintenta en un momento.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Tope de gasto en agentes"
      description="Es lo máximo que pagarás al mes por encima de tu crédito."
      onSubmit={submit}
      isDirty={text !== (currentCents === null ? "" : centsToMajor(currentCents, currency))}
      isSubmitting={saving}
      error={error}
      submitLabel="Guardar tope"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="spend-cap">Tope mensual ({currency}, sin impuestos)</Label>
        <Input id="spend-cap" inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} placeholder="Sin tope" />
        {projectedOverCents !== null ? (
          <p className="text-xs text-muted-foreground">A este ritmo pasarás tu crédito en unos {money(projectedOverCents)} este mes.</p>
        ) : null}
      </div>
      <div className="rounded-lg border p-3 text-sm">
        <p className="font-medium">Cuando llegue al tope</p>
        <p className="mt-1 text-muted-foreground">
          Recepción deja de atender casos nuevos y se los pasa a tu equipo con un mensaje fijo. Nadie se queda sin respuesta. El dictado y las citas en
          curso siguen.
        </p>
      </div>
      {cents !== null && cents > 0 ? (
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Te avisaremos</p>
          <p className="mt-1 text-muted-foreground">
            Al llegar a {money(Math.round(cents * 0.75))} (75 %) y a {money(Math.round(cents * 0.9))} (90 %), en la plataforma y por correo.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Déjalo vacío si no quieres tope: los agentes siguen atendiendo y cada acción se cobra con tu precio.</p>
      )}
    </FormDrawer>
  )
}
