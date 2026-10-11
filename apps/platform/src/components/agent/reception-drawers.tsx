import { Checkbox, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import { type AgentFunction, clockToMinutes, minutesToClock } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
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
  }
}

/**
 * Límites de Recepción: cuándo pasa siempre a una persona, en qué canales
 * responde y a qué horas. Fuera de ellos el hilo queda para el equipo.
 */
export function LimitsDrawer({
  open,
  onClose,
  config,
  connectedChannels,
}: {
  open: boolean
  onClose: () => void
  config: AgentConfig
  connectedChannels: string[]
}) {
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
  const issue = !draft.allChannels && draft.channels.length === 0
    ? "Elige al menos un canal, o deja que responda en todos."
    : !draft.allDay && (from === null || from === until)
      ? "Indica una hora de inicio y una de fin distintas."
      : null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (issue || save.isPending) return
    save.mutate({
      handoffKeywords: draft.keywords
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      channels: draft.allChannels ? null : draft.channels,
      activeFromMin: draft.allDay ? null : from,
      activeUntilMin: draft.allDay ? null : until,
    })
  }

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title="Límites de Recepción"
      description="Fuera de estos límites no responde: la conversación queda para tu equipo."
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={!sameDraft(draft, baseline)}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      submitDisabled={issue !== null}
    >
      <div className="flex flex-col gap-5">
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
              <Input
                id="limites-desde"
                type="time"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="limites-hasta">Hasta</FieldLabel>
              <Input
                id="limites-hasta"
                type="time"
                value={draft.until}
                onChange={(event) => setDraft({ ...draft, until: event.target.value })}
              />
            </Field>
          </div>
        )}
        <FieldDescription>En la hora de tu clínica. Puede cruzar la medianoche (por ejemplo, de 20:00 a 08:00).</FieldDescription>
      </fieldset>
      {issue ? (
        <p role="status" className="text-sm text-muted-foreground">
          {issue}
        </p>
      ) : null}
      </div>
    </FormDrawer>
  )
}

/** Indicaciones de la clínica para Recepción: texto libre que el agente lee después de la base. */
export function InstructionsDrawer({
  open,
  onClose,
  config,
}: {
  open: boolean
  onClose: () => void
  config: AgentConfig
}) {
  const [text, setText] = useState(config.systemPrompt)
  useEffect(() => {
    if (open) setText(config.systemPrompt)
  }, [open, config.systemPrompt])
  const save = useSaveConfig(onClose)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending) save.mutate({ systemPrompt: text })
  }

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title="Indicaciones de tu clínica"
      description="Cómo quieres que atienda. Los datos concretos (precios, horarios, políticas) van en Conocimiento."
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={text !== config.systemPrompt}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel htmlFor="recepcion-indicaciones">Indicaciones</FieldLabel>
        <Textarea
          id="recepcion-indicaciones"
          rows={10}
          maxLength={8000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Si alguien llega con dolor, ofrece la primera cita disponible del día."
        />
        <FieldDescription>No pueden contradecir lo que fija odentIA: ante un choque, gana la base.</FieldDescription>
      </Field>
      </div>
    </FormDrawer>
  )
}
