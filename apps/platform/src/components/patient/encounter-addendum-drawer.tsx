import { Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"

const MAX_LENGTH = 4000

/**
 * Corrección inmutable sobre una atención finalizada (POST {text}, máx. 4000).
 * Vista de lectura con botón propio: la adenda se añade (append-only) en un
 * FormDrawer hermano, nunca se edita el contenido original.
 */
export function EncounterAddendumDrawer({
  patientId,
  encounterId,
  onSaved,
}: {
  patientId: string
  encounterId: string
  onSaved?: () => void
}) {
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/encounters/${encounterId}/addenda`, {
        method: "POST",
        body: JSON.stringify({ text: text.trim() }),
      }),
    onSuccess: () => {
      setText("")
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] })
      void queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      onSaved?.()
    },
  })

  if (!canWrite) return null

  const handleClose = () => {
    // Durante el guardado no se cierra: el error y el texto se conservan.
    if (save.isPending) return
    setText("")
    save.reset()
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          save.reset()
          setOpen(true)
        }}
      >
        Agregar corrección
      </Button>
      <FormDrawer
        open={open}
        onClose={handleClose}
        title="Agregar corrección (adenda)"
        description="Corrección posterior al cierre. Las adendas son inmutables: no se pueden editar ni eliminar."
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (text.trim() && !save.isPending) save.mutate()
        }}
        isDirty={text.trim() !== ""}
        isSubmitting={save.isPending}
        submitDisabled={!text.trim()}
        submitLabel={save.isPending ? "Guardando…" : "Guardar corrección"}
        error={save.isError ? save.error.message : null}
      >
        <Field>
          <FieldLabel htmlFor={id}>Corrección</FieldLabel>
          <Textarea
            id={id}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_LENGTH}
            rows={4}
            required
            disabled={save.isPending}
            placeholder="Corrección posterior al cierre…"
          />
          <p className="text-xs text-muted-foreground">
            {text.length}/{MAX_LENGTH} · Las adendas son inmutables: no se pueden editar ni
            eliminar.
          </p>
        </Field>
      </FormDrawer>
    </>
  )
}
