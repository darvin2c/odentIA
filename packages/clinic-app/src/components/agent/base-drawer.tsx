import { Badge } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Lock } from "lucide-react"
import { useEffect, useRef } from "react"
import { z } from "zod"
import { voicePreview } from "../../lib/agent"
import { ADMIN_NAME, CLINICAL_NAME, RECEPTION_DEFAULT_NAME, useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import type { AgentConfig } from "../../lib/crm"
import { appWords } from "../../lib/product-words"
import { ChoiceButtons } from "../choice-buttons"

interface VoiceDraft {
  personaName: string
  treatment: "tu" | "usted"
  tone: "cercano" | "neutro" | "formal"
  emojis: "no" | "pocos"
  about: string
}

const TREATMENTS: Array<{ value: VoiceDraft["treatment"]; label: string }> = [
  { value: "tu", label: "De tú" },
  { value: "usted", label: "De usted" },
]
const TONES: Array<{ value: VoiceDraft["tone"]; label: string }> = [
  { value: "cercano", label: "Cercano" },
  { value: "neutro", label: "Neutro" },
  { value: "formal", label: "Formal" },
]
/** Qué quiere decir cada tono, en una línea bajo las opciones. */
const TONE_HINT: Record<VoiceDraft["tone"], string> = {
  cercano: "Amable y con confianza, como habla tu recepción.",
  neutro: "Amable y directo, sin confianzas ni formalidades.",
  formal: "Respetuoso y cuidado, sin confianzas.",
}
const PERSONA_NAME_MAX = "El nombre puede tener como mucho 40 caracteres."
const ABOUT_MAX = "Escribe como mucho 600 caracteres."

const EMOJIS: Array<{ value: VoiceDraft["emojis"]; label: string }> = [
  { value: "no", label: "No usar" },
  { value: "pocos", label: "Pocos" },
]

function toDraft(config: AgentConfig): VoiceDraft {
  return {
    personaName: config.personaName ?? "",
    treatment: config.treatment ?? "tu",
    tone: config.tone,
    emojis: config.emojis,
    about: config.about,
  }
}

/** Los mismos topes que `putInput` de `/api/agent/config`. */
const voiceSchema = z.object({
  personaName: z.string().max(40, PERSONA_NAME_MAX),
  treatment: z.enum(["tu", "usted"]),
  tone: z.enum(["cercano", "neutro", "formal"]),
  emojis: z.enum(["no", "pocos"]),
  about: z.string().max(600, ABOUT_MAX),
})

/**
 * La base: lo que odentIA fija para todos los agentes (no se cambia) y la voz
 * de la clínica (se edita aquí). Lo propio de cada agente va en su página.
 *
 * Guardar no prueba nada con el modelo: el servidor todavía no sabe responder
 * los casos de prueba con una voz sin guardar, así que la pantalla no lo promete.
 */
export function AgentBaseDrawer({
  open,
  onClose,
  config,
  principles,
  clinicName,
  canWrite,
}: {
  open: boolean
  onClose: () => void
  config: AgentConfig
  principles: string[]
  clinicName: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const save = useMutation({
    retry: false,
    mutationFn: (draft: VoiceDraft) =>
      apiFetch("/api/agent/config", {
        method: "PUT",
        body: JSON.stringify({
          // Vacío vale Sofi: el servidor guarda su nombre por defecto.
          personaName: draft.personaName.trim() || null,
          treatment: draft.treatment,
          tone: draft.tone,
          emojis: draft.emojis,
          about: draft.about,
        }),
      }),
  })
  const form = useAppForm({
    defaultValues: toDraft(config),
    validators: { onSubmit: voiceSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      // El nombre de recepción viaja con los datos de la clínica: todas las pantallas lo dicen.
      void queryClient.invalidateQueries({ queryKey: ["org-profile"] })
      onClose()
    },
  })
  // Al abrir se parte de lo guardado: un borrador descartado no reaparece, y
  // un refresco de la configuración con el cajón abierto no pisa lo escrito.
  const latest = useRef(config)
  latest.current = config
  useEffect(() => {
    if (open) form.reset(toDraft(latest.current))
  }, [open, form])
  const surface = useFormSurface(form)
  const draft = useStore(form.store, (state) => state.values)

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title="La base"
      submitLabel="Guardar"
      cancelLabel={canWrite ? "Cancelar" : "Cerrar"}
      hideSubmit={!canWrite}
    >
      <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-lg font-semibold">Quién es y cómo decide</h3>
        <p className="text-sm text-muted-foreground">
          Lo primero que lee cada agente. Es corta a propósito, la comparten todos y ninguna indicación ni lección la puede contradecir.
        </p>
      </div>

      <section aria-labelledby="base-fija" className="flex flex-col gap-2 rounded-xl bg-muted/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id="base-fija" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">
            <Lock className="size-4 shrink-0" aria-hidden /> Lo que fija {appWords().name}
          </h4>
          <Badge variant="secondary">No se cambia</Badge>
        </div>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          {principles.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="base-voz" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id="base-voz" className="min-w-0 flex-1 text-sm font-semibold">
            La voz de tu clínica
          </h4>
          {canWrite ? <Badge variant="outline">La editas tú</Badge> : null}
        </div>
        <form.AppField name="personaName">
          {(field) => (
            <field.TextField
              id="base-nombre"
              label="Se presenta como"
              maxLength={40}
              disabled={!canWrite}
              placeholder={RECEPTION_DEFAULT_NAME}
              description={`El nombre de tu agente de recepción. Si lo dejas vacío, se llama ${RECEPTION_DEFAULT_NAME}. Siempre dice que es un asistente virtual.`}
            />
          )}
        </form.AppField>
        <form.AppField name="treatment">
          {(field) => (
            <field.Group id="voz-trato" legend="Trato">
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  options={TREATMENTS}
                  value={field.state.value}
                  disabled={!canWrite}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="tone">
          {(field) => (
            <field.Group id="voz-tono" legend="Tono" description={TONE_HINT[field.state.value]}>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  options={TONES}
                  value={field.state.value}
                  disabled={!canWrite}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="emojis">
          {(field) => (
            <field.Group
              id="voz-emojis"
              legend="Emojis"
              description="Uno de vez en cuando hace el mensaje más cálido. Nunca en urgencias, dolor ni pagos."
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  options={EMOJIS}
                  value={field.state.value}
                  disabled={!canWrite}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="about">
          {(field) => (
            <field.TextareaField
              id="base-quienes"
              label="Quiénes somos, en pocas líneas"
              rows={4}
              maxLength={600}
              disabled={!canWrite}
              placeholder="Clínica familiar con dos sedes. Atendemos sin apuro y no presionamos para vender tratamientos."
              description="Tres o cuatro líneas bastan. Los datos concretos van en Conocimiento."
            />
          )}
        </form.AppField>
        <div className="flex flex-col gap-1 rounded-xl border border-agent-border bg-agent-soft p-3">
          <span className="text-xs font-semibold text-primary-soft-foreground">Así sonaría</span>
          <p className="text-sm">
            «{voicePreview({ personaName: draft.personaName, treatment: draft.treatment, tone: draft.tone, emojis: draft.emojis, clinicName })}»
          </p>
          <span className="text-xs text-muted-foreground">Es una muestra del estilo. La respuesta real la redacta el agente.</span>
        </div>
      </section>

      <section aria-labelledby="base-encima" className="flex flex-col gap-1 rounded-xl border p-4">
        <h4 id="base-encima" className="text-sm font-semibold">
          Encima de la base, cada agente suma lo suyo
        </h4>
        <p className="text-sm text-muted-foreground">
          {receptionName}, {CLINICAL_NAME} y {ADMIN_NAME} tienen sus propias funciones y las reglas que aprendieron de tus correcciones. Eso no se
          mezcla entre ellos.
        </p>
      </section>
      </div>
    </FormDrawer>
  )
}
