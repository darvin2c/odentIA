import { Input } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import type { AgentFunction } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { CLOSE_AFTER_HOURS_MAX, CLOSE_AFTER_HOURS_MIN, closeAfterHoursIssue } from "../../lib/conversation-state"
import type { AgentConfig } from "../../lib/crm"
import { appWords } from "../../lib/product-words"

/** Los topes de `putInput` de `/api/agent/config`, con las mismas palabras. */
const NOTE_MAX = 300
const KEYWORDS_MAX = 30
const KEYWORD_LENGTH_MAX = 60
const KEYWORDS_TOO_MANY = `Escribe como mucho ${KEYWORDS_MAX} palabras clave.`
const KEYWORD_TOO_LONG = `Cada palabra clave puede tener como mucho ${KEYWORD_LENGTH_MAX} caracteres.`

const noteSchema = z.object({ note: z.string().max(NOTE_MAX) })

/** Las palabras clave tal como se guardan: separadas por coma, sin vacías. */
function splitKeywords(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Solo se valida lo que el cajón enseña: lo oculto no se envía. */
function limitsSchema(keywords: boolean, close: boolean) {
  return z
    .object({ keywords: z.string(), closeAfterHours: z.string() })
    .superRefine((value, ctx) => {
      if (keywords) {
        const list = splitKeywords(value.keywords)
        const long = list.find((item) => item.length > KEYWORD_LENGTH_MAX)
        if (list.length > KEYWORDS_MAX) ctx.addIssue({ code: "custom", path: ["keywords"], message: KEYWORDS_TOO_MANY })
        else if (long) ctx.addIssue({ code: "custom", path: ["keywords"], message: `«${long.slice(0, 20)}…»: ${KEYWORD_TOO_LONG}` })
      }
      if (close) {
        const issue = closeAfterHoursIssue(value.closeAfterHours)
        if (issue) ctx.addIssue({ code: "custom", path: ["closeAfterHours"], message: issue })
      }
    })
}

/** Guarda una parte de la configuración y refresca lo que la muestra. */
function useSaveConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (patch: Partial<AgentConfig>) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
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
  const save = useSaveConfig()
  const form = useAppForm({
    defaultValues: { note: "" },
    validators: { onSubmit: noteSchema },
    onSubmit: async ({ value }) => {
      if (!fn) return
      const next = { ...config.functionNotes }
      if (value.note.trim()) next[fn.id] = value.note.trim()
      else delete next[fn.id]
      await save.mutateAsync({ functionNotes: next })
      onClose()
    },
  })
  // Al abrir se parte de lo guardado; un refresco con el cajón abierto no pisa lo escrito.
  const saved = fn ? (config.functionNotes[fn.id] ?? "") : ""
  const latest = useRef(saved)
  latest.current = saved
  useEffect(() => {
    if (fn) form.reset({ note: latest.current })
  }, [fn, form])
  // La API señala la nota por su función (`functionNotes.<id>`).
  const surface = useFormSurface(form, {
    fieldMap: (key) => (key.startsWith("functionNotes") ? "note" : undefined),
  })

  return (
    <FormDrawer
      {...surface}
      open={fn !== null}
      onClose={onClose}
      title={fn ? `Indicación para «${fn.label}»` : "Indicación"}
      description={`Una nota corta sobre cómo quieres que haga esto. No reemplaza lo que fija ${appWords().name}.`}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="note">
          {(field) => (
            <field.TextareaField
              id="funcion-indicacion"
              label="Indicación"
              rows={4}
              maxLength={NOTE_MAX}
              placeholder="Ofrece primero las mañanas; las tardes se llenan rápido."
              description="Hasta 300 caracteres. Déjala vacía para quitarla."
            />
          )}
        </form.AppField>
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
  const save = useSaveConfig()
  const form = useAppForm({
    defaultValues: toLimits(config),
    validators: { onSubmit: limitsSchema(has("pasa"), has("cierre")) },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        ...(has("pasa") ? { handoffKeywords: splitKeywords(value.keywords) } : {}),
        ...(has("cierre") ? { closeAfterHours: Number(value.closeAfterHours.trim()) } : {}),
      })
      onClose()
    },
  })
  // Al abrir se parte de lo guardado; un refresco con el cajón abierto no pisa lo escrito.
  const latest = useRef(config)
  latest.current = config
  useEffect(() => {
    if (open) form.reset(toLimits(latest.current))
  }, [open, form])
  // La API señala la lista entera o una palabra (`handoffKeywords[3]`): las dos van al mismo campo.
  const surface = useFormSurface(form, {
    fieldMap: (key) => (key.startsWith("handoffKeywords") ? "keywords" : undefined),
  })

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title={limitsTitle(shown, receptionName)}
      description={
        shown === "pasa"
          ? "Además de cuando duda, no tiene el dato o le piden hablar con alguien."
          : shown === "cierre"
            ? `Si el paciente deja de responder, ${receptionName} se despide y cierra la conversación. Si vuelve a escribir, se abre otra vez.`
            : "Cuándo pasa a una persona y cuándo cierra la conversación."
      }
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <div className="flex flex-col gap-5">
      {has("pasa") ? (
        <form.AppField name="keywords">
          {(field) => (
            <field.TextField
              id="limites-temas"
              label="Pasa siempre a una persona si mencionan"
              placeholder="queja, reclamo, urgencia"
              description="Palabras separadas por coma. Además pasa el caso cuando duda o se lo piden."
            />
          )}
        </form.AppField>
      ) : null}

      {has("cierre") ? (
        <form.AppField name="closeAfterHours">
          {(field) => (
            <field.Control
              id="limites-cierre"
              label="Cerrar la conversación si el paciente no responde"
              description={`Entre 6 y 23 horas. Antes de cerrar, ${receptionName} se despide dentro del horario de recontacto. Más de 23 no se puede: WhatsApp ya no deja escribirle.`}
            >
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input
                    {...control.props}
                    type="number"
                    inputMode="numeric"
                    min={CLOSE_AFTER_HOURS_MIN}
                    max={CLOSE_AFTER_HOURS_MAX}
                    step={1}
                    className="w-24"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <span className="text-sm text-muted-foreground">horas</span>
                </div>
              )}
            </field.Control>
          )}
        </form.AppField>
      ) : null}
      </div>
    </FormDrawer>
  )
}
