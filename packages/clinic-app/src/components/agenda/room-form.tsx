import { FieldLabel, Input, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import { errorMessage } from "./shared"
import { appWords, upperFirst } from "../../lib/product-words"

/**
 * El formulario de una unidad dental, el mismo en la agenda y en Configuración: da de
 * alta una en la sede (sin al menos una no se puede reservar) o, con `room`,
 * le cambia el nombre.
 */
export function RoomForm({
  branchId,
  branchName,
  suggestedName,
  room,
  onClose,
  onSaved,
}: {
  branchId: string
  branchName: string
  /** Nombre propuesto («Unidad dental 2»), para no empezar de cero. */
  suggestedName: string
  /** La unidad dental que se renombra; sin ella, el formulario crea una nueva. */
  room?: { id: string; name: string }
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const initialName = room?.name ?? suggestedName
  const word = appWords().room
  const [name, setName] = React.useState(initialName)
  const [error, setError] = React.useState("")
  const save = useMutation({
    mutationFn: () =>
      room
        ? apiFetch(`/api/agenda/rooms/${room.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: name.trim() }),
          })
        : apiFetch("/api/agenda/rooms", {
            method: "POST",
            body: JSON.stringify({ branchId, name: name.trim() }),
          }),
    onSuccess: async () => {
      toast.success(`${upperFirst(word.one)} ${room ? "guardada" : "añadida"}`)
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title={room ? `Renombrar ${room.name}` : `Nueva ${word.one}`}
      description={
        room
          ? `${upperFirst(word.one)} de ${branchName}. Sus citas se verán con el nombre nuevo.`
          : `Se añade a ${branchName}. Cada cita ocupa una ${word.one}.`
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
      submitDisabled={!name.trim() || (room !== undefined && name.trim() === room.name)}
      submitLabel={room ? "Guardar" : `Añadir ${word.one}`}
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
