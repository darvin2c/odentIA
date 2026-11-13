import { toast } from "@odentia/ui"
import {
  common,
  DatePickerButton,
  FormDrawer,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { z } from "zod"
import { useIsAdmin } from "../../lib/session"
import {
  postJson,
  type SaleTask,
  useClientSale,
  useClientTasks,
  useInvalidateClient,
} from "./sale-api"
import {
  addDays,
  dueWords,
  limaDay,
  limaInstant,
  limaTime,
  SUPPORT_TASK_KINDS,
  TASK_KINDS,
  TASK_WORDS,
  type TaskKind,
} from "./sale-words"

/**
 * «Nueva tarea» de la ficha del cliente, y «Cambiar fecha» de una que ya
 * existe (`taskId`). La tarea es de la persona responsable del cliente si no se
 * dice otra cosa (lo decide el servidor). El día es de Lima; la hora, opcional.
 */
export interface TaskDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  /** Con una tarea abierta: solo cambia su día y su hora. */
  taskId?: string | null
  /** Lo que viene elegido al abrir una nueva. */
  initialKind?: TaskKind
}

export function TaskDrawer(props: TaskDrawerProps) {
  if (!props.open) return null
  return props.taskId ? (
    <MoveTaskDrawer {...props} taskId={props.taskId} />
  ) : (
    <NewTaskDrawer {...props} />
  )
}

const NO_CONTACT = "__nadie"

const newTaskSchema = z.object({
  kind: z.enum(TASK_KINDS, "Elige qué hay que hacer"),
  title: z.string().trim().min(1, "Escribe la tarea").max(200, "Usa como máximo 200 caracteres"),
  dueOn: z.string().min(1, "Elige el día"),
  dueTime: z.string(),
  contactId: z.string(),
})

function NewTaskDrawer({ clientId, onClose, initialKind = "llamar" }: TaskDrawerProps) {
  const isAdmin = useIsAdmin()
  const client = useClientSale(clientId)
  const invalidate = useInvalidateClient(clientId)
  const today = limaDay()
  const contacts = (client.data?.contacts ?? []).filter((contact) => contact.id !== null)
  const form = useAppForm({
    defaultValues: {
      kind: initialKind as TaskKind,
      title: "",
      dueOn: today,
      dueTime: "",
      contactId: NO_CONTACT,
    },
    validators: { onSubmit: newTaskSchema },
    onSubmit: async ({ value }) => {
      await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/tasks`, {
        kind: value.kind,
        title: value.title.trim(),
        dueOn: value.dueOn,
        dueAt: value.dueTime ? limaInstant(value.dueOn, value.dueTime) : null,
        contactId: value.contactId === NO_CONTACT ? null : value.contactId,
      })
      invalidate()
      toast.success(
        `Tarea puesta para ${dueWords(value.dueOn, value.dueTime ? limaInstant(value.dueOn, value.dueTime) : null)}`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { dueAt: "dueTime" } })
  const dueOn = useStore(form.store, (state) => state.values.dueOn)
  const kinds = isAdmin ? TASK_KINDS : SUPPORT_TASK_KINDS

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Nueva tarea"
      description={
        client.data
          ? `Para ${client.data.name}. Sin responsable elegido, es de quien lleva al cliente.`
          : undefined
      }
      submitLabel="Poner la tarea"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="kind">
          {(field) => (
            <field.SelectField
              id="tarea-tipo"
              label="Qué hay que hacer"
              options={kinds.map((kind) => ({ value: kind, label: TASK_WORDS[kind] }))}
            />
          )}
        </form.AppField>
        <form.AppField name="title">
          {(field) => (
            <field.TextField
              id="tarea-titulo"
              label="La tarea"
              placeholder="Ej.: Llamar a Luis para ver qué le pareció"
              maxLength={200}
              autoFocus
            />
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <DayField form={form} id="tarea-dia" label="Día" min={today} />
          <form.AppField name="dueTime">
            {(field) => (
              <field.Control id="tarea-hora" label="Hora (opcional)">
                {(control) => (
                  <TimeSelect
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                    emptyLabel="Sin hora"
                    min={dueOn === today ? limaTime(new Date().toISOString()) : undefined}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        {contacts.length > 0 ? (
          <form.AppField name="contactId">
            {(field) => (
              <field.SelectField
                id="tarea-persona"
                label="Con quién (opcional)"
                options={[
                  { value: NO_CONTACT, label: "Con nadie en especial" },
                  ...contacts.map((contact) => ({
                    value: contact.id as string,
                    label: contact.name,
                  })),
                ]}
              />
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}

const moveSchema = z.object({ dueOn: z.string().min(1, "Elige el día"), dueTime: z.string() })

function MoveTaskDrawer({ clientId, onClose, taskId }: TaskDrawerProps & { taskId: string }) {
  const tasks = useClientTasks(clientId, "abierta")
  const task = tasks.data?.find((row) => row.id === taskId) ?? null
  if (tasks.isPending || !task) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Cambiar fecha"
        onSubmit={(event) => event.preventDefault()}
        isLoading={tasks.isPending}
        error={
          tasks.isError
            ? "No pude cargar la tarea. Cierra y vuelve a intentarlo."
            : tasks.isPending
              ? null
              : "Esa tarea ya no está abierta."
        }
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {null}
      </FormDrawer>
    )
  }
  return <MoveTaskForm clientId={clientId} task={task} onClose={onClose} />
}

function MoveTaskForm({
  clientId,
  task,
  onClose,
}: {
  clientId: string
  task: SaleTask
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const today = limaDay()
  const form = useAppForm({
    defaultValues: {
      dueOn: task.dueOn < today ? addDays(today, 1) : task.dueOn,
      dueTime: task.dueAt ? limaTime(task.dueAt) : "",
    },
    validators: { onSubmit: moveSchema },
    onSubmit: async ({ value }) => {
      const dueAt = value.dueTime ? limaInstant(value.dueOn, value.dueTime) : null
      await postJson(`/api/admin/clients/tasks/${encodeURIComponent(task.id)}/move`, {
        dueOn: value.dueOn,
        dueAt,
      })
      invalidate()
      toast.success(`«${task.title}» pasa a ${dueWords(value.dueOn, dueAt)}`)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { dueAt: "dueTime" } })
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Cambiar fecha"
      description={`${task.title} · era ${dueWords(task.dueOn, task.dueAt, today)}`}
      submitLabel="Cambiar la fecha"
      cancelLabel={common.actions.cancel}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DayField form={form} id="mover-dia" label="Día nuevo" min={today} />
        <form.AppField name="dueTime">
          {(field) => (
            <field.Control id="mover-hora" label="Hora (opcional)">
              {(control) => (
                <TimeSelect
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  value={field.state.value}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                  emptyLabel="Sin hora"
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

/** El día de un formulario con `dueOn` (el día de Lima), con `DatePickerButton`. */
export function DayField({
  form,
  id,
  label,
  min,
  name = "dueOn",
}: {
  // biome-ignore lint/suspicious/noExplicitAny: sirve a cualquier formulario que tenga ese campo de día.
  form: any
  id: string
  label: string
  min?: string
  name?: string
}) {
  return (
    <form.AppField name={name}>
      {/* biome-ignore lint/suspicious/noExplicitAny: el campo es el del formulario de quien lo usa. */}
      {(field: any) => (
        <field.Control id={id} label={label}>
          {(control: { props: Record<string, unknown> }) => (
            <DatePickerButton
              {...control.props}
              value={field.state.value}
              onChange={(next) => {
                field.handleChange(next)
                field.handleBlur()
              }}
              min={min}
              className="w-full justify-start"
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
}
