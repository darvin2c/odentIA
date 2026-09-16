import { Button, Field, FieldLabel, Input } from "@odentia/ui"
import { EmptyState, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { type AgentConfig, useCanWrite } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/agent")({
  component: AgentPage,
})

function AgentPage() {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const [saved, setSaved] = useState(false)

  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
  })

  const [form, setForm] = useState<AgentConfig | null>(null)
  const current = form ?? configQuery.data?.data ?? null

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<AgentConfig>) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setSaved(true)
      setForm(null)
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
    },
  })

  if (!canWrite) {
    return (
      <EmptyState title="Sin acceso" description="Solo owner/admin pueden configurar el agente." />
    )
  }
  if (!current) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>
  }

  const set = (patch: Partial<AgentConfig>) => {
    setSaved(false)
    setForm({ ...current, ...patch })
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agente"
        subtitle="Responde y cualifica automáticamente (sin agenda en esta etapa)"
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={current.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Agente habilitado
      </label>
      <Field>
        <FieldLabel>Modelo (vacío = el de `LLM_MODEL` del servidor)</FieldLabel>
        <Input
          value={current.model ?? ""}
          placeholder="openai:gpt-4o-mini"
          onChange={(e) => set({ model: e.target.value || null })}
        />
      </Field>
      <Field>
        <FieldLabel>Instrucciones extra de la clínica</FieldLabel>
        <textarea
          aria-label="Instrucciones extra"
          className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
          value={current.systemPrompt}
          onChange={(e) => set({ systemPrompt: e.target.value })}
          placeholder="Horarios, sedes, tono…"
        />
      </Field>
      <Field>
        <FieldLabel>Palabras de derivación (separadas por coma)</FieldLabel>
        <Input
          value={current.handoffKeywords.join(", ")}
          onChange={(e) =>
            set({
              handoffKeywords: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="humano, doctor, queja"
        />
      </Field>
      <Field>
        <FieldLabel>Máximo de turnos por conversación (1–50)</FieldLabel>
        <Input
          type="number"
          min={1}
          max={50}
          value={current.maxTurns}
          onChange={(e) => set({ maxTurns: Number(e.target.value) })}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          disabled={saveMutation.isPending || !form}
          onClick={() => form && saveMutation.mutate(form)}
        >
          Guardar
        </Button>
        {saved && <span className="text-sm text-green-700">Guardado.</span>}
      </div>
    </div>
  )
}
