import { DueAtField, ExpandableText, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
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

interface TaskValues {
  title: string
  dueAt: string | null
  owner: string
  person: PickedPerson | null
  opportunityId: string
}

const taskSchema = z.object({
  title: z.string().trim().min(1, "Escribe qué hay que hacer.").max(200, "Escribe como mucho 200 caracteres."),
  dueAt: z.string().nullable(),
  owner: z.string(),
  person: z.custom<PickedPerson | null>(),
  opportunityId: z.string(),
})

/** El nombre del dato en el cuerpo de la petición → su campo en pantalla. */
const SERVER_FIELDS: Record<string, string> = {
  assigneeUserId: "owner",
  area: "owner",
  contactId: "person",
}

/**
 * Una tarea: qué hay que hacer, cuándo vence (en la zona de la clínica), quién
 * la lleva o a qué parte del equipo va, y de quién es. La persona se elige con
 * el buscador de personas y, si tiene oportunidades abiertas, la tarea puede
 * ser la próxima acción de una (una sola tarea abierta por oportunidad).
 */
export function TaskDrawer({ open, contactId, patientId, conversationId, opportunityId, taskId, onClose, onSaved }: TaskDrawerProps) {
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

  const save = useMutation({
    mutationFn: (input: { path: string; method: "PATCH" | "POST"; body: Record<string, unknown> }) =>
      apiFetch(input.path, { method: input.method, body: JSON.stringify(input.body) }),
  })

  const form = useAppForm({
    defaultValues: { title: "", dueAt: null, owner: "", person: null, opportunityId: "" } as TaskValues,
    validators: { onSubmit: taskSchema },
    onSubmit: async ({ value }) => {
      const [kind, ownerId] = value.owner.split(":") as ["u" | "a" | "", string | undefined]
      const assigneeUserId = kind === "u" ? (ownerId ?? null) : null
      const area = kind === "a" ? ((ownerId as Area | undefined) ?? null) : null
      const title = value.title.trim()
      if (isEdit) {
        if (!editTask) throw new Error("No se pudo cargar la tarea.")
        await save.mutateAsync({
          path: `/api/tasks/${editTask.id}`,
          method: "PATCH",
          body: { title, dueAt: value.dueAt, assigneeUserId, area },
        })
      } else {
        const personId = contactId ?? value.person?.id
        const chosenOpportunity = opportunityId ?? (value.opportunityId || undefined)
        await save.mutateAsync({
          path: "/api/tasks",
          method: "POST",
          body: {
            title,
            ...(value.dueAt ? { dueAt: value.dueAt } : {}),
            ...(personId ? { contactId: personId } : patientId ? { patientId } : {}),
            ...(conversationId ? { conversationId } : {}),
            ...(chosenOpportunity ? { opportunityId: chosenOpportunity } : {}),
            assigneeUserId,
            ...(area ? { area } : {}),
          },
        })
      }
      for (const key of ["tasks", "opportunity", "pipeline-cards", "pipeline-list", "crm-context", "contact", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      onSaved?.()
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: SERVER_FIELDS })

  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir o al llegar la tarea; después el borrador es de quien escribe
  useEffect(() => {
    if (!open) return
    if (editTask) {
      form.reset({ title: editTask.title, dueAt: editTask.dueAt, owner: ownerValue(editTask.assigneeUserId, editTask.area), person: null, opportunityId: "" })
    } else if (!isEdit) {
      form.reset({ title: "", dueAt: null, owner: opportunityId ? "" : `u:${myUserId}`, person: null, opportunityId: "" })
    }
  }, [open, editTask?.id])

  const owner = useStore(form.store, (state) => state.values.owner)
  const person = useStore(form.store, (state) => state.values.person)

  // Con la oportunidad cargada, la tarea va a quien la lleva.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `form` es estable
  useEffect(() => {
    const opp = fixedOpportunity.data?.data
    if (!open || isEdit || !opp || owner) return
    form.setFieldValue("owner", ownerValue(opp.assignedUserId, "recepcion"), { dontUpdateMeta: true })
  }, [open, isEdit, fixedOpportunity.data, owner])

  const effectiveContactId = contactId ?? person?.id ?? ""
  const opportunities = useQuery({
    queryKey: ["task-drawer-opportunities", effectiveContactId],
    queryFn: () =>
      apiFetch<{ data: OpportunityListItem[] }>(`/api/opportunities?contactId=${effectiveContactId}&status=open&limit=20`),
    enabled: open && !isEdit && !opportunityId && canReadCrm && effectiveContactId !== "",
  })
  const openOpportunities = opportunities.data?.data ?? []

  const settled = editTask?.status !== undefined && editTask.status !== "open"
  const readOnly = !canWrite || settled
  const fixedContext = editTask ?? null

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
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
      isLoading={isEdit && taskQuery.isPending}
      isDirty={!isEdit && surface.isDirty}
      error={taskQuery.isError ? "No se pudo cargar la tarea." : surface.error}
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

        <form.AppField name="title">
          {(field) => (
            <field.TextareaField
              label="Qué hay que hacer"
              maxLength={200}
              rows={2}
              disabled={readOnly}
              placeholder="Llamar a Jorge para confirmar la evaluación"
            />
          )}
        </form.AppField>
        {editTask?.reason ? <ExpandableText text={editTask.reason} lines={3} label="contexto de la tarea" className="text-sm text-muted-foreground" /> : null}

        <form.AppField name="dueAt">
          {(field) => (
            <field.Control label="Vence">
              {(control) => (
                <DueAtField
                  id={control.id}
                  aria-label="Vence"
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={field.handleChange}
                  disabled={readOnly}
                />
              )}
            </field.Control>
          )}
        </form.AppField>

        <form.AppField name="owner">
          {(field) => (
            <field.Control label="Quién la lleva" description="Sin responsable, la ve quien trabaja en esa parte del equipo.">
              {(control) => (
                <ChoiceSelect
                  {...control.props}
                  value={field.state.value}
                  disabled={readOnly}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
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
              )}
            </field.Control>
          )}
        </form.AppField>

        {!isEdit && !contactId && !patientId && !opportunityId && canReadCrm ? (
          <form.AppField name="person">
            {(field) => (
              <field.Control label="De quién es (opcional)">
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="De quién es (opcional)"
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      form.setFieldValue("opportunityId", "")
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}

        {!isEdit && !opportunityId && openOpportunities.length > 0 ? (
          <form.AppField name="opportunityId">
            {(field) => (
              <field.Control label="Es la próxima acción de">
                {(control) => (
                  <ChoiceSelect {...control.props} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)}>
                    <option value="">Ninguna oportunidad</option>
                    {openOpportunities.map((item) => (
                      <option key={item.id} value={item.id} disabled={item.nextTask !== null}>
                        {item.title} · {item.stageName}
                        {item.nextTask ? " · ya tiene su tarea" : ""}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}
