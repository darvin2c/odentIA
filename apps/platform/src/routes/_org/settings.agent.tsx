import { Badge, Button, Checkbox, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
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
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type AgentConfig, type LlmConnectionTest, usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"

/** Borrador del formulario: la clave viaja solo si se escribe; null la borra. */
interface ConfigDraft extends AgentConfig {
  ownProvider: boolean
  llmApiKey?: string | null
}

function toDraft(config: AgentConfig): ConfigDraft {
  return { ...config, ownProvider: config.llmBaseUrl !== null }
}

/**
 * Solo viaja lo que cambió del proveedor: así guardar otro campo no vuelve
 * a validar la URL guardada, y la clave solo se envía si se escribió.
 */
function toPatch(draft: ConfigDraft, baseline: ConfigDraft | null): Partial<AgentConfig> & { llmApiKey?: string | null } {
  const { ownProvider, llmApiKey, llmBaseUrl, hasLlmApiKey: _has, organizationId: _org, ...rest } = draft
  if (!ownProvider) return baseline?.ownProvider === false ? rest : { ...rest, llmBaseUrl: null, llmApiKey: null }
  const urlChanged = llmBaseUrl !== (baseline?.ownProvider ? baseline.llmBaseUrl : null)
  return {
    ...rest,
    ...(urlChanged ? { llmBaseUrl } : {}),
    ...(llmApiKey ? { llmApiKey } : {}),
  }
}

/** Por qué no se puede guardar o probar todavía; null si está completo. */
function providerIssue(draft: ConfigDraft, baseline: ConfigDraft | null): string | null {
  if (!draft.ownProvider) return null
  if (!draft.llmBaseUrl) return "Indica la URL base del proveedor."
  if (!draft.model) return "Indica el modelo que espera ese proveedor."
  const urlChanged = draft.llmBaseUrl !== (baseline?.ownProvider ? baseline.llmBaseUrl : null)
  if (!draft.llmApiKey && (!draft.hasLlmApiKey || urlChanged)) {
    return urlChanged && draft.hasLlmApiKey
      ? "Al cambiar la URL vuelve a escribir la clave: la guardada no se envía a otro proveedor."
      : "Indica la clave de API del proveedor."
  }
  return null
}

function providerHost(baseUrl: string | null): string {
  if (!baseUrl) return "odentIA"
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export const Route = createFileRoute("/_org/settings/agent")({
  component: AgentPage,
})

function AgentPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("agent.write")
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const [policyDirty, setPolicyDirty] = useState(false)
  const [baseline, setBaseline] = useState<ConfigDraft | null>(null)

  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
  })

  // El detalle muestra lo guardado; el formulario edita una copia en memoria.
  const [form, setForm] = useState<ConfigDraft | null>(null)
  const config = configQuery.data?.data ?? null
  const current = form ?? (config ? toDraft(config) : null)
  const configDirty = formOpen && !sameDraft(form, baseline)

  const saveMutation = useMutation({
    mutationFn: (draft: ConfigDraft) =>
      apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify(toPatch(draft, baseline)) }),
    onSuccess: () => {
      setSaved(true)
      closeForm()
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
    },
  })
  const testMutation = useMutation({
    mutationFn: (draft: ConfigDraft) =>
      apiFetch<{ data: LlmConnectionTest }>("/api/agent/config/llm/test", {
        method: "POST",
        body: JSON.stringify({
          model: draft.model,
          llmBaseUrl: draft.ownProvider ? draft.llmBaseUrl : null,
          ...(draft.ownProvider && draft.llmApiKey ? { llmApiKey: draft.llmApiKey } : {}),
        }),
      }),
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

  const set = (patch: Partial<ConfigDraft>) => {
    setSaved(false)
    testMutation.reset()
    const next = { ...current, ...patch }
    // Una propiedad con undefined ensuciaría el borrador aunque no cambie nada.
    for (const key of Object.keys(next) as Array<keyof ConfigDraft>) {
      if (next[key] === undefined) delete next[key]
    }
    setForm(next)
  }
  const issue = providerIssue(current, baseline)

  const error =
    saveMutation.error instanceof ApiError
      ? (saveMutation.error.shape.message ?? "No pudimos guardar la configuración")
      : saveMutation.error
        ? "No pudimos guardar la configuración"
        : null

  function openForm() {
    if (!config) return
    setSaved(false)
    testMutation.reset()
    const draft = toDraft(config)
    setForm(draft)
    setBaseline(draft)
    setFormOpen(true)
  }

  /** Cierra y descarta el borrador: el detalle vuelve a lo guardado. */
  function closeForm() {
    setFormOpen(false)
    setForm(null)
    testMutation.reset()
  }

  const test = testMutation.data?.data ?? null
  const testError =
    testMutation.error instanceof ApiError
      ? (testMutation.error.shape.message ?? "No pudimos probar la conexión")
      : testMutation.error
        ? "No pudimos probar la conexión"
        : null

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
      <fieldset className="flex flex-col gap-4 rounded-sm border p-4">
        <legend className="px-1 text-sm font-medium">Proveedor del modelo</legend>
        <Field>
          <label htmlFor="agente-proveedor-propio" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id="agente-proveedor-propio"
              checked={current.ownProvider}
              onCheckedChange={(value) => set({ ownProvider: value === true })}
            />
            Usar la cuenta propia de la clínica
          </label>
          <FieldDescription>
            Sin marcar, el agente usa el proveedor de odentIA. Con cuenta propia, los mensajes de la clínica van a
            ese proveedor con su clave y su modelo.
          </FieldDescription>
        </Field>
        {current.ownProvider ? (
          <>
            <Field>
              <FieldLabel htmlFor="agente-url-base">URL base del proveedor</FieldLabel>
              <Input
                id="agente-url-base"
                type="url"
                value={current.llmBaseUrl ?? ""}
                placeholder="https://api.proveedor.com/v1"
                onChange={(e) => set({ llmBaseUrl: e.target.value || null })}
              />
              <FieldDescription>Endpoint compatible con OpenAI, con https. Incluye el prefijo que indique el proveedor (p. ej. /v1).</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="agente-clave">Clave de API</FieldLabel>
              <Input
                id="agente-clave"
                type="password"
                autoComplete="off"
                value={current.llmApiKey ?? ""}
                placeholder={current.hasLlmApiKey ? "Guardada · escribe una nueva para reemplazarla" : "sk-…"}
                onChange={(e) => set({ llmApiKey: e.target.value || undefined })}
              />
              <FieldDescription>Se guarda cifrada y no vuelve a mostrarse.</FieldDescription>
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor="agente-modelo">
            {current.ownProvider ? "Modelo" : "Modelo (vacío = el de odentIA)"}
          </FieldLabel>
          <Input
            id="agente-modelo"
            value={current.model ?? ""}
            placeholder="gpt-4o-mini"
            onChange={(e) => set({ model: e.target.value || null })}
          />
          <FieldDescription>El nombre tal como lo espera el proveedor; debe admitir llamadas a herramientas.</FieldDescription>
        </Field>
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testMutation.isPending || issue !== null}
              onClick={() => testMutation.mutate(current)}
            >
              {testMutation.isPending ? "Probando…" : "Probar conexión"}
            </Button>
          </div>
          {issue ? <FieldDescription>{issue}</FieldDescription> : null}
          {testError ? (
            <p role="alert" className="text-sm text-destructive">{testError}</p>
          ) : test?.ok ? (
            <p role="status" className="text-sm text-success">
              El proveedor respondió en {(test.latencyMs / 1000).toFixed(1)} s{test.model ? ` con ${test.model}` : ""}. No acredita calidad ni soporte de herramientas.
            </p>
          ) : test ? (
            <p role="alert" className="text-sm text-destructive">Sin conexión: {test.error}</p>
          ) : null}
        </div>
      </fieldset>
      <Field>
        <FieldLabel htmlFor="agente-decision">Modelo de decisión</FieldLabel>
        <select
          id="agente-decision"
          className="rounded-sm border p-2 text-sm"
          value={current.decisionProvider}
          onChange={(e) => set({ decisionProvider: e.target.value as AgentConfig["decisionProvider"] })}
        >
          {DECISION_PROVIDER_LABEL.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <FieldDescription>
          Un modelo pequeño y barato que decide antes de que escriba el otro: elige qué respuestas oficiales aplican y
          por dónde va el turno. Los proveedores externos reciben el último mensaje y dos anteriores del interlocutor,
          sin datos de su ficha.
        </FieldDescription>
      </Field>
      {current.decisionProvider !== "none" ? (
        <Field>
          <label htmlFor="agente-camino" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id="agente-camino"
              checked={current.decisionRoutingEnabled}
              onCheckedChange={(value) => set({ decisionRoutingEnabled: value === true })}
            />
            Elegir el camino antes de escribir
          </label>
          <FieldDescription>
            Si está seguro de que hace falta una persona, pasa el caso sin llamar al modelo que escribe; si es una
            pregunta de información o un saludo, le pide resolverlo en un solo paso. Apagado, solo elige conocimiento y
            su opinión sobre cada mensaje queda registrada sin efecto.
          </FieldDescription>
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="agente-tope">Tope diario de corridas con el modelo</FieldLabel>
        <Input
          id="agente-tope"
          type="number"
          min={1}
          max={100000}
          value={current.dailyRunLimit}
          onChange={(e) => set({ dailyRunLimit: Math.min(100_000, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
        />
        <FieldDescription>Al alcanzarlo, los casos pasan al equipo y se avisa a quien administra el agente.</FieldDescription>
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
      <Field>
        <label htmlFor="agente-comprobacion" className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id="agente-comprobacion"
            checked={current.replyCheckEnabled}
            onCheckedChange={(value) => set({ replyCheckEnabled: value === true })}
          />
          Comprobar precios, fechas y horas antes de enviar
        </label>
        <FieldDescription>
          Si una respuesta trae un precio, una fecha o una hora que no está en lo que el agente consultó, no sale: el
          agente lo corrige o pasa el caso a una persona. No revisa el resto del texto.
        </FieldDescription>
      </Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeForm,
    title: "Editar la configuración del agente",
    isDirty: configDirty,
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
      <PageDraftGuard dirty={configDirty || policyDirty} />
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
          <p role="status" className="text-sm text-success">
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
              <dt className="text-xs font-medium text-muted-foreground">Proveedor del modelo</dt>
              <dd className="text-sm">
                {config.llmBaseUrl ? `Cuenta propia · ${providerHost(config.llmBaseUrl)}` : "odentIA"}
                {config.llmBaseUrl ? (
                  <Badge variant={config.hasLlmApiKey ? "success" : "destructive"} className="ml-2">
                    {config.hasLlmApiKey ? "Clave guardada" : "Sin clave"}
                  </Badge>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Modelo</dt>
              <dd className="text-sm">{config.model ?? "El de odentIA"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Tope diario de corridas</dt>
              <dd className="text-sm">{config.dailyRunLimit}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Modelo de decisión</dt>
              <dd className="text-sm">
                {DECISION_PROVIDER_LABEL.find((item) => item.value === config.decisionProvider)?.label ?? config.decisionProvider}
                {config.decisionProvider !== "none" ? ` · ${config.decisionRoutingEnabled ? "elige el camino" : "sin elegir el camino"}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Máximo de turnos por conversación
              </dt>
              <dd className="text-sm">{config.maxTurns}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Comprobación de precios, fechas y horas
              </dt>
              <dd className="text-sm">{config.replyCheckEnabled ? "Encendida" : "Apagada"}</dd>
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
        <PolicySection onDirtyChange={setPolicyDirty} />
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

const DECISION_PROVIDER_LABEL: Array<{ value: AgentConfig["decisionProvider"]; label: string }> = [
  { value: "none", label: "Desactivado" },
  { value: "baseline", label: "Línea base (el mismo modelo de conversación)" },
  { value: "jev", label: "Jev (TypeSafe AI)" },
  { value: "openai_decisions", label: "OpenAI Decisions" },
]

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
function PolicySection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const queryClient = useQueryClient()
  const policyQuery = useQuery({
    queryKey: ["agent-policy"],
    queryFn: () => apiFetch<{ data: AutonomyPolicy }>("/api/agent/policy"),
  })
  const [draft, setDraft] = useState<AutonomyPolicy | null>(null)
  const policy = draft ?? policyQuery.data?.data ?? null
  const [baseline, setBaseline] = useState<AutonomyPolicy | null>(null)
  const dirty = draft !== null && !sameDraft(draft, baseline)
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const saveMutation = useMutation({
    mutationFn: (patch: AutonomyPolicy) =>
      apiFetch("/api/agent/policy", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (_result, submitted) => {
      setBaseline(submitted)
      queryClient.setQueryData(["agent-policy"], { data: submitted })
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
            onChange={(e) => {
              if (draft === null) setBaseline(policy)
              setDraft({ ...policy, [action.key]: e.target.value })
            }}
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
          disabled={!dirty || saveMutation.isPending}
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
