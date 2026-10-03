import { Badge, Button, Checkbox, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import {
  EmptyState,
  FormDrawer,
  FormPanel,
  MasterDetail,
  PageHeader,
  useDetailMode,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type AgentConfig, usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/agent")({
  component: AgentPage,
})

function AgentPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("agent.write")
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
  })

  // El detalle muestra lo guardado; el formulario edita una copia en memoria.
  const [form, setForm] = useState<AgentConfig | null>(null)
  const config = configQuery.data?.data ?? null
  const current = form ?? config

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<AgentConfig>) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setSaved(true)
      closeForm()
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
    },
  })

  if (!canWrite) {
    return (
      <div>
        <EmptyState
          title="Sin acceso"
          description="Solo owner/admin pueden configurar el agente."
        />
      </div>
    )
  }
  if (!config || !current) {
    return (
      <div>
        <p className="p-4 text-sm text-muted-foreground">Cargando…</p>
      </div>
    )
  }

  const set = (patch: Partial<AgentConfig>) => {
    setSaved(false)
    setForm({ ...current, ...patch })
  }

  const error =
    saveMutation.error instanceof ApiError
      ? (saveMutation.error.shape.message ?? "No pudimos guardar la configuración")
      : saveMutation.error
        ? "No pudimos guardar la configuración"
        : null

  function openForm() {
    setSaved(false)
    setFormOpen(true)
  }

  /** Cierra y descarta el borrador: el detalle vuelve a lo guardado. */
  function closeForm() {
    setFormOpen(false)
    setForm(null)
  }

  const formFields = (
    <div className="flex flex-col gap-4">
      <Field>
        <label
          htmlFor="agente-habilitado"
          className="flex cursor-pointer items-center gap-2 text-sm"
        >
          <Checkbox
            id="agente-habilitado"
            checked={current.enabled}
            onCheckedChange={(value) => set({ enabled: value === true })}
          />
          Agente habilitado
        </label>
      </Field>
      <Field>
        <FieldLabel htmlFor="agente-modelo">
          Modelo (vacío = el de `LLM_MODEL` del servidor)
        </FieldLabel>
        <Input
          id="agente-modelo"
          value={current.model ?? ""}
          placeholder="openai:gpt-4o-mini"
          onChange={(e) => set({ model: e.target.value || null })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="agente-instrucciones">Instrucciones extra de la clínica</FieldLabel>
        <Textarea
          id="agente-instrucciones"
          value={current.systemPrompt}
          onChange={(e) => set({ systemPrompt: e.target.value })}
          placeholder="Horarios, sedes, tono…"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="agente-derivacion">
          Palabras de derivación (separadas por coma)
        </FieldLabel>
        <Input
          id="agente-derivacion"
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
        <FieldLabel htmlFor="agente-turnos">Máximo de turnos por conversación (1–50)</FieldLabel>
        <Input
          id="agente-turnos"
          type="number"
          min={1}
          max={50}
          value={current.maxTurns}
          onChange={(e) => set({ maxTurns: Number(e.target.value) })}
        />
      </Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeForm,
    title: "Editar la configuración del agente",
    isDirty: form !== null,
    isSubmitting: saveMutation.isPending,
    error,
    submitLabel: "Guardar",
    cancelLabel: "Cancelar",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      if (form) saveMutation.mutate(form)
    },
  }

  return (
    <div className="flex flex-col gap-6">
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Agente"
          subtitle="Responde, cualifica y propone citas con aprobación"
        />
        {saved ? (
          <p role="status" className="text-sm text-green-700">
            Guardado.
          </p>
        ) : null}
        <div className="flex flex-col gap-6 rounded-sm bg-card p-6">
          <div className="flex flex-row flex-wrap items-center justify-between gap-2">
            <div className="font-heading text-base font-medium">Configuración</div>
            <Button type="button" variant="outline" size="sm" onClick={openForm}>
              Editar
            </Button>
          </div>
          <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Estado</dt>
              <dd className="text-sm">
                <Badge variant={config.enabled ? "success" : "secondary"}>
                  {config.enabled ? "Habilitado" : "Deshabilitado"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Modelo</dt>
              <dd className="text-sm">{config.model ?? "El del servidor (LLM_MODEL)"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Máximo de turnos por conversación
              </dt>
              <dd className="text-sm">{config.maxTurns}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Palabras de derivación</dt>
              <dd className="text-sm">
                {config.handoffKeywords.length > 0 ? config.handoffKeywords.join(", ") : "—"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">
                Instrucciones extra de la clínica
              </dt>
              <dd className="whitespace-pre-wrap text-sm">{config.systemPrompt || "—"}</dd>
            </div>
          </dl>
        </div>
        <PolicySection />
        <div className="flex flex-col gap-3 rounded-sm bg-card p-6">
          <div className="font-heading text-base font-medium">Escrituras directas del agente</div>
          <p className="text-sm text-muted-foreground">
            Estas acciones escriben al momento, sin confirmación ni aprobación: son de bajo riesgo y
            reversibles desde la ficha del contacto. Quedan auditadas con origen «agente» y su
            repetición no duplica efectos.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {DIRECT_WRITES.map((item) => (
              <li key={item.name}>
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground"> — {item.scope}</span>
              </li>
            ))}
          </ul>
        </div>
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
    </div>
  )
}

const DIRECT_WRITES = [
  {
    name: "add_tags",
    scope: "agrega etiquetas al contacto de la conversación (máx. 10 por llamada, 40 caracteres); nunca las quita ni toca a otro contacto.",
  },
  {
    name: "update_contact",
    scope: "actualiza nombre visible y campos personalizados del contacto de la conversación; no cambia teléfono, email ni estado.",
  },
  {
    name: "create_task",
    scope: "crea una tarea de seguimiento (título de 200 caracteres, con vencimiento opcional) vinculada al contacto y la conversación.",
  },
] as const

const POLICY_ACTIONS = [
  { key: "reservar_cita", label: "Reservar cita" },
  { key: "reprogramar_cita", label: "Reprogramar cita" },
  { key: "cancelar_cita", label: "Cancelar cita" },
  { key: "enviar_mensaje", label: "Enviar mensaje" },
  { key: "mover_oportunidad", label: "Mover oportunidad" },
  { key: "crear_oportunidad", label: "Crear oportunidad" },
  { key: "actualizar_seguimiento", label: "Actualizar seguimiento" },
  { key: "cerrar_oportunidad", label: "Cerrar oportunidad" },
] as const

const MODE_LABEL: Record<string, string> = {
  directo: "Directo (ejecuta)",
  confirmar_usuario: "Confirmar con el paciente",
  aprobar_equipo: "Aprobar por el equipo",
}

type AutonomyPolicy = Record<string, string>

/** Política de autonomía por acción: cada acto confirma con el paciente o lo aprueba el equipo. */
function PolicySection() {
  const queryClient = useQueryClient()
  const policyQuery = useQuery({
    queryKey: ["agent-policy"],
    queryFn: () => apiFetch<{ data: AutonomyPolicy }>("/api/agent/policy"),
  })
  const [draft, setDraft] = useState<AutonomyPolicy | null>(null)
  const policy = draft ?? policyQuery.data?.data ?? null

  const saveMutation = useMutation({
    mutationFn: (patch: AutonomyPolicy) =>
      apiFetch("/api/agent/policy", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: ["agent-policy"] })
    },
  })

  if (!policy) {
    return (
      <div className="rounded-sm bg-card p-6">
        <p className="text-sm text-muted-foreground">Cargando política de autonomía…</p>
      </div>
    )
  }

  const error =
    saveMutation.error instanceof ApiError
      ? (saveMutation.error.shape.message ?? "No pudimos guardar la política")
      : saveMutation.error
        ? "No pudimos guardar la política"
        : null

  return (
    <div className="flex flex-col gap-4 rounded-sm bg-card p-6">
      <div className="font-heading text-base font-medium">Autonomía por acción</div>
      <p className="text-sm text-muted-foreground">
        Directo ejecuta al momento; confirmar pide un sí del paciente en el chat; aprobar lo revisa
        el equipo en Aprobaciones.
      </p>
      {POLICY_ACTIONS.map((action) => (
        <label key={action.key} className="flex flex-col gap-1 text-sm">
          {action.label}
          <select
            value={policy[action.key] ?? "directo"}
            onChange={(e) => setDraft({ ...policy, [action.key]: e.target.value })}
            className="rounded-sm border p-2"
          >
            {Object.entries(MODE_LABEL).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={draft === null || saveMutation.isPending}
          onClick={() => {
            if (draft) saveMutation.mutate(draft)
          }}
        >
          {saveMutation.isPending ? "Guardando…" : "Guardar política"}
        </Button>
      </div>
    </div>
  )
}
