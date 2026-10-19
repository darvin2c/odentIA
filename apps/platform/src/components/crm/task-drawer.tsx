import { Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { DueAtField, ExpandableText, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type OpportunityDetail,
  type OpportunityListItem,
  TASK_AREA_LABEL,
  type TaskItem,
  useMyUserId,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { type PickedPerson, PersonPicker } from "../person-picker"
import { PersonLink } from "../person-link"
import { ChoiceSelect } from "../ui/choice-select"

/**
 * Contrato compartido con InboxWorkspace. `taskId` abre la tarea para
 * cambiarla (foco `/tasks?task=`); sin él crea una nueva con el contexto que
 * venga fijado (persona, paciente, conversación u oportunidad).
 */
export interface TaskDrawerProps {
  open: boolean
  contactId?: string
  /**
   * La ficha de un paciente, desde su página: la tarea es de su propia persona
   * y no pide permiso de ventas (quien atiende también la crea).
   */
  patientId?: string
  conversationId?: string
  opportunityId?: string
  taskId?: string
  onClose: () => void
  onSaved?: () => void
}

type Area = NonNullable<TaskItem["area"]>
const AREAS = Object.keys(TASK_AREA_LABEL) as Area[]

/** «u:<id>» un miembro, «a:<área>» sin responsable en esa parte del equipo. */
function ownerValue(assignee: string | null, area: string | null): string {
  if (assignee) return `u:${assignee}`
  return `a:${area ?? "recepcion"}`
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.shape.message ?? err.message ?? fallback
  return err instanceof Error ? err.message : fallback
}

/**
 * Una tarea: qué hay que hacer, cuándo vence (en la zona de la clínica), quién
 * la lleva o a qué parte del equipo va, y de quién es. La persona se elige con
 * el buscador de personas y, si tiene oportunidades abiertas, la tarea puede
 * ser la próxima acción de una (una sola tarea abierta por oportunidad).
 */
export function TaskDrawer({ open, contactId, patientId, conversationId, opportunityId, taskId, onClose, onSaved }: TaskDrawerProps) {
  const ids = useId()
  const queryClient = useQueryClient()
  const members = useOrgMembers()
  const myUserId = useMyUserId()
  const canWrite = usePermission("tasks.write")
  const canReadCrm = usePermission("crm.read")
  const isEdit = Boolean(taskId)

  const taskQuery = useQuery({
    queryKey: ["tasks", "detail", taskId],
    queryFn: () => apiFetch<{ data: TaskItem }>(`/api/tasks/${taskId}`),
    enabled: open && !!taskId,
  })
  const editTask = taskQuery.data?.data ?? null
  // La oportunidad fijada: su tarea es de quien la lleva (sin responsable, Recepción).
  const fixedOpportunity = useQuery({
    queryKey: ["opportunity", opportunityId],
    queryFn: () => apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId}`),
    enabled: open && !isEdit && !!opportunityId && canReadCrm,
  })

  const [title, setTitle] = useState("")
  const [dueAt, setDueAt] = useState<string | null>(null)
  const [owner, setOwner] = useState("")
  const [person, setPerson] = useState<PickedPerson | null>(null)
  const [pickedOpportunity, setPickedOpportunity] = useState("")

  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir o al llegar la tarea; después el borrador es de quien escribe
  useEffect(() => {
    if (!open) return
    if (editTask) {
      setTitle(editTask.title)
      setDueAt(editTask.dueAt)
      setOwner(ownerValue(editTask.assigneeUserId, editTask.area))
    } else if (!isEdit) {
      setTitle("")
      setDueAt(null)
      setOwner(opportunityId ? "" : `u:${myUserId}`)
    }
    setPerson(null)
    setPickedOpportunity("")
    save.reset()
  }, [open, editTask?.id])

  // Con la oportunidad cargada, la tarea va a quien la lleva.
  useEffect(() => {
    const opp = fixedOpportunity.data?.data
    if (!open || isEdit || !opp || owner) return
    setOwner(ownerValue(opp.assignedUserId, "recepcion"))
  }, [open, isEdit, fixedOpportunity.data, owner])

  const effectiveContactId = contactId ?? person?.id ?? ""
  const opportunities = useQuery({
    queryKey: ["task-drawer-opportunities", effectiveContactId],
    queryFn: () =>
      apiFetch<{ data: OpportunityListItem[] }>(`/api/opportunities?contactId=${effectiveContactId}&status=open&limit=20`),
    enabled: open && !isEdit && !opportunityId && canReadCrm && effectiveContactId !== "",
  })
  const openOpportunities = opportunities.data?.data ?? []

  const save = useMutation({
    mutationFn: () => {
      if (!title.trim()) throw new Error("Escribe qué hay que hacer.")
      const [kind, value] = owner.split(":") as ["u" | "a" | "", string | undefined]
      const assigneeUserId = kind === "u" ? (value ?? null) : null
      const area = kind === "a" ? ((value as Area | undefined) ?? null) : null
      if (isEdit) {
        if (!editTask) throw new Error("No se pudo cargar la tarea.")
        return apiFetch(`/api/tasks/${editTask.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: title.trim(), dueAt, assigneeUserId, area }),
        })
      }
      const chosenOpportunity = opportunityId ?? (pickedOpportunity || undefined)
      return apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          ...(dueAt ? { dueAt } : {}),
          ...(effectiveContactId ? { contactId: effectiveContactId } : patientId ? { patientId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(chosenOpportunity ? { opportunityId: chosenOpportunity } : {}),
          assigneeUserId,
          ...(area ? { area } : {}),
        }),
      })
    },
    onSuccess: () => {
      for (const key of ["tasks", "opportunity", "pipeline-cards", "pipeline-list", "crm-context", "contact", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      onSaved?.()
      onClose()
    },
  })

  const settled = editTask?.status !== undefined && editTask.status !== "open"
  const readOnly = !canWrite || settled
  const fixedContext = editTask ?? null

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!save.isPending) onClose()
      }}
      title={isEdit ? "Tarea" : "Nueva tarea"}
      description={
        !canWrite
          ? "Sin permiso para cambiar tareas: solo lectura."
          : editTask?.settledReason
            ? `${editTask.status === "cancelled" ? "Descartada" : "Se cerró sola"}: ${editTask.settledReason}.`
            : settled
              ? "Ya está hecha."
              : opportunityId
                ? "Es la próxima acción de la oportunidad: una sola a la vez."
                : patientId && !isEdit
                  ? "Queda referida a este paciente y aparece en sus pendientes."
                  : undefined
      }
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isLoading={isEdit && taskQuery.isPending}
      isDirty={!isEdit && title.trim() !== ""}
      error={
        taskQuery.isError
          ? errorText(taskQuery.error, "No se pudo cargar la tarea.")
          : save.error
            ? errorText(save.error, isEdit ? "No se pudo guardar la tarea." : "No se pudo crear la tarea.")
            : null
      }
      submitLabel={isEdit ? "Guardar" : "Crear"}
      cancelLabel="Cancelar"
      hideSubmit={readOnly || (isEdit && !editTask)}
    >
      <div className="flex flex-col gap-4">
        {fixedContext && (fixedContext.contactName || fixedContext.patientName || fixedContext.opportunityTitle) ? (
          <p className="text-sm">
            <span className="text-muted-foreground">De: </span>
            <PersonLink patientId={fixedContext.patientId} contactId={fixedContext.contactId}>
              {fixedContext.patientName ?? fixedContext.contactName ?? "la persona"}
            </PersonLink>
            {fixedContext.opportunityTitle ? <span className="text-muted-foreground"> · oportunidad «{fixedContext.opportunityTitle}»</span> : null}
          </p>
        ) : null}

        <Field>
          <FieldLabel htmlFor={`${ids}-titulo`}>Qué hay que hacer</FieldLabel>
          <Textarea
            id={`${ids}-titulo`}
            value={title}
            maxLength={200}
            rows={2}
            required
            disabled={readOnly}
            placeholder="Llamar a Jorge para confirmar la evaluación"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {editTask?.reason ? <ExpandableText text={editTask.reason} lines={3} label="contexto de la tarea" className="text-sm text-muted-foreground" /> : null}

        <DueAtField value={dueAt} onChange={setDueAt} disabled={readOnly} />

        <Field>
          <FieldLabel htmlFor={`${ids}-quien`}>Quién la lleva</FieldLabel>
          <ChoiceSelect id={`${ids}-quien`} value={owner} disabled={readOnly} onChange={(event) => setOwner(event.target.value)}>
            {members.map((item) => (
              <option key={item.userId} value={`u:${item.userId}`}>
                {item.userId === myUserId ? `${item.user.name} (yo)` : item.user.name}
              </option>
            ))}
            {AREAS.map((area) => (
              <option key={area} value={`a:${area}`}>
                Sin responsable · {TASK_AREA_LABEL[area]}
              </option>
            ))}
          </ChoiceSelect>
          <FieldDescription>Sin responsable, la ve quien trabaja en esa parte del equipo.</FieldDescription>
        </Field>

        {!isEdit && !contactId && !patientId && !opportunityId && canReadCrm ? (
          <PersonPicker
            label="De quién es (opcional)"
            value={person}
            onChange={(next) => {
              setPerson(next)
              setPickedOpportunity("")
            }}
          />
        ) : null}

        {!isEdit && !opportunityId && openOpportunities.length > 0 ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-oportunidad`}>Es la próxima acción de</FieldLabel>
            <ChoiceSelect
              id={`${ids}-oportunidad`}
              value={pickedOpportunity}
              onChange={(event) => setPickedOpportunity(event.target.value)}
            >
              <option value="">Ninguna oportunidad</option>
              {openOpportunities.map((item) => (
                <option key={item.id} value={item.id} disabled={item.nextTask !== null}>
                  {item.title} · {item.stageName}
                  {item.nextTask ? " · ya tiene su tarea" : ""}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
        ) : null}
      </div>
    </FormDrawer>
  )
}
