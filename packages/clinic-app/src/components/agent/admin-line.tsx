import { Badge, Button, cn, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  FlowDiagram,
  type FlowDiagramStep,
  LoadingState,
  setSubmitErrors,
  submitErrorMessage,
  useAppForm,
} from "@odentia/ui-patterns"
import { type AnyFormApi, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PersonLink } from "../person-link"
import { Bot, ChevronDown, User } from "lucide-react"
import { useId, useState } from "react"
import { z } from "zod"
import {
  type AdminFlow,
  type AdminLineDetail,
  type AdminLineView,
  type AdminPersonRow,
  adminLineKey,
  refreshAdmin,
} from "../../lib/admin"
import { ADMIN_NAME, useReceptionName, withReceptionName, withReceptionNameIn } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"
import { AdminDraftBlock, DeleteAdminLine } from "./admin-draft"

/** Quién lo hace, con icono y palabras: nunca solo con color. Las líneas son de Argos. */
export function WhoDoesIt({ actor }: { actor: "agente" | "persona" }) {
  return actor === "agente" ? (
    <Badge variant="soft" className="gap-1">
      <Bot aria-hidden className="size-3.5" />
      Lo hace {ADMIN_NAME}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <User aria-hidden className="size-3.5" />
      Le toca a una persona
    </Badge>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "long" })
const moment = (iso: string) =>
  new Date(iso).toLocaleString(activeOrgLocale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

/** Lo que dice una línea apagada sobre hoy; null si este rol no puede ver sus casos. */
function todayNote(line: AdminLineView): string | null {
  if (line.todayCases === null) return null
  if (line.todayCases === 0) return "Hoy no hay ninguno"
  const many = line.todayCases === 1 ? "Hoy sería 1 caso" : `Hoy serían ${line.todayCases} casos`
  return line.recommended ? `${many} · ${ADMIN_NAME} te la recomienda` : many
}

function toDiagram(flow: AdminFlow): { main: FlowDiagramStep[]; otherwise: FlowDiagramStep[] | null } {
  const step = (item: AdminFlow["main"][number]): FlowDiagramStep => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    actor: item.actor === null ? null : item.actor === "equipo" ? "persona" : "agente",
    actorLabel: item.actorLabel,
  })
  return { main: flow.main.map(step), otherwise: flow.otherwise ? flow.otherwise.map(step) : null }
}

/**
 * Una línea de Argos. Cerrada dice qué pasa, quién lo hace y cómo le
 * va; su interruptor la prende o la apaga al momento. Abierta, en el mismo
 * lugar, muestra su flujo con solo lo que se ejecuta.
 */
export function AdminLine({
  line,
  open,
  onToggle,
  canWrite,
  adminOn,
  unreachedOnly = false,
  onShowAll,
}: {
  line: AdminLineView
  open: boolean
  onToggle: () => void
  canWrite: boolean
  adminOn: boolean
  unreachedOnly?: boolean
  onShowAll?: () => void
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const save = useMutation({
    retry: false,
    mutationFn: (enabled: boolean) =>
      apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${line.key}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: (response) => {
      queryClient.setQueryData(adminLineKey(line.key), response)
      refreshAdmin(queryClient)
    },
  })
  const note = line.hasDraft
    ? line.enabled
      ? "Tiene un cambio sin guardar: sigue funcionando como estaba."
      : "Borrador: todavía no hace nada."
    : line.enabled
      ? line.paused
        ? `En pausa: ${receptionName} no está atendiendo y es quien escribe.`
        : line.week
      : todayNote(line)
  return (
    <li id={`linea-${line.key}`} className="flex scroll-mt-20 flex-col">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-detalle`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown aria-hidden className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{line.trigger}</span>
              <WhoDoesIt actor={line.actor} />
              {line.hasDraft ? <Badge variant="warning">{line.enabled ? "Cambio sin guardar" : "Borrador"}</Badge> : null}
              {line.custom ? <Badge variant="secondary">Creada por tu clínica</Badge> : null}
            </span>
            <span className="text-sm text-muted-foreground">{withReceptionName(line.description, receptionName)}</span>
            {note ? <span className={cn("text-sm", (line.paused || line.hasDraft) && "font-medium text-warning")}>{note}</span> : null}
            {line.suggestion && !line.hasDraft ? <span className="text-sm font-medium">{ADMIN_NAME} propone revisarla: {withReceptionName(line.suggestion, receptionName)}</span> : null}
          </span>
        </button>
        <Switch
          checked={line.enabled}
          // Con Argos apagado no se prende nada, pero lo prendido se puede apagar.
          disabled={!canWrite || (!adminOn && !line.enabled) || save.isPending}
          aria-label={`${line.enabled ? "Apagar" : "Prender"}: ${line.name}`}
          aria-describedby={save.isError ? `${uid}-error` : undefined}
          onCheckedChange={(next: boolean) => save.mutate(next)}
        />
      </div>
      {save.isError ? (
        // El motivo del servidor (sin ninguna parte prendida, Argos apagado en otra sesión), junto al interruptor.
        <p id={`${uid}-error`} role="alert" className="px-4 pb-3 text-sm text-destructive">
          {withReceptionName(submitErrorMessage(save.error), receptionName)}
        </p>
      ) : null}
      {open ? (
        <div id={`${uid}-detalle`} className="border-t bg-canvas/60 p-4">
          <AdminLineOpen lineKey={line.key} canWrite={canWrite} adminOn={adminOn} unreachedOnly={unreachedOnly} onShowAll={onShowAll} />
        </div>
      ) : null}
    </li>
  )
}

function PersonRow({ row, lineName }: { row: AdminPersonRow; lineName?: string }) {
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2 text-sm">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        {row.patientId || row.contactId ? (
          <PersonLink contactId={row.contactId} patientId={row.patientId} className="font-semibold text-primary hover:underline">
            {row.personName}
          </PersonLink>
        ) : (
          <span className="font-semibold">{row.personName}</span>
        )}
        <span className="text-xs text-muted-foreground">{moment(row.at)}</span>
      </span>
      {lineName ? <span className="text-xs text-muted-foreground">{lineName}</span> : null}
      <span>{row.text}</span>
      {row.fix ? <span className="text-muted-foreground">Para habilitarlo: {row.fix.charAt(0).toLowerCase() + row.fix.slice(1)}</span> : null}
    </li>
  )
}

export { PersonRow as AdminPersonItem }
export { toDiagram as adminFlowToDiagram }

const NO_HOUR = "sin-hora"
const HOURS_OF_DAY = Array.from({ length: 24 }, (_, hour) => hour)

/** Lo que se dice de cada ajuste: lo mismo que `lineInput` de la API y `setLine`. */
const DAYS_RANGE = "El plazo va de 1 a 365 días."
const DELAY_RANGE = "La espera va de 1 a 72 horas."
const TASK_NOTE_MAX = 160
const TASK_NOTE_TOO_LONG = `La indicación para la tarea admite hasta ${TASK_NOTE_MAX} caracteres.`

/** Un número entero entre `min` y `max` escrito en el campo: vacío o con decimales no pasa. */
const wholeBetween = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .refine((text) => /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max, message)

/** El dato de la línea en el cuerpo de PATCH `/api/agent/admin/lines/:key`. */
type LineSettingName = "days" | "delayHours" | "taskNote" | "hour"

/** Cualquier rechazo de un ajuste es de ese dato: se dice en su campo, con el mensaje del servidor. */
function setSettingError(form: AnyFormApi, message: string | undefined) {
  setSubmitErrors(form, { fields: message ? { value: message } : {} })
}

/**
 * Un ajuste de la línea que se guarda solo, al salir del campo o al elegir:
 * lo escrito se valida y se conserva, y lo que no pasa (aquí o en el
 * servidor) se dice en el mismo campo. Cada ajuste es su propio formulario:
 * uno a medio corregir no frena a los demás.
 */
function useLineSetting({
  lineKey,
  name,
  saved,
  read,
  schema,
  toBody,
}: {
  lineKey: string
  name: LineSettingName
  /** El valor guardado, como se escribe en el campo. */
  saved: string
  read: (line: AdminLineDetail) => string
  schema: z.ZodType<unknown, string>
  toBody: (value: string) => number | string | null
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    retry: false,
    mutationFn: (value: number | string | null) =>
      apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${lineKey}`, { method: "PATCH", body: JSON.stringify({ [name]: value }) }),
    onSuccess: (response) => {
      queryClient.setQueryData(adminLineKey(lineKey), response)
      refreshAdmin(queryClient)
    },
  })
  const form = useAppForm({
    defaultValues: { value: saved },
    validators: { onSubmit: z.object({ value: schema }) },
    onSubmit: async ({ value, formApi }) => {
      // Sin cambios no se envía nada: el campo vuelve a decir lo guardado.
      if (value.value.trim() === saved) {
        formApi.reset({ value: saved })
        return
      }
      const response = await save.mutateAsync(toBody(value.value))
      formApi.reset({ value: read(response.data) })
    },
  })
  const commit = async () => {
    setSettingError(form, undefined)
    try {
      await form.handleSubmit()
    } catch (error) {
      setSettingError(form, submitErrorMessage(error))
    }
  }
  const saving = useStore(form.store, (state) => state.isSubmitting)
  return { form, commit, saving }
}

const daysOf = (line: AdminLineDetail) => String(line.days ?? line.defaultDays ?? "")

function DaysSetting({ line, editable }: { line: AdminLineDetail; editable: boolean }) {
  const { form, commit, saving } = useLineSetting({
    lineKey: line.key,
    name: "days",
    saved: daysOf(line),
    read: daysOf,
    schema: wholeBetween(1, 365, DAYS_RANGE),
    toBody: Number,
  })
  return (
    <form.AppField name="value">
      {(field) => (
        <field.Control
          className="max-w-56"
          label={line.daysLabel ?? "Plazo en días"}
          description={`De 1 a 365. Por defecto, ${line.defaultDays}. Se guarda al salir del campo.`}
        >
          {(control) => (
            <Input
              {...control.props}
              type="number"
              min={1}
              max={365}
              disabled={!editable || saving}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={() => {
                control.onBlur()
                void commit()
              }}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
}

const delayOf = (line: AdminLineDetail) => String(line.delayHours ?? "")

function DelaySetting({ line, editable }: { line: AdminLineDetail; editable: boolean }) {
  const { form, commit, saving } = useLineSetting({
    lineKey: line.key,
    name: "delayHours",
    saved: delayOf(line),
    read: delayOf,
    schema: wholeBetween(1, 72, DELAY_RANGE),
    toBody: Number,
  })
  return (
    <form.AppField name="value">
      {(field) => (
        <field.Control className="max-w-56" label="Horas de espera" description="De 1 a 72. Se guarda al salir del campo.">
          {(control) => (
            <Input
              {...control.props}
              type="number"
              min={1}
              max={72}
              disabled={!editable || saving}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={() => {
                control.onBlur()
                void commit()
              }}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
}

const taskNoteOf = (line: AdminLineDetail) => line.taskNote ?? ""

function TaskNoteSetting({ line, editable }: { line: AdminLineDetail; editable: boolean }) {
  const receptionName = useReceptionName()
  const { form, commit, saving } = useLineSetting({
    lineKey: line.key,
    name: "taskNote",
    saved: taskNoteOf(line),
    read: taskNoteOf,
    schema: z.string().trim().max(TASK_NOTE_MAX, TASK_NOTE_TOO_LONG),
    toBody: (value) => value.trim(),
  })
  return (
    <form.AppField name="value">
      {(field) => (
        <field.Control
          className="max-w-xl"
          label="Indicación para quien reciba la tarea"
          description={`La lee quien reciba la tarea en ${line.team}; ${receptionName} nunca la dice. Se guarda al salir del campo.`}
        >
          {(control) => (
            <Input
              {...control.props}
              maxLength={TASK_NOTE_MAX}
              disabled={!editable || saving}
              value={field.state.value}
              placeholder="Opcional. Por ejemplo: ofrecerle el horario de la tarde"
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={() => {
                control.onBlur()
                void commit()
              }}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
}

const hourOf = (line: AdminLineDetail) => (line.hour === null ? NO_HOUR : String(line.hour))

function HourSetting({ line, editable }: { line: AdminLineDetail; editable: boolean }) {
  const { form, commit, saving } = useLineSetting({
    lineKey: line.key,
    name: "hour",
    saved: hourOf(line),
    read: hourOf,
    schema: z.string(),
    toBody: (value) => (value === NO_HOUR ? null : Number(value)),
  })
  return (
    <form.AppField name="value">
      {(field) => (
        <field.Control className="max-w-56" label="A qué hora sale" description="Al día siguiente, con la hora de la sede. Respeta el horario de recontacto.">
          {(control) => (
            <Select
              value={field.state.value}
              disabled={!editable || saving}
              onValueChange={(value) => {
                field.handleChange(value ?? NO_HOUR)
                void commit()
              }}
            >
              <SelectTrigger {...control.props}>
                <SelectValue>{field.state.value === NO_HOUR ? "24 horas después" : `${field.state.value}:00`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_HOUR}>24 horas después</SelectItem>
                {HOURS_OF_DAY.map((hour) => (
                  <SelectItem key={hour} value={String(hour)}>
                    {hour}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </field.Control>
      )}
    </form.AppField>
  )
}

/** Una línea abierta: su flujo, sus partes, lo que recibe la persona y lo que pasó con cada quien. */
export function AdminLineOpen({
  lineKey,
  canWrite,
  adminOn,
  unreachedOnly = false,
  onShowAll,
}: {
  lineKey: string
  canWrite: boolean
  adminOn: boolean
  /** Llega del aviso «no pude escribirle a N personas»: la lista muestra solo a esas personas. */
  unreachedOnly?: boolean
  onShowAll?: () => void
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const [whole, setWhole] = useState(false)
  const [allPeople, setAllPeople] = useState(false)
  const query = useQuery({
    queryKey: adminLineKey(lineKey),
    queryFn: () => apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${lineKey}`),
    retry: false,
  })
  const people = useQuery({
    queryKey: ["agent-admin-line", lineKey, "people"],
    queryFn: () => apiFetch<{ data: { items: AdminPersonRow[]; total: number } }>(`/api/agent/admin/lines/${lineKey}/people?limit=200`),
    enabled: allPeople,
    retry: false,
  })
  const unreached = useQuery({
    queryKey: ["agent-admin-line", lineKey, "people", "no-pudo"],
    queryFn: () =>
      apiFetch<{ data: { items: AdminPersonRow[]; total: number } }>(`/api/agent/admin/lines/${lineKey}/people?only=no-pudo&limit=200`),
    enabled: unreachedOnly,
    retry: false,
  })
  // Prender o apagar una parte («le escribe», «tarea para el equipo»): su error se dice junto a ese interruptor.
  const parts = useMutation({
    retry: false,
    mutationFn: ({ part, next }: { part: "agent" | "team"; next: boolean }) =>
      apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${lineKey}`, {
        method: "PATCH",
        body: JSON.stringify(part === "agent" ? { agentPart: next } : { teamPart: next }),
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(adminLineKey(lineKey), response)
      refreshAdmin(queryClient)
    },
  })
  if (query.isPending) return <LoadingState kind="indeterminate" message="Cargando la línea…" />
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  // Los textos del servidor nombran a «Sofi»: con otro nombre en la clínica, se dice el suyo.
  const line = withReceptionNameIn(query.data.data, receptionName)
  const editable = canWrite && adminOn
  // Apagada se ve entera; prendida, solo lo que se ejecuta salvo que se pida verla entera.
  const showWhole = !line.enabled || whole
  const flow = toDiagram(showWhole ? line.fullFlow : line.flow)
  const differs = line.flow.main.length !== line.fullFlow.main.length || (line.flow.otherwise?.length ?? 0) !== (line.fullFlow.otherwise?.length ?? 0)
  const partOf = (stepId: string) => [...line.fullFlow.main, ...(line.fullFlow.otherwise ?? [])].find((step) => step.id === stepId)
  const rows = allPeople && people.data ? people.data.data.items : line.people
  // Una línea nueva en borrador todavía no existe: se ve solo lo que se armó.
  if (line.draft?.creates) return <AdminDraftBlock line={line} draft={line.draft} canWrite={canWrite} adminOn={adminOn} />

  return (
    <div className="flex flex-col gap-5">
      {line.draft ? <AdminDraftBlock line={line} draft={line.draft} canWrite={canWrite} adminOn={adminOn} /> : null}
      {line.suggestion && !line.draft ? (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-3 text-sm">
          <span className="font-semibold">{ADMIN_NAME} propone revisarla.</span> {line.suggestion} Nada cambia hasta que tú lo decidas.
        </p>
      ) : null}
      <section aria-labelledby={`${uid}-flujo`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-flujo`} className="font-heading text-sm font-semibold">
            {line.draft ? "Cómo se ejecuta hoy, paso a paso" : "Cómo se ejecuta, paso a paso"}
          </h3>
          {line.enabled && differs ? (
            <Button type="button" variant="link" size="sm" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={() => setWhole(!whole)}>
              {whole ? "Ver solo lo que se ejecuta" : "Ver todo el flujo"}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {line.enabled
            ? whole
              ? "El flujo completo. Lo que tiene su interruptor apagado no se ejecuta."
              : "Se dibuja solo lo que está prendido."
            : "Está apagada: así se ejecutaría. No pasa nada hasta que la prendas."}
        </p>
        {canWrite && !adminOn ? (
          <p className="text-sm text-muted-foreground">Sus partes y ajustes se cambian con {ADMIN_NAME} encendido: enciéndelo primero.</p>
        ) : null}
        <FlowDiagram
          label={line.name}
          main={flow.main}
          otherwise={flow.otherwise}
          idle={!line.enabled}
          renderControl={(step) => {
            const source = partOf(step.id)
            if (!source) return null
            if (source.always) return <span className="text-xs text-muted-foreground">Sin interruptor: nunca termina en blanco.</span>
            if (!source.part) return null
            // En una línea que solo deja trabajo al equipo, su única parte se apaga con la línea.
            if (source.part === "team" && !line.hasAgent) return null
            const part = source.part
            const checked = part === "agent" ? line.agentPart : line.teamPart
            const label = part === "agent" ? `${receptionName} le escribe` : `Tarea para ${line.team}`
            const failed = parts.isError && parts.variables?.part === part
            return (
              <>
                <label className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium">
                  {checked ? "Prendido" : "Apagado"}
                  <Switch
                    checked={checked}
                    disabled={!editable || parts.isPending}
                    aria-label={label}
                    aria-describedby={failed ? `${uid}-parte-${part}-error` : undefined}
                    onCheckedChange={(next: boolean) => parts.mutate({ part, next })}
                  />
                </label>
                {failed ? (
                  <p id={`${uid}-parte-${part}-error`} role="alert" className="text-xs text-destructive">
                    {withReceptionName(submitErrorMessage(parts.error), receptionName)}
                  </p>
                ) : null}
              </>
            )
          }}
        />
        {line.noticeExample && line.agentPart ? (
          <p className="rounded-xl bg-muted px-3.5 py-3 text-sm">
            <span className="font-semibold">Así es el aviso cuando no puede:</span> «{line.noticeExample}»
          </p>
        ) : null}
      </section>

      {line.message && line.agentPart ? (
        <section aria-labelledby={`${uid}-mensaje`} className="flex flex-col gap-2">
          <h3 id={`${uid}-mensaje`} className="font-heading text-sm font-semibold">
            Lo que recibe la persona
          </h3>
          <div className="flex max-w-md flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
            <p>{line.message.text}</p>
            <div className="flex flex-wrap gap-2">
              {line.message.buttons.map((button) => (
                <span key={button} className="rounded-lg border px-2.5 py-1 text-xs font-semibold text-primary">
                  {button}
                </span>
              ))}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Con datos de ejemplo: los de verdad salen de la agenda y de la ficha al enviar. Sale por WhatsApp a quien lo aceptó; si no tiene, por correo.
            Al responder, la conversación sigue con {receptionName}.
          </p>
        </section>
      ) : null}

      {line.defaultDays !== null ? <DaysSetting line={line} editable={editable} /> : null}
      {line.delayHours !== null ? <DelaySetting line={line} editable={editable} /> : null}
      {line.teamPart ? <TaskNoteSetting line={line} editable={editable} /> : null}
      {line.hourAdjustable ? <HourSetting line={line} editable={editable} /> : null}

      <section aria-labelledby={`${uid}-personas`} className="flex flex-col gap-2">
        <h3 id={`${uid}-personas`} className="font-heading text-sm font-semibold">
          Qué pasó, persona por persona
        </h3>
        {unreachedOnly ? (
          <>
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              Solo las personas a las que no pudo escribirles.
              {onShowAll ? (
                <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={onShowAll}>
                  Ver a todas
                </Button>
              ) : null}
            </p>
            {unreached.isPending ? (
              <LoadingState kind="indeterminate" message="Cargando…" />
            ) : unreached.isError ? (
              <QueryErrorState error={unreached.error} onRetry={() => void unreached.refetch()} />
            ) : unreached.data.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Ya no queda nadie a quien no haya podido escribirle.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-xl border bg-card">
                {unreached.data.data.items.map((row) => (
                  <PersonRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </>
        ) : line.peopleTotal === 0 ? (
          <p className="text-sm text-muted-foreground">
            {line.enabled ? "Todavía nada: actúa sobre lo que ocurra desde que la prendiste." : "Nada todavía."}
          </p>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {rows.map((row) => (
                <PersonRow key={row.id} row={row} />
              ))}
            </ul>
            {!allPeople && line.peopleTotal > line.people.length ? (
              <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setAllPeople(true)}>
                Ver {line.peopleTotal > 200 ? "los últimos 200" : `los ${line.peopleTotal}`}
              </Button>
            ) : null}
            {allPeople && people.isPending ? <LoadingState kind="indeterminate" message="Cargando…" /> : null}
          </>
        )}
      </section>

      {line.changes.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Últimos cambios:</span>{" "}
          {line.changes.map((change) => `${change.by ?? "Alguien del equipo"} ${change.what} el ${day(change.at)}`).join(" · ")}.
        </p>
      ) : null}

      {line.custom && canWrite ? <DeleteAdminLine lineKey={line.key} name={line.trigger} /> : null}
    </div>
  )
}
