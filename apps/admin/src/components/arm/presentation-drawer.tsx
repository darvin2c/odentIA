import { Button, toast } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  common,
  DetailField,
  DetailList,
  FormDrawer,
  SpeechInput,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { ExternalLink } from "lucide-react"
import { z } from "zod"
import { type DemoItem, demoLine, useDemos, useOpenDemo } from "../demos"
import {
  type ClientSale,
  postJson,
  type SaleTask,
  useClientSale,
  useClientTasks,
  useInvalidateClient,
} from "./sale-api"
import { addDays, dueWords, limaDay, limaInstant, limaTime } from "./sale-words"
import { DayField } from "./task-drawer"

/**
 * La presentación de una venta (lienzo del Embudo, tablero 2): se agenda con su
 * día, su hora, con quién y la demo del producto, que se abre desde aquí
 * («Abrir demo» cuenta como uso de la demo). Después se anota cómo fue: «Se
 * hizo» la pasa a «Presentación hecha»; «No se conectó» y «Reprogramar» dejan
 * una nota y la tarea sigue o se mueve. La etapa la calcula el servidor.
 */
export interface PresentationDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  /** La tarea de la presentación ya agendada: abre «cómo fue». */
  taskId?: string | null
}

export function PresentationDrawer(props: PresentationDrawerProps) {
  if (!props.open) return null
  return <PresentationLoader {...props} />
}

const NONE = "__ninguna"

function PresentationLoader({ clientId, onClose, taskId }: PresentationDrawerProps) {
  const client = useClientSale(clientId)
  const tasks = useClientTasks(clientId, "abierta", Boolean(taskId))
  const task = taskId ? (tasks.data?.find((row) => row.id === taskId) ?? null) : null
  const loading = client.isPending || (Boolean(taskId) && tasks.isPending)
  const failed = client.isError || (Boolean(taskId) && tasks.isError)
  if (loading || failed || !client.data || (taskId && !task)) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title={taskId ? "La presentación" : "Agendar presentación"}
        onSubmit={(event) => event.preventDefault()}
        isLoading={loading}
        error={
          failed
            ? "No pude cargar la presentación. Cierra y vuelve a intentarlo."
            : loading
              ? null
              : "Esa presentación ya no está por hacerse."
        }
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {null}
      </FormDrawer>
    )
  }
  return task ? (
    <RecordForm clientId={clientId} client={client.data} task={task} onClose={onClose} />
  ) : (
    <ScheduleForm clientId={clientId} client={client.data} onClose={onClose} />
  )
}

/** Las demos de su producto que ya se pueden abrir. */
function useProductDemos(product: ClientSale["product"]) {
  const demos = useDemos()
  return {
    ...demos,
    ready: (demos.data ?? []).filter(
      (demo) => demo.product === product && demo.status === "lista" && demo.organizationId,
    ),
  }
}

function OpenDemoButton({ demo }: { demo: DemoItem }) {
  const open = useOpenDemo()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => open.mutate({ id: demo.id, slug: demo.slug, product: demo.product })}
    >
      <ExternalLink aria-hidden />
      Abrir demo
    </Button>
  )
}

const scheduleSchema = z.object({
  dueOn: z.string().min(1, "Elige el día"),
  dueTime: z.string(),
  contactId: z.string(),
  demoId: z.string(),
})

function ScheduleForm({
  clientId,
  client,
  onClose,
}: {
  clientId: string
  client: ClientSale
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const demos = useProductDemos(client.product)
  const today = limaDay()
  const contacts = client.contacts.filter((contact) => contact.id !== null)
  const primary = contacts.find((contact) => contact.isPrimary) ?? contacts[0]
  const form = useAppForm({
    defaultValues: {
      dueOn: addDays(today, 1),
      dueTime: "10:00",
      contactId: primary?.id ?? NONE,
      demoId: NONE,
    },
    validators: { onSubmit: scheduleSchema },
    onSubmit: async ({ value }) => {
      const dueAt = value.dueTime ? limaInstant(value.dueOn, value.dueTime) : null
      await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/presentations`, {
        dueOn: value.dueOn,
        dueAt,
        contactId: value.contactId === NONE ? null : value.contactId,
        demoId: value.demoId === NONE ? null : value.demoId,
      })
      invalidate()
      toast.success(`Presentación agendada para ${dueWords(value.dueOn, dueAt)}`)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { dueAt: "dueTime" } })
  const demoId = useStore(form.store, (state) => state.values.demoId)
  const chosen = demos.ready.find((demo) => demo.id === demoId) ?? null

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Agendar presentación"
      description={`Con ${client.name}. Queda como tarea de presentación de quien lleva al cliente.`}
      submitLabel="Agendar"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <DayField form={form} id="presentacion-dia" label="Día" min={today} />
          <form.AppField name="dueTime">
            {(field) => (
              <field.Control id="presentacion-hora" label="Hora">
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
        <form.AppField name="contactId">
          {(field) => (
            <field.SelectField
              id="presentacion-persona"
              label="Con quién"
              options={[
                { value: NONE, label: "Todavía no se sabe" },
                ...contacts.map((contact) => ({
                  value: contact.id as string,
                  label: contact.title ? `${contact.name} · ${contact.title}` : contact.name,
                })),
              ]}
            />
          )}
        </form.AppField>
        <form.AppField name="demoId">
          {(field) => (
            <field.SelectField
              id="presentacion-demo"
              label="Demo"
              description={
                demos.isPending
                  ? "Cargando las demos…"
                  : demos.ready.length === 0
                    ? "No hay una demo de este producto lista. Créala en Demos y elígela después."
                    : chosen
                      ? demoLine(chosen)
                      : "La demo del producto que se usará al presentar."
              }
              options={[
                { value: NONE, label: "Sin demo por ahora" },
                ...demos.ready.map((demo) => ({ value: demo.id, label: demo.name })),
              ]}
            />
          )}
        </form.AppField>
        {chosen ? (
          <div>
            <OpenDemoButton demo={chosen} />
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}

const OUTCOMES = [
  { value: "se_hizo", label: "Se hizo" },
  { value: "no_se_conecto", label: "No se conectó" },
  { value: "reprogramar", label: "Reprogramar" },
] as const
type Outcome = (typeof OUTCOMES)[number]["value"]

const recordSchema = z
  .object({
    outcome: z.enum(["se_hizo", "no_se_conecto", "reprogramar"], "Elige cómo fue"),
    body: z
      .string()
      .trim()
      .min(1, "Escribe o dicta cómo fue")
      .max(2000, "Usa como máximo 2000 caracteres"),
    nextDueOn: z.string(),
    nextDueTime: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === "reprogramar" && !value.nextDueOn)
      ctx.addIssue({
        code: "custom",
        path: ["nextDueOn"],
        message: "Elige el día nuevo de la presentación",
      })
  })

function RecordForm({
  clientId,
  client,
  task,
  onClose,
}: {
  clientId: string
  client: ClientSale
  task: SaleTask
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const demos = useDemos()
  const demo = (demos.data ?? []).find((each) => each.id === task.demoId) ?? null
  const contact = client.contacts.find((each) => each.id && each.id === task.contactId) ?? null
  const today = limaDay()
  const form = useAppForm({
    defaultValues: {
      outcome: "se_hizo" as Outcome,
      body: "",
      nextDueOn: "",
      nextDueTime: task.dueAt ? limaTime(task.dueAt) : "",
    },
    validators: { onSubmit: recordSchema },
    onSubmit: async ({ value }) => {
      const moves = value.outcome !== "se_hizo" && value.nextDueOn
      await postJson(`/api/admin/clients/presentations/${encodeURIComponent(task.id)}/record`, {
        outcome: value.outcome,
        body: value.body.trim(),
        nextDueOn: moves ? value.nextDueOn : null,
        nextDueAt:
          moves && value.nextDueTime ? limaInstant(value.nextDueOn, value.nextDueTime) : null,
      })
      invalidate()
      toast.success(
        value.outcome === "se_hizo"
          ? "Anotada: la presentación se hizo"
          : moves
            ? `Presentación movida a ${dueWords(value.nextDueOn, null)}`
            : "Anotado: no se conectó",
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { nextDueAt: "nextDueTime" } })
  const outcome = useStore(form.store, (state) => state.values.outcome)

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="La presentación"
      description={client.name}
      submitLabel="Guardar"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-5">
        <DetailList>
          <DetailField label="Cuándo">{dueWords(task.dueOn, task.dueAt, today)}</DetailField>
          <DetailField label="Con quién">
            {contact
              ? contact.title
                ? `${contact.name}, ${contact.title}`
                : contact.name
              : "Por saber"}
          </DetailField>
          <DetailField label="Responsable">{task.assignee?.name ?? "Sin responsable"}</DetailField>
          <DetailField label="Demo">
            {demo
              ? `${demo.name} · ${demoLine(demo)}`
              : task.demoId
                ? "Una demo que ya no está"
                : "Sin demo"}
          </DetailField>
        </DetailList>
        {demo && demo.status === "lista" && demo.organizationId ? (
          <div>
            <OpenDemoButton demo={demo} />
          </div>
        ) : null}
        <form.AppField name="outcome">
          {(field) => (
            <field.Group legend="Después de presentar">
              {() => (
                <ToggleGroup
                  aria-label="Después de presentar"
                  value={[field.state.value]}
                  onValueChange={(next: unknown[]) => {
                    const picked = OUTCOMES.find((option) => option.value === next[0])
                    if (picked) field.handleChange(picked.value)
                  }}
                  spacing={1}
                  className="flex-wrap justify-start"
                >
                  {OUTCOMES.map((option) => (
                    <ToggleGroupItem
                      key={option.value}
                      value={option.value}
                      className="h-auto min-h-9 rounded-3xl border px-3 py-1.5 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold"
                    >
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="body">
          {(field) => (
            <div className="flex flex-col gap-1.5">
              <field.TextareaField
                id="presentacion-como-fue"
                label={outcome === "se_hizo" ? "Lo que dijeron" : "Qué pasó"}
                description="No escribas nombres de pacientes."
                placeholder={
                  outcome === "se_hizo"
                    ? "Ej.: Les gustó la agenda; piden la propuesta para 4 profesionales."
                    : "Ej.: No entró a la llamada; quedamos en otro día."
                }
                rows={4}
                maxLength={2000}
              />
              <div>
                <SpeechInput
                  lang="es-PE"
                  size="icon"
                  type="button"
                  aria-label="Dictar cómo fue"
                  onTranscriptionChange={(text) =>
                    field.handleChange(`${field.state.value ? `${field.state.value} ` : ""}${text}`)
                  }
                />
              </div>
            </div>
          )}
        </form.AppField>
        {outcome !== "se_hizo" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <DayField
              form={form}
              name="nextDueOn"
              id="presentacion-nuevo-dia"
              label={outcome === "reprogramar" ? "Día nuevo" : "Volver a agendar (opcional)"}
              min={today}
            />
            <form.AppField name="nextDueTime">
              {(field) => (
                <field.Control id="presentacion-nueva-hora" label="Hora (opcional)">
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
        ) : null}
        <p className="text-xs text-muted-foreground">
          {outcome === "se_hizo"
            ? "Queda en su historial y la venta pasa a «Presentación hecha»."
            : outcome === "reprogramar"
              ? "Queda una nota y la presentación se mueve al día nuevo."
              : "Queda una nota. Sin día nuevo, la presentación se cancela."}
        </p>
      </div>
    </FormDrawer>
  )
}
