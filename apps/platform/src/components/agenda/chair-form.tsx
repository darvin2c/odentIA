import { FieldLabel, Input, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import { errorMessage } from "./shared"

/**
 * El formulario de un sillón, el mismo en la agenda y en Configuración: da de
 * alta uno en la sede (sin al menos uno no se puede reservar) o, con `chair`,
 * le cambia el nombre.
 */
export function ChairForm({
  branchId,
  branchName,
  suggestedName,
  chair,
  onClose,
  onSaved,
}: {
  branchId: string
  branchName: string
  /** Nombre propuesto («Sillón 2»), para no empezar de cero. */
  suggestedName: string
  /** El sillón que se renombra; sin él, el formulario crea uno nuevo. */
  chair?: { id: string; name: string }
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const initialName = chair?.name ?? suggestedName
  const [name, setName] = React.useState(initialName)
  const [error, setError] = React.useState("")
  const save = useMutation({
    mutationFn: () =>
      chair
        ? apiFetch(`/api/agenda/chairs/${chair.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: name.trim() }),
          })
        : apiFetch("/api/agenda/chairs", {
            method: "POST",
            body: JSON.stringify({ branchId, name: name.trim() }),
          }),
    onSuccess: async () => {
      toast.success(chair ? "Sillón guardado" : "Sillón añadido")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title={chair ? `Renombrar ${chair.name}` : "Nuevo sillón"}
      description={
        chair
          ? `Sillón de ${branchName}. Sus citas se verán con el nombre nuevo.`
          : `Se añade a ${branchName}. Cada cita ocupa un sillón.`
      }
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={name !== initialName}
      error={error || null}
      submitDisabled={!name.trim() || (chair !== undefined && name.trim() === chair.name)}
      submitLabel={chair ? "Guardar" : "Añadir sillón"}
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
