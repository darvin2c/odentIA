import { FieldLabel, Input, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import { errorMessage } from "./shared"

/**
 * El formulario de una unidad dental, el mismo en la agenda y en Configuración: da de
 * alta una en la sede (sin al menos una no se puede reservar) o, con `chair`,
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
  /** Nombre propuesto («Unidad dental 2»), para no empezar de cero. */
  suggestedName: string
  /** La unidad dental que se renombra; sin ella, el formulario crea una nueva. */
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
      toast.success(chair ? "Unidad dental guardada" : "Unidad dental añadida")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title={chair ? `Renombrar ${chair.name}` : "Nueva unidad dental"}
      description={
        chair
          ? `Unidad dental de ${branchName}. Sus citas se verán con el nombre nuevo.`
          : `Se añade a ${branchName}. Cada cita ocupa una unidad dental.`
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
      submitLabel={chair ? "Guardar" : "Añadir unidad dental"}
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
