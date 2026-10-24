import { Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import type { AgentFunction } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
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
  closeAfterHours: string
}

/** Qué parte de los límites se abre: cada fila de la página lleva a la suya; en teléfono, a todas. */
export type LimitsSection = "todo" | "pasa" | "cierre"

/** El título de cada parte, con el nombre del agente de recepción de la clínica. */
function limitsTitle(section: LimitsSection, receptionName: string): string {
  const titles: Record<LimitsSection, string> = {
    todo: `Límites de ${receptionName}`,
    pasa: "Pasa a una persona cuando",
    cierre: "Cerrar si el paciente no responde",
  }
  return titles[section]
}

function toLimits(config: AgentConfig): LimitsDraft {
  return {
    keywords: config.handoffKeywords.join(", "),
    closeAfterHours: String(config.closeAfterHours),
  }
}

/**
 * Límites de Sofi: cuándo pasa siempre a una persona y cuándo cierra.
 * Responde siempre, a toda hora y en todos los canales (ADR 0084), sin tope de
 * respuestas: el único límite es el presupuesto del mes (ADR 0085). `section` enseña solo la
 * parte que se pidió; se guarda solo lo que se ve.
 */
export function LimitsDrawer({
  section,
  onClose,
  config,
}: {
  /** La parte que se edita; null = cerrado. */
  section: LimitsSection | null
  onClose: () => void
  config: AgentConfig
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

  const issue = has("cierre") ? closeAfterHoursIssue(draft.closeAfterHours) : null

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
            : "Cuándo pasa a una persona y cuándo cierra la conversación."
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
          Entre 6 y 23 horas. Antes de cerrar, {receptionName} se despide dentro del horario de recontacto. Más de 23 no se puede: WhatsApp ya no deja escribirle.
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
