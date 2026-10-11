import { Button, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Lock } from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { voicePreview } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import type { AgentConfig } from "../../lib/crm"
import { sameDraft } from "../../lib/page-draft-guard"
import { mutationErrorMessage } from "../../lib/query-error"

interface VoiceDraft {
  personaName: string
  treatment: "tu" | "usted"
  tone: "cercano" | "neutro" | "formal"
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

function toDraft(config: AgentConfig): VoiceDraft {
  return {
    personaName: config.personaName ?? "",
    treatment: config.treatment ?? "tu",
    tone: config.tone,
    about: config.about,
  }
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id={`voz-${label}`}>
        {label}
      </span>
      <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1.5" aria-labelledby={`voz-${label}`}>
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? "default" : "outline"}
            className="min-h-11 rounded-full sm:min-h-8"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </fieldset>
    </div>
  )
}

/**
 * La base: lo que odentIA fija para todos los agentes (no se cambia) y la voz
 * de la clínica (se edita aquí). Lo propio de cada agente va en su página.
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
  const [draft, setDraft] = useState<VoiceDraft>(() => toDraft(config))
  const [baseline, setBaseline] = useState<VoiceDraft>(() => toDraft(config))
  // Al abrir se parte de lo guardado: un borrador descartado no reaparece.
  useEffect(() => {
    if (!open) return
    const saved = toDraft(config)
    setDraft(saved)
    setBaseline(saved)
  }, [open, config])

  const save = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch("/api/agent/config", {
        method: "PUT",
        body: JSON.stringify({
          personaName: draft.personaName.trim() || null,
          treatment: draft.treatment,
          tone: draft.tone,
          about: draft.about,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      onClose()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending) save.mutate()
  }

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title="La base"
      description="Lo primero que lee cada agente. Es corta a propósito y la comparten todos."
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={!sameDraft(draft, baseline)}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel={canWrite ? "Cancelar" : "Cerrar"}
      hideSubmit={!canWrite}
    >
      <div className="flex flex-col gap-5">
      <section aria-labelledby="base-fija" className="flex flex-col gap-2 rounded-xl bg-muted/60 p-4">
        <h3 id="base-fija" className="flex items-center gap-1.5 text-sm font-semibold">
          <Lock className="size-4" aria-hidden /> Lo que fija odentIA
        </h3>
        <ul className="list-disc pl-5 text-sm">
          {principles.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">No se cambia: ninguna indicación ni lección puede contradecirlo.</p>
      </section>

      <section aria-labelledby="base-voz" className="flex flex-col gap-4">
        <h3 id="base-voz" className="text-sm font-semibold">
          La voz de tu clínica
        </h3>
        <Field>
          <FieldLabel htmlFor="base-nombre">Se presenta como</FieldLabel>
          <Input
            id="base-nombre"
            value={draft.personaName}
            maxLength={40}
            disabled={!canWrite}
            onChange={(event) => setDraft({ ...draft, personaName: event.target.value })}
            placeholder="Sofi"
          />
          <FieldDescription>Déjalo vacío si no quieres darle un nombre. Siempre dice que es un asistente virtual.</FieldDescription>
        </Field>
        <Choice
          label="Trato"
          options={TREATMENTS}
          value={draft.treatment}
          onChange={(treatment) => canWrite && setDraft({ ...draft, treatment })}
        />
        <Choice label="Tono" options={TONES} value={draft.tone} onChange={(tone) => canWrite && setDraft({ ...draft, tone })} />
        <Field>
          <FieldLabel htmlFor="base-quienes">Quiénes somos, en pocas líneas</FieldLabel>
          <Textarea
            id="base-quienes"
            rows={4}
            maxLength={600}
            value={draft.about}
            disabled={!canWrite}
            onChange={(event) => setDraft({ ...draft, about: event.target.value })}
            placeholder="Clínica familiar con dos sedes. Atendemos sin apuro y no presionamos para vender tratamientos."
          />
          <FieldDescription>Tres o cuatro líneas bastan. Los datos concretos van en Conocimiento.</FieldDescription>
        </Field>
        <div className="flex flex-col gap-1 rounded-xl border border-agent-border bg-agent-soft p-3">
          <span className="text-xs font-semibold text-primary-soft-foreground">Así sonaría</span>
          <p className="text-sm">
            «{voicePreview({ personaName: draft.personaName, treatment: draft.treatment, tone: draft.tone, clinicName })}»
          </p>
          <span className="text-xs text-muted-foreground">Es una muestra del estilo. La respuesta real la redacta el agente.</span>
        </div>
      </section>
      </div>
    </FormDrawer>
  )
}
