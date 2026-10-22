import { Checkbox, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { FormDrawer, TimeSelect } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import { type AgentFunction, clockToMinutes, minutesToClock } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { CLOSE_AFTER_HOURS_MAX, CLOSE_AFTER_HOURS_MIN, closeAfterHoursIssue } from "../../lib/conversation-state"
import type { AgentConfig } from "../../lib/crm"
import { sameDraft } from "../../lib/page-draft-guard"
import { mutationErrorMessage } from "../../lib/query-error"

/** Guarda una parte de la configuración y refresca lo que la muestra. */
function useSaveConfig(onSaved: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (patch: Partial<AgentConfig>) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
      onSaved()
    },
  })
}

/** Indicación de la clínica para una función: una nota corta que el agente lee junto a ella. */
export function FunctionNoteDrawer({
  fn,
  config,
  onClose,
}: {
  /** La función que se edita; null = cerrado. */
  fn: AgentFunction | null
  config: AgentConfig
  onClose: () => void
}) {
  const saved = fn ? (config.functionNotes[fn.id] ?? "") : ""
  const [note, setNote] = useState(saved)
  useEffect(() => {
    if (fn) setNote(saved)
  }, [fn, saved])
  const save = useSaveConfig(onClose)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!fn || save.isPending) return
    const next = { ...config.functionNotes }
    if (note.trim()) next[fn.id] = note.trim()
    else delete next[fn.id]
    save.mutate({ functionNotes: next })
  }

  return (
    <FormDrawer
      open={fn !== null}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title={fn ? `Indicación para «${fn.label}»` : "Indicación"}
      description="Una nota corta sobre cómo quieres que haga esto. No reemplaza lo que fija odentIA."
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={note !== saved}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel htmlFor="funcion-indicacion">Indicación</FieldLabel>
        <Textarea
          id="funcion-indicacion"
          rows={4}
          maxLength={300}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Ofrece primero las mañanas; las tardes se llenan rápido."
        />
        <FieldDescription>Hasta 300 caracteres. Déjala vacía para quitarla.</FieldDescription>
      </Field>
      </div>
    </FormDrawer>
  )
}

interface LimitsDraft {
  keywords: string
  allChannels: boolean
  channels: string[]
  allDay: boolean
  from: string
  until: string
  dailyRunLimit: string
  closeAfterHours: string
}

/** Qué parte de los límites se abre: cada fila de la página lleva a la suya; en teléfono, a todas. */
export type LimitsSection = "todo" | "pasa" | "horario" | "canales" | "tope" | "cierre"

/** El título de cada parte, con el nombre del agente de recepción de la clínica. */
function limitsTitle(section: LimitsSection, receptionName: string): string {
  const titles: Record<LimitsSection, string> = {
    todo: `Límites de ${receptionName}`,
    pasa: "Pasa a una persona cuando",
    horario: `Horario de ${receptionName}`,
    canales: `Canales de ${receptionName}`,
    tope: `Tope diario de ${receptionName}`,
    cierre: "Cerrar si el paciente no responde",
  }
  return titles[section]
}

function toLimits(config: AgentConfig): LimitsDraft {
  const hasHours = config.activeFromMin !== null && config.activeUntilMin !== null
  return {
    keywords: config.handoffKeywords.join(", "),
    allChannels: config.channels === null,
    channels: config.channels ?? [],
    allDay: !hasHours,
    from: hasHours ? minutesToClock(config.activeFromMin ?? 0) : "08:00",
    until: hasHours ? minutesToClock(config.activeUntilMin ?? 0) : "20:00",
    dailyRunLimit: String(config.dailyRunLimit),
    closeAfterHours: String(config.closeAfterHours),
  }
}

/**
 * Límites de Sofi: cuándo pasa siempre a una persona, en qué canales
 * responde, a qué horas y cuántas respuestas da al día. Fuera de ellos el hilo
 * queda para el equipo. `section` enseña solo la parte que se pidió; se guarda
 * solo lo que se ve.
 */
export function LimitsDrawer({
  section,
  onClose,
  config,
  connectedChannels,
}: {
  /** La parte que se edita; null = cerrado. */
  section: LimitsSection | null
  onClose: () => void
  config: AgentConfig
  connectedChannels: string[]
}) {
  const open = section !== null
  const receptionName = useReceptionName()
  // Al cerrar se conserva la última parte para que el contenido no cambie mientras sale.
  const [shown, setShown] = useState<LimitsSection>(section ?? "todo")
  useEffect(() => {
    if (section) setShown(section)
  }, [section])
  const has = (part: Exclude<LimitsSection, "todo">) => shown === "todo" || shown === part
  const [draft, setDraft] = useState<LimitsDraft>(() => toLimits(config))
  const [baseline, setBaseline] = useState<LimitsDraft>(() => toLimits(config))
  useEffect(() => {
    if (!open) return
    const saved = toLimits(config)
    setDraft(saved)
    setBaseline(saved)
  }, [open, config])
  const save = useSaveConfig(onClose)

  // Un canal elegido que ya no está conectado sigue visible para poder quitarlo.
  const options = [...new Set([...connectedChannels, ...draft.channels])]
  const from = clockToMinutes(draft.from)
  // «00:00» como fin significa el final del día.
  const until = clockToMinutes(draft.until) || 1440
  const limit = /^[0-9]+$/.test(draft.dailyRunLimit.trim()) ? Number(draft.dailyRunLimit.trim()) : Number.NaN
  const issue = has("canales") && !draft.allChannels && draft.channels.length === 0
    ? "Elige al menos un canal, o deja que responda en todos."
    : has("horario") && !draft.allDay && (from === null || from === until)
      ? "Indica una hora de inicio y una de fin distintas."
      : has("tope") && !(limit >= 1 && limit <= 100_000)
        ? "El tope diario va de 1 a 100 000 respuestas."
        : has("cierre")
          ? closeAfterHoursIssue(draft.closeAfterHours)
          : null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (issue || save.isPending) return
    save.mutate({
      ...(has("pasa")
        ? {
            handoffKeywords: draft.keywords
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
      ...(has("canales") ? { channels: draft.allChannels ? null : draft.channels } : {}),
      ...(has("horario") ? { activeFromMin: draft.allDay ? null : from, activeUntilMin: draft.allDay ? null : until } : {}),
      ...(has("tope") ? { dailyRunLimit: limit } : {}),
      ...(has("cierre") ? { closeAfterHours: Number(draft.closeAfterHours.trim()) } : {}),
    })
  }

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title={limitsTitle(shown, receptionName)}
      description={
        shown === "pasa"
          ? "Además de cuando duda, no tiene el dato o le piden hablar con alguien."
          : shown === "cierre"
            ? `Si el paciente deja de responder, ${receptionName} se despide y cierra la conversación. Si vuelve a escribir, se abre otra vez.`
            : "Fuera de estos límites no responde: la conversación queda para tu equipo."
      }
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={!sameDraft(draft, baseline)}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      submitDisabled={issue !== null}
    >
      <div className="flex flex-col gap-5">
      {has("pasa") ? (
      <Field>
        <FieldLabel htmlFor="limites-temas">Pasa siempre a una persona si mencionan</FieldLabel>
        <Input
          id="limites-temas"
          value={draft.keywords}
          onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
          placeholder="queja, reclamo, urgencia"
        />
        <FieldDescription>Palabras separadas por coma. Además pasa el caso cuando duda o se lo piden.</FieldDescription>
      </Field>
      ) : null}

      {has("canales") ? (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">En qué canales responde</legend>
        <label htmlFor="limites-todos-canales" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
          <Checkbox
            id="limites-todos-canales"
            checked={draft.allChannels}
            onCheckedChange={(value) => setDraft({ ...draft, allChannels: value === true })}
          />
          En todos los canales conectados
        </label>
        {draft.allChannels ? null : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay ningún canal conectado.</p>
        ) : (
          options.map((channel) => (
            <label
              key={channel}
              htmlFor={`limites-canal-${channel}`}
              className="flex min-h-11 cursor-pointer items-center gap-2 pl-6 text-sm sm:min-h-8"
            >
              <Checkbox
                id={`limites-canal-${channel}`}
                checked={draft.channels.includes(channel)}
                onCheckedChange={(value) =>
                  setDraft({
                    ...draft,
                    channels:
                      value === true
                        ? [...draft.channels, channel]
                        : draft.channels.filter((item) => item !== channel),
                  })
                }
              />
              {channelLabel(channel)}
              {connectedChannels.includes(channel) ? null : <span className="text-muted-foreground">(sin conectar)</span>}
            </label>
          ))
        )}
      </fieldset>
      ) : null}

      {has("horario") ? (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">A qué horas responde</legend>
        <label htmlFor="limites-todo-el-dia" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
          <Checkbox
            id="limites-todo-el-dia"
            checked={draft.allDay}
            onCheckedChange={(value) => setDraft({ ...draft, allDay: value === true })}
          />
          A toda hora
        </label>
        {draft.allDay ? null : (
          <div className="grid grid-cols-2 gap-3 pl-6">
            <Field>
              <FieldLabel htmlFor="limites-desde">Desde</FieldLabel>
              <TimeSelect
                id="limites-desde"
                className="w-full"
                value={draft.from}
                onChange={(from) => setDraft({ ...draft, from })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="limites-hasta">Hasta</FieldLabel>
              <TimeSelect
                id="limites-hasta"
                className="w-full"
                value={draft.until}
                onChange={(until) => setDraft({ ...draft, until })}
              />
            </Field>
          </div>
        )}
        <FieldDescription>En la hora de tu clínica. Puede cruzar la medianoche (por ejemplo, de 20:00 a 08:00).</FieldDescription>
      </fieldset>
      ) : null}

      {has("tope") ? (
      <Field>
        <FieldLabel htmlFor="limites-tope">Tope diario de respuestas</FieldLabel>
        <Input
          id="limites-tope"
          inputMode="numeric"
          value={draft.dailyRunLimit}
          onChange={(event) => setDraft({ ...draft, dailyRunLimit: event.target.value })}
        />
        <FieldDescription>
          Cada mensaje que atiende con el modelo cuenta una. Al llegar al tope deja de responder ese día y pasa los casos a tu equipo.
        </FieldDescription>
      </Field>
      ) : null}
      {has("cierre") ? (
      <Field>
        <FieldLabel htmlFor="limites-cierre">Cerrar la conversación si el paciente no responde</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id="limites-cierre"
            type="number"
            inputMode="numeric"
            min={CLOSE_AFTER_HOURS_MIN}
            max={CLOSE_AFTER_HOURS_MAX}
            step={1}
            className="w-24"
            aria-describedby="limites-cierre-ayuda"
            value={draft.closeAfterHours}
            onChange={(event) => setDraft({ ...draft, closeAfterHours: event.target.value })}
          />
          <span className="text-sm text-muted-foreground">horas</span>
        </div>
        <FieldDescription id="limites-cierre-ayuda">
          Entre 6 y 23 horas. Antes de cerrar, {receptionName} se despide dentro del horario para escribir. Más de 23 no se puede: WhatsApp ya no deja escribirle.
        </FieldDescription>
      </Field>
      ) : null}
      {issue ? (
        <p role="status" className="text-sm text-muted-foreground">
          {issue}
        </p>
      ) : null}
      </div>
    </FormDrawer>
  )
}
