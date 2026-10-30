/** Confirmación de una anulación en Finanzas: siempre en cajón y siempre con motivo. */
import { Field, FieldLabel, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useEffect, useId, useState } from "react"

export function VoidDrawer({
  open,
  title,
  description,
  isSubmitting,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  isSubmitting: boolean
  error: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const fieldId = useId()
  const [reason, setReason] = useState("")
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!open) return
    setReason("")
    setMissing(false)
  }, [open])

  return (
    <FormDrawer
      dock={false}
      open={open}
      title={title}
      description={description}
      error={missing ? "Escribe el motivo de la anulación." : error}
      isSubmitting={isSubmitting}
      isDirty={reason !== ""}
      submitLabel="Anular"
      cancelLabel="No anular"
      onClose={() => {
        if (!isSubmitting) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setMissing(true)
          return
        }
        setMissing(false)
        onConfirm(reason.trim())
      }}
    >
      <Field>
        <FieldLabel htmlFor={fieldId}>Motivo</FieldLabel>
        <Textarea
          id={fieldId}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </FormDrawer>
  )
}
