import { Button, Field, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"

/**
 * Tarea referida al paciente, creada desde su ficha. No exige permiso de CRM:
 * la tarea apunta a la persona atendida, no a una oportunidad.
 */
export function NewPatientTaskButton({ patientId }: { patientId: string }) {
  const canWrite = usePermission("tasks.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [dueDate, setDueDate] = useState("")
  const create = useMutation({
    mutationFn: () =>
      apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          patientId,
          // Fin del día local elegido: una fecha sin hora no vence a medianoche UTC.
          ...(dueDate ? { dueAt: new Date(`${dueDate}T23:59:00`).toISOString() } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["patient-tasks", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["tasks"] })
      setOpen(false)
      setTitle("")
      setDueDate("")
    },
  })
  if (!canWrite) return null
  const close = () => {
    if (create.isPending) return
    setOpen(false)
    create.reset()
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Nueva tarea
      </Button>
      <FormDrawer
        open={open}
        onClose={close}
        title="Nueva tarea"
        description="Queda referida a este paciente y aparece en sus pendientes."
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() && !create.isPending) create.mutate()
        }}
        isSubmitting={create.isPending}
        isDirty={title.trim().length > 0 || dueDate !== ""}
        error={mutationErrorMessage(create.error)}
        submitLabel="Crear tarea"
        submitDisabled={!title.trim() || create.isPending}
      >
        <Field>
          <FieldLabel htmlFor="patient-task-title">Qué hay que hacer</FieldLabel>
          <Input
            id="patient-task-title"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Ej.: llamar para confirmar el laboratorio"
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="patient-task-due">Fecha límite (opcional)</FieldLabel>
          <Input
            id="patient-task-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </>
  )
}
