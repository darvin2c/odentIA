import { toast } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
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
  const word = appWords().room
  const save = useMutation({
    mutationFn: (name: string) =>
      room
        ? apiFetch(`/api/agenda/rooms/${room.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          })
        : apiFetch("/api/agenda/rooms", {
            method: "POST",
            body: JSON.stringify({ branchId, name }),
          }),
  })
  const form = useAppForm({
    defaultValues: { name: room?.name ?? suggestedName },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, `Escribe el nombre de la ${word.one}.`)
          .max(120, "Escribe el nombre en 120 caracteres como mucho."),
      }),
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      // Renombrar con el mismo nombre no cambia nada: se cierra sin llamar al servidor.
      if (room && name === room.name) {
        onClose()
        return
      }
      await save.mutateAsync(name)
      toast.success(`${upperFirst(word.one)} ${room ? "guardada" : "añadida"}`)
      await onSaved()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title={room ? `Renombrar ${room.name}` : `Nueva ${word.one}`}
      description={
        room
          ? `${upperFirst(word.one)} de ${branchName}. Sus citas se verán con el nombre nuevo.`
          : `Se añade a ${branchName}. Cada cita ocupa una ${word.one}.`
      }
      onClose={onClose}
      submitLabel={room ? "Guardar" : `Añadir ${word.one}`}
    >
      <form.AppField name="name">
        {(field) => <field.TextField label="Nombre" id="sillon-nombre" maxLength={120} />}
      </form.AppField>
    </FormDrawer>
  )
}
