import { Button, Checkbox, Label, toast } from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  common,
  FormDrawer,
  SpeechInput,
  submitErrorMessage,
  submitForm,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { z } from "zod"
import { useIsAdmin } from "../../lib/session"
import { postJson, useClientSale, useInvalidateClient } from "./sale-api"
import {
  ACTIVITY_KINDS,
  ACTIVITY_WORDS,
  type ActivityKind,
  CLIENT_PROFESSIONALS,
  CLIENT_TOOLS,
  CONTACT_ROLES,
  type ContactRole,
  DIRECTION_WORDS,
  limaDay,
  limaInstant,
  limaTime,
  PROFESSIONALS_WORDS,
  ROLE_WORDS,
  SUPPORT_TASK_KINDS,
  TASK_KINDS,
  TASK_WORDS,
  type TaskKind,
  TOOL_WORDS,
} from "./sale-words"
import { DayField } from "./task-drawer"

/**
 * «Anotar» (lienzo de la ficha y de Kairós): se escribe o se dicta lo que
 * pasó, tal cual. «Ordenar» le pide a Kairós que lo separe en piezas —la
 * actividad, la tarea que sigue, las personas nuevas y los datos que faltaban—
 * sin guardar nada: cada pieza se revisa y se cambia aquí, y «Guardar» (también
 * con Enter en el texto) lo guarda todo o nada con las mismas operaciones de la
 * ficha. Sin ordenar, se guarda como una nota.
 */
export interface AnnotateDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
}

export function AnnotateDrawer(props: AnnotateDrawerProps) {
  if (!props.open) return null
  return <AnnotateForm {...props} />
}

const NONE = "__ninguna"

const previewSchema = z.object({
  annotation: z.object({
    activity: z.object({
      kind: z.enum(ACTIVITY_KINDS),
      direction: z.enum(["salio", "entro"]).nullable(),
      outcome: z.string().nullable(),
      body: z.string(),
      contactId: z.string().nullable(),
    }),
    task: z
      .object({
        kind: z.enum(TASK_KINDS),
        title: z.string(),
        dueOn: z.string(),
        dueAt: z.string().nullable(),
        contactId: z.string().nullable(),
        demoId: z.string().nullable(),
      })
      .nullable(),
    newContacts: z.array(
      z.object({
        name: z.string(),
        title: z.string().nullable(),
        roles: z.array(z.enum(CONTACT_ROLES)),
      }),
    ),
    data: z.object({
      city: z.string().optional(),
      professionals: z.string().optional(),
      currentTool: z.string().optional(),
    }),
  }),
  contacts: z.array(z.object({ id: z.string(), name: z.string() })),
  demos: z.array(z.object({ id: z.string(), name: z.string() })),
  /** «plantilla»: sin modelo configurado, Kairós ordenó con reglas fijas. */
  drafter: z.enum(["modelo", "plantilla"]).default("modelo"),
})
type Preview = z.infer<typeof previewSchema>

interface AnnotateValues {
  text: string
  ordered: boolean
  activity: {
    kind: ActivityKind
    direction: string
    outcome: string
    body: string
    contactId: string
  }
  withTask: boolean
  task: {
    kind: TaskKind
    title: string
    dueOn: string
    dueTime: string
    contactId: string
    demoId: string
  }
  newContacts: { name: string; title: string; roles: ContactRole[] }[]
  data: { city: string; professionals: string; currentTool: string }
}

const annotateSchema = z
  .object({
    text: z.string().max(4000, "Usa como máximo 4000 caracteres"),
    ordered: z.boolean(),
    activity: z.object({
      kind: z.enum(ACTIVITY_KINDS),
      direction: z.string(),
      outcome: z.string().max(500, "Usa como máximo 500 caracteres"),
      body: z.string().max(2000, "Usa como máximo 2000 caracteres"),
      contactId: z.string(),
    }),
    withTask: z.boolean(),
    task: z.object({
      kind: z.enum(TASK_KINDS),
      title: z.string().max(200, "Usa como máximo 200 caracteres"),
      dueOn: z.string(),
      dueTime: z.string(),
      contactId: z.string(),
      demoId: z.string(),
    }),
    newContacts: z.array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1, "Escribe el nombre de la persona")
          .max(160, "Usa como máximo 160 caracteres"),
        title: z.string().max(120, "Usa como máximo 120 caracteres"),
        roles: z.array(z.enum(CONTACT_ROLES)),
      }),
    ),
    data: z.object({
      city: z.string().max(120, "Usa como máximo 120 caracteres"),
      professionals: z.string(),
      currentTool: z.string(),
    }),
  })
  .superRefine((value, ctx) => {
    if (!value.ordered && !value.text.trim())
      ctx.addIssue({ code: "custom", path: ["text"], message: "Escribe o dicta qué pasó" })
    if (value.ordered && !value.activity.body.trim())
      ctx.addIssue({ code: "custom", path: ["activity", "body"], message: "Escribe qué pasó" })
    if (value.withTask && !value.task.title.trim())
      ctx.addIssue({ code: "custom", path: ["task", "title"], message: "Escribe la tarea" })
    if (value.withTask && !value.task.dueOn)
      ctx.addIssue({ code: "custom", path: ["task", "dueOn"], message: "Elige el día" })
  })

const option = (value: string, label: string) => ({ value, label })
const orNull = (value: string) => (value === NONE || !value.trim() ? null : value.trim())

function AnnotateForm({ clientId, onClose }: AnnotateDrawerProps) {
  const isAdmin = useIsAdmin()
  const client = useClientSale(clientId)
  const invalidate = useInvalidateClient(clientId)
  const today = limaDay()
  const defaults: AnnotateValues = {
    text: "",
    ordered: false,
    activity: { kind: "nota", direction: "", outcome: "", body: "", contactId: NONE },
    withTask: false,
    task: { kind: "llamar", title: "", dueOn: today, dueTime: "", contactId: NONE, demoId: NONE },
    newContacts: [],
    data: { city: "", professionals: "", currentTool: "" },
  }
  const preview = useMutation({
    mutationFn: async (text: string) =>
      previewSchema.parse(
        await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/annotate/preview`, {
          text,
        }),
      ),
    onSuccess: (result) => apply(result),
  })
  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: annotateSchema },
    onSubmit: async ({ value }) => {
      const data = Object.fromEntries(
        Object.entries({
          city: value.data.city.trim(),
          professionals: value.data.professionals,
          currentTool: value.data.currentTool,
        }).filter(([, each]) => each),
      )
      const body = value.ordered
        ? {
            activity: {
              kind: value.activity.kind,
              direction:
                value.activity.kind === "nota"
                  ? null
                  : (orNull(value.activity.direction) as "salio" | "entro" | null),
              outcome: orNull(value.activity.outcome),
              body: value.activity.body.trim(),
              contactId: orNull(value.activity.contactId),
            },
            task: value.withTask
              ? {
                  kind: value.task.kind,
                  title: value.task.title.trim(),
                  dueOn: value.task.dueOn,
                  dueAt: value.task.dueTime
                    ? limaInstant(value.task.dueOn, value.task.dueTime)
                    : null,
                  contactId: orNull(value.task.contactId),
                  demoId: orNull(value.task.demoId),
                }
              : null,
            newContacts: value.newContacts.map((person) => ({
              name: person.name.trim(),
              title: orNull(person.title),
              roles: person.roles,
            })),
            data,
          }
        : {
            activity: {
              kind: "nota",
              direction: null,
              outcome: null,
              body: value.text.trim(),
              contactId: null,
            },
            task: null,
            newContacts: [],
            data: {},
          }
      await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/annotate`, body)
      invalidate()
      toast.success(
        value.ordered && value.withTask ? "Anotado, con su tarea" : "Anotado en su historial",
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { "task.dueAt": "task.dueTime" } })
  const values = useStore(form.store, (state) => state.values)

  /** Pone las piezas que propuso Kairós en el formulario: todas se pueden cambiar antes de guardar. */
  function apply(result: Preview) {
    const { annotation } = result
    form.setFieldValue("ordered", true)
    form.setFieldValue("activity", {
      kind: annotation.activity.kind,
      direction: annotation.activity.direction ?? "",
      outcome: annotation.activity.outcome ?? "",
      body: annotation.activity.body,
      contactId: annotation.activity.contactId ?? NONE,
    })
    form.setFieldValue("withTask", annotation.task !== null)
    if (annotation.task)
      form.setFieldValue("task", {
        kind: annotation.task.kind,
        title: annotation.task.title,
        dueOn: annotation.task.dueOn,
        dueTime: annotation.task.dueAt ? limaTime(annotation.task.dueAt) : "",
        contactId: annotation.task.contactId ?? NONE,
        demoId: annotation.task.demoId ?? NONE,
      })
    form.setFieldValue(
      "newContacts",
      annotation.newContacts.map((person) => ({
        name: person.name,
        title: person.title ?? "",
        roles: person.roles,
      })),
    )
    form.setFieldValue("data", {
      city: annotation.data.city ?? "",
      professionals: annotation.data.professionals ?? "",
      currentTool: annotation.data.currentTool ?? "",
    })
  }

  const contacts =
    preview.data?.contacts ??
    (client.data?.contacts ?? []).flatMap((contact) =>
      contact.id ? [{ id: contact.id, name: contact.name }] : [],
    )
  const demos = preview.data?.demos ?? []
  const contactOptions = [
    option(NONE, "Nadie en especial"),
    ...contacts.map((contact) => option(contact.id, contact.name)),
  ]
  const taskKinds = isAdmin ? TASK_KINDS : SUPPORT_TASK_KINDS

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Anotar"
      description={
        client.data
          ? `Lo que pasó con ${client.data.name}: una llamada, un WhatsApp, una reunión.`
          : undefined
      }
      submitLabel={values.ordered ? "Guardar" : "Guardar como nota"}
      secondaryAction={{
        label: preview.isPending ? "Ordenando…" : values.ordered ? "Volver a ordenar" : "Ordenar",
        onClick: () => {
          if (!values.text.trim()) {
            void submitForm(form)
            return
          }
          preview.mutate(values.text.trim())
        },
        disabled: preview.isPending || surface.isSubmitting,
      }}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="text">
          {(field) => (
            <div className="flex flex-col gap-1.5">
              <field.TextareaField
                id="anotar-texto"
                label="¿Qué pasó?"
                description="Escríbelo como te salga. Enter guarda; Mayús + Enter, otra línea. No escribas nombres de pacientes."
                placeholder="Ej.: Llamé a Luis. Quiere ver cómo traemos sus datos; viene con su socio. Presentación el jueves a las 10."
                rows={4}
                maxLength={4000}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void submitForm(form)
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <SpeechInput
                  lang="es-PE"
                  size="icon"
                  type="button"
                  aria-label="Dictar lo que pasó"
                  onTranscriptionChange={(text) =>
                    field.handleChange(`${field.state.value ? `${field.state.value} ` : ""}${text}`)
                  }
                />
                <span className="text-xs text-muted-foreground">Dictar</span>
              </div>
            </div>
          )}
        </form.AppField>

        {preview.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(preview.error)}
          </p>
        ) : null}

        {values.ordered ? (
          <AgentSurface aria-labelledby="anotar-kairos" className="flex flex-col gap-5 p-4">
            <div className="flex items-start gap-3">
              <AgentMark size="sm" />
              <p id="anotar-kairos" className="text-sm">
                <span className="font-semibold">Kairós</span> lo ordenó en piezas. Revísalas y
                cámbialas: nada se guarda hasta que pulses Guardar.
                {preview.data?.drafter === "plantilla"
                  ? " Esta vez lo ordenó sin el modelo, con reglas fijas: revisa sobre todo la tarea y su día."
                  : ""}
              </p>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-semibold">La actividad</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <form.AppField name="activity.kind">
                  {(field) => (
                    <field.SelectField
                      id="anotar-tipo"
                      label="Qué fue"
                      options={ACTIVITY_KINDS.map((kind) => option(kind, ACTIVITY_WORDS[kind]))}
                    />
                  )}
                </form.AppField>
                {values.activity.kind !== "nota" ? (
                  <form.AppField name="activity.direction">
                    {(field) => (
                      <field.SelectField
                        id="anotar-direccion"
                        label="Quién buscó a quién"
                        options={[
                          option("", "No se sabe"),
                          option("salio", DIRECTION_WORDS.salio),
                          option("entro", DIRECTION_WORDS.entro),
                        ]}
                      />
                    )}
                  </form.AppField>
                ) : null}
                <form.AppField name="activity.contactId">
                  {(field) => (
                    <field.SelectField
                      id="anotar-persona"
                      label="Con quién"
                      options={contactOptions}
                    />
                  )}
                </form.AppField>
                <form.AppField name="activity.outcome">
                  {(field) => (
                    <field.TextField
                      id="anotar-resultado"
                      label="Cómo quedó (opcional)"
                      maxLength={500}
                    />
                  )}
                </form.AppField>
              </div>
              <form.AppField name="activity.body">
                {(field) => (
                  <field.TextareaField
                    id="anotar-cuerpo"
                    label="Lo que queda en su historial"
                    rows={3}
                    maxLength={2000}
                  />
                )}
              </form.AppField>
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-semibold">La tarea que sigue</legend>
              <form.AppField name="withTask">
                {(field) => <field.CheckboxField id="anotar-con-tarea" label="Poner la tarea" />}
              </form.AppField>
              {values.withTask ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <form.AppField name="task.kind">
                    {(field) => (
                      <field.SelectField
                        id="anotar-tarea-tipo"
                        label="Qué hay que hacer"
                        options={taskKinds.map((kind) => option(kind, TASK_WORDS[kind]))}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="task.title">
                    {(field) => (
                      <field.TextField id="anotar-tarea" label="La tarea" maxLength={200} />
                    )}
                  </form.AppField>
                  <DayField
                    form={form}
                    name="task.dueOn"
                    id="anotar-tarea-dia"
                    label="Día"
                    min={today}
                  />
                  <form.AppField name="task.dueTime">
                    {(field) => (
                      <field.Control id="anotar-tarea-hora" label="Hora (opcional)">
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
                  <form.AppField name="task.contactId">
                    {(field) => (
                      <field.SelectField
                        id="anotar-tarea-persona"
                        label="Con quién"
                        options={contactOptions}
                      />
                    )}
                  </form.AppField>
                  {values.task.kind === "presentacion" && demos.length > 0 ? (
                    <form.AppField name="task.demoId">
                      {(field) => (
                        <field.SelectField
                          id="anotar-tarea-demo"
                          label="Demo"
                          options={[
                            option(NONE, "Sin demo"),
                            ...demos.map((demo) => option(demo.id, demo.name)),
                          ]}
                        />
                      )}
                    </form.AppField>
                  ) : null}
                </div>
              ) : null}
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-semibold">Personas nuevas</legend>
              <form.Field name="newContacts" mode="array">
                {(list) => (
                  <div className="flex flex-col gap-3">
                    {list.state.value.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No nombró a nadie nuevo.</p>
                    ) : null}
                    {list.state.value.map((person, index) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: cada fila es el campo `newContacts[i]`; su clave no cambia al escribir el nombre.
                        key={index}
                        className="flex flex-col gap-3 rounded-lg border bg-background p-3"
                      >
                        <div className="grid gap-3 sm:grid-cols-2">
                          <form.AppField name={`newContacts[${index}].name`}>
                            {(field) => (
                              <field.TextField
                                id={`anotar-persona-${index}`}
                                label="Nombre"
                                maxLength={160}
                              />
                            )}
                          </form.AppField>
                          <form.AppField name={`newContacts[${index}].title`}>
                            {(field) => (
                              <field.TextField
                                id={`anotar-cargo-${index}`}
                                label="Cargo (opcional)"
                                maxLength={120}
                              />
                            )}
                          </form.AppField>
                        </div>
                        <form.Field name={`newContacts[${index}].roles`}>
                          {(field) => (
                            <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
                              <legend className="sr-only">
                                Papeles de {person.name || "la persona"}
                              </legend>
                              {CONTACT_ROLES.map((role) => {
                                const id = `anotar-papel-${index}-${role}`
                                const checked = field.state.value.includes(role)
                                return (
                                  <span key={role} className="flex items-center gap-2">
                                    <Checkbox
                                      id={id}
                                      checked={checked}
                                      onCheckedChange={(next) =>
                                        field.handleChange(
                                          next
                                            ? [...field.state.value, role]
                                            : field.state.value.filter((each) => each !== role),
                                        )
                                      }
                                    />
                                    <Label htmlFor={id} className="font-normal">
                                      {ROLE_WORDS[role]}
                                    </Label>
                                  </span>
                                )
                              })}
                              {field.state.value.length === 0 ? (
                                <span className="text-xs text-muted-foreground">
                                  Papeles por confirmar
                                </span>
                              ) : null}
                            </fieldset>
                          )}
                        </form.Field>
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-2"
                            onClick={() => list.removeValue(index)}
                          >
                            <X aria-hidden />
                            No agregar a {person.name || "esta persona"}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => list.pushValue({ name: "", title: "", roles: [] })}
                      >
                        <Plus aria-hidden />
                        Agregar persona
                      </Button>
                    </div>
                  </div>
                )}
              </form.Field>
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-semibold">Datos de la clínica</legend>
              <p className="text-xs text-muted-foreground">
                Solo lo que dijo; lo vacío no cambia lo que ya está guardado.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <form.AppField name="data.city">
                  {(field) => (
                    <field.TextField
                      id="anotar-ciudad"
                      label="Ciudad"
                      placeholder={client.data?.city ?? ""}
                      maxLength={120}
                    />
                  )}
                </form.AppField>
                <form.AppField name="data.professionals">
                  {(field) => (
                    <field.SelectField
                      id="anotar-profesionales"
                      label="Cuántos atienden"
                      options={[
                        option("", "Sin cambiar"),
                        ...CLIENT_PROFESSIONALS.map((each) =>
                          option(each, PROFESSIONALS_WORDS[each]),
                        ),
                      ]}
                    />
                  )}
                </form.AppField>
                <form.AppField name="data.currentTool">
                  {(field) => (
                    <field.SelectField
                      id="anotar-herramienta"
                      label="Qué usan hoy"
                      options={[
                        option("", "Sin cambiar"),
                        ...CLIENT_TOOLS.map((each) => option(each, TOOL_WORDS[each])),
                      ]}
                    />
                  )}
                </form.AppField>
              </div>
            </fieldset>
          </AgentSurface>
        ) : (
          <p className="text-xs text-muted-foreground">
            «Ordenar» le pide a Kairós que lo separe en la actividad, la tarea, las personas nuevas
            y los datos, para que lo revises. Sin ordenar, se guarda como nota.
          </p>
        )}
      </div>
    </FormDrawer>
  )
}
