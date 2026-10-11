import { FieldLabel, Input, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import { errorMessage } from "./shared"

/** Alta de un sillón de la sede: sin al menos uno no se puede reservar. */
export function ChairForm({
  branchId,
  branchName,
  suggestedName,
  onClose,
  onSaved,
}: {
  branchId: string
  branchName: string
  /** Nombre propuesto («Sillón 2»), para no empezar de cero. */
  suggestedName: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = React.useState(suggestedName)
  const [error, setError] = React.useState("")
  const save = useMutation({
    mutationFn: () =>
      apiFetch("/api/agenda/chairs", {
        method: "POST",
        body: JSON.stringify({ branchId, name: name.trim() }),
      }),
    onSuccess: async () => {
      toast.success("Sillón añadido")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title="Nuevo sillón"
      description={`Se añade a ${branchName}. Cada cita ocupa un sillón.`}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={name !== suggestedName}
      error={error || null}
      submitDisabled={!name.trim()}
      submitLabel="Añadir sillón"
    >
      <div className="grid gap-2">
        <FieldLabel htmlFor="sillon-nombre">Nombre</FieldLabel>
        <Input
          id="sillon-nombre"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
    </FormDrawer>
  )
}
