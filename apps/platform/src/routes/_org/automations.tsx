import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  common,
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  PageHeader,
  PageShell,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { usePageDraftGuard } from "../../lib/page-draft-guard"
import { activeOrgLocale } from "../../lib/locale"

export const Route = createFileRoute("/_org/automations")({
  component: AutomationsPage,
})

interface AutomationRule {
  id: string
  name: string
  kind: string
  channel: string
  enabled: boolean
  templateName: string | null
  templateLanguage: string
  config: {
    hoursBefore?: number[]
    delayHours?: number
    inactiveDays?: number
    quietStart?: string
    quietEnd?: string
    segment?: { tags?: string[]; opportunityStageIds?: string[] }
    startsAt?: string
    endsAt?: string
  }
}

interface AutomationJob {
  id: string
  kind: string
  channel: string
  status: string
  dedupeKey: string
  scheduledFor: string
  attempts: number
  lastError: string | null
}

interface ConsentRow {
  purpose: string
  channel: string
  status: string
}

interface ContactHit {
  id: string
  displayName: string
}

const KIND_LABELS: Record<string, string> = {
  recordatorio_cita: "Recordatorio de cita",
  seguimiento_presupuesto: "Seguimiento de presupuesto",
  seguimiento_cita: "Seguimiento de cita",
  seguimiento_no_asistencia: "Seguimiento de no asistencia",
  recuperacion_inactivo: "Recuperación de inactivos",
  recordatorio_control: "Recordatorio de control",
  campana: "Campaña",
}

const JOB_STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  enviado: "Enviado",
  fallido: "Fallido",
  cancelado: "Cancelado",
  omitido: "Omitido",
}

type Tab = "reglas" | "resultados" | "campanas" | "consentimientos"

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? (error.shape.message ?? error.message) : String(error)
}

function describeSegment(segment: AutomationRule["config"]["segment"]): string {
  const parts: string[] = []
  if (segment?.tags?.length) parts.push(segment.tags.join(", "))
  if (segment?.opportunityStageIds?.length) {
    parts.push(
      segment.opportunityStageIds.length === 1 ? "1 etapa" : `${segment.opportunityStageIds.length} etapas`,
    )
  }
  return parts.length ? parts.join(" + ") : "todos los contactos"
}

function AutomationsPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("crm.write")
  const listSearch = useListSearch()
  // El backend filtra por `status`; en la URL el filtro vive como `estado`.
  const jobStatus = listSearch.get("estado") ?? "pendiente"
  const [tab, setTab] = useState<Tab>("reglas")
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AutomationRule | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [campaignDirty, setCampaignDirty] = useState(false)
  const draftGuard = usePageDraftGuard(campaignDirty)

  const rulesQuery = useQuery({
    queryKey: ["automation-rules"],
    queryFn: () => apiFetch<{ data: AutomationRule[] }>("/api/automations/rules"),
  })
  const jobsQuery = useQuery({
    queryKey: ["automation-jobs", jobStatus],
    queryFn: () =>
      apiFetch<{ data: AutomationJob[] }>(`/api/automations/jobs?status=${jobStatus}&limit=100`),
    enabled: tab === "resultados",
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["automation-rules"] })
    void queryClient.invalidateQueries({ queryKey: ["automation-jobs"] })
  }

  const toggleMutation = useMutation({
    mutationFn: (rule: AutomationRule) =>
      apiFetch(`/api/automations/rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !rule.enabled }),
      }),
    onSuccess: () => void invalidate(),
  })

  const jobActionMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/automations/jobs/${id}/cancel`, { method: "POST" }),
    onSuccess: () => void invalidate(),
  })

  const rules = rulesQuery.data?.data ?? []
  const campaigns = rules.filter((r) => r.kind === "campana")
  const jobs = jobsQuery.data?.data ?? []

  const ruleColumns = useMemo<ColumnDef<AutomationRule>[]>(
    () => [
      { accessorKey: "name", header: "Regla" },
      {
        accessorKey: "kind",
        header: "Tipo",
        cell: ({ row }) => KIND_LABELS[row.original.kind] ?? row.original.kind,
      },
      { accessorKey: "channel", header: "Canal" },
      {
        id: "estado",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.enabled ? "success" : "secondary"}>
            {row.original.enabled ? "Activa" : "Pausada"}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const rule = row.original
          if (!canWrite) return null
          return (
            <RowActions
              label={`Acciones de ${rule.name}`}
              items={[
                {
                  key: "toggle",
                  label: rule.enabled ? "Pausar" : "Activar",
                  disabled: toggleMutation.isPending,
                  onSelect: () => toggleMutation.mutate(rule),
                },
                {
                  key: "edit",
                  label: "Editar",
                  onSelect: () => {
                    setEditing(rule)
                    setFormError(null)
                    setFormOpen(true)
                  },
                },
              ]}
            />
          )
        },
      },
    ],
    [canWrite, toggleMutation],
  )
  const rulesTable = useReactTable({ data: rules, columns: ruleColumns, getCoreRowModel: getCoreRowModel() })

  const jobColumns = useMemo<ColumnDef<AutomationJob>[]>(
    () => [
      {
        accessorKey: "kind",
        header: "Tipo",
        cell: ({ row }) => KIND_LABELS[row.original.kind] ?? row.original.kind,
      },
      {
        accessorKey: "scheduledFor",
        header: "Programado",
        cell: ({ row }) =>
          new Date(row.original.scheduledFor).toLocaleString(activeOrgLocale(), {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.status === "enviado" ? "success" : "secondary"}>
            {JOB_STATUS_LABELS[row.original.status] ?? row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: "lastError",
        header: "Detalle",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.lastError ?? "—"}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const job = row.original
          if (!canWrite || job.status !== "pendiente") return null
          return (
            <RowActions
              label={`Acciones del trabajo ${job.id}`}
              items={[
                {
                  key: "cancel",
                  label: "Cancelar",
                  disabled: jobActionMutation.isPending,
                  onSelect: () => jobActionMutation.mutate(job.id),
                },
              ]}
            />
          )
        },
      },
    ],
    [canWrite, jobActionMutation],
  )
  const jobsTable = useReactTable({ data: jobs, columns: jobColumns, getCoreRowModel: getCoreRowModel() })

  return (
    <PageShell className="flex flex-col gap-6">
      {draftGuard.dialog}
      <PageHeader
        title="Automatizaciones"
        subtitle="Recordatorios, seguimientos y campañas con consentimiento"
        actions={
          canWrite && tab === "reglas" ? (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                setEditing(null)
                setFormError(null)
                setFormOpen(true)
              }}
            >
              <Plus aria-hidden />
              Nueva regla
            </Button>
          ) : null
        }
      />
      <div className="flex gap-2" role="tablist" aria-label="Secciones de automatizaciones">
        {(
          [
            ["reglas", "Reglas"],
            ["resultados", "Resultados"],
            ["campanas", "Campañas"],
            ["consentimientos", "Consentimientos"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant={tab === value ? "default" : "outline"}
            onClick={() => {
              if (tab !== value) draftGuard.requestLeave(() => setTab(value))
            }}
            role="tab"
            aria-selected={tab === value}
          >
            {label}
          </Button>
        ))}
      </div>

      {tab === "reglas" ? (
        rules.length === 0 && !rulesQuery.isLoading ? (
          <EmptyState
            title="Sin reglas"
            description="Crea la primera regla para programar recordatorios o seguimientos."
          />
        ) : (
          <DataTable table={rulesTable} />
        )
      ) : null}

      {tab === "resultados" ? (
        <div className="flex flex-col gap-4">
          <FilterBar
            filters={[
              {
                key: "estado",
                label: "Estado",
                type: "select",
                options: Object.entries(JOB_STATUS_LABELS).map(([value, label]) => ({
                  value,
                  label,
                })),
              },
            ]}
            sortOptions={[{ value: "programado", label: "Programado" }]}
            searchPlaceholder="Buscar trabajo"
          />
          {jobs.length === 0 && !jobsQuery.isLoading ? (
            <EmptyState
              title={common.filters.noResults}
              description="No hay trabajos en este estado. Los omitidos por falta de consentimiento también aparecen aquí."
            />
          ) : (
            <DataTable table={jobsTable} />
          )}
        </div>
      ) : null}

      {tab === "campanas" ? <CampaignsPanel campaigns={campaigns} canWrite={canWrite} onChanged={invalidate} onDirtyChange={setCampaignDirty} /> : null}

      {tab === "consentimientos" ? <ConsentsPanel canWrite={canWrite} /> : null}

      {formOpen ? (
        <RuleFormDrawer
          initial={editing}
          formError={formError}
          onError={setFormError}
          onClose={() => {
            setFormOpen(false)
            setEditing(null)
          }}
          onSaved={() => {
            setFormOpen(false)
            setEditing(null)
            void invalidate()
          }}
        />
      ) : null}
    </PageShell>
  )
}

function RuleFormDrawer({
  initial,
  formError,
  onError,
  onClose,
  onSaved,
}: {
  initial: AutomationRule | null
  formError: string | null
  onError: (message: string | null) => void
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [kind, setKind] = useState(initial?.kind ?? "recordatorio_cita")
  const [channel, setChannel] = useState(initial?.channel ?? "whatsapp")
  const [templateName, setTemplateName] = useState(initial?.templateName ?? "")
  const [hoursBefore, setHoursBefore] = useState(initial?.config.hoursBefore?.join(", ") ?? "24, 3")
  const [delayHours, setDelayHours] = useState(String(initial?.config.delayHours ?? 48))
  const [inactiveDays, setInactiveDays] = useState(String(initial?.config.inactiveDays ?? 180))
  const [quietStart, setQuietStart] = useState(initial?.config.quietStart ?? "21:00")
  const [quietEnd, setQuietEnd] = useState(initial?.config.quietEnd ?? "08:00")
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    onError(null)
    if (!name.trim()) {
      onError("Ingresa el nombre de la regla")
      return
    }
    const config: Record<string, unknown> = { quietStart, quietEnd }
    if (kind === "recordatorio_cita") {
      const hours = hoursBefore
        .split(",")
        .map((h) => Number(h.trim()))
        .filter((h) => Number.isFinite(h) && h > 0)
      if (hours.length === 0) {
        onError("Indica las horas previas separadas por comas")
        return
      }
      config.hoursBefore = hours
    }
    if (kind.startsWith("seguimiento_")) config.delayHours = Number(delayHours) || 24
    if (kind === "recuperacion_inactivo") config.inactiveDays = Number(inactiveDays) || 180
    setSaving(true)
    try {
      const body = JSON.stringify({
        name: name.trim(),
        kind,
        channel,
        templateName: templateName.trim() || null,
        config,
      })
      if (initial) {
        await apiFetch(`/api/automations/rules/${initial.id}`, { method: "PATCH", body })
      } else {
        await apiFetch("/api/automations/rules", { method: "POST", body })
      }
      onSaved()
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={initial ? "Editar regla" : "Nueva regla"}
      submitLabel={initial ? "Guardar" : "Crear"}
      cancelLabel="Cancelar"
      isSubmitting={saving}
      onSubmit={handleSubmit}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel>Nombre</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recordatorio de cita 24h" />
        </Field>
        <Field>
          <FieldLabel>Tipo</FieldLabel>
          <select
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel>Canal</FieldLabel>
          <select
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="whatsapp">WhatsApp (permite iniciar conversación)</option>
            <option value="telegram">Telegram (requiere mensaje previo)</option>
            <option value="messenger">Messenger (requiere mensaje previo)</option>
            <option value="instagram">Instagram (requiere mensaje previo)</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Solo WhatsApp inicia conversaciones nuevas. En los demás canales el contacto debe escribir primero
            (si no, el trabajo falla con causa visible) y el texto respeta la ventana de 24 h.
          </p>
        </Field>
        <Field>
          <FieldLabel>Plantilla del canal (opcional)</FieldLabel>
          <Input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="recordatorio_cita"
          />
        </Field>
        {kind === "recordatorio_cita" ? (
          <Field>
            <FieldLabel>Horas previas (separadas por comas)</FieldLabel>
            <Input value={hoursBefore} onChange={(e) => setHoursBefore(e.target.value)} placeholder="24, 3" />
          </Field>
        ) : null}
        {kind.startsWith("seguimiento_") ? (
          <Field>
            <FieldLabel>Esperar (horas desde el evento)</FieldLabel>
            <Input value={delayHours} onChange={(e) => setDelayHours(e.target.value)} inputMode="numeric" />
          </Field>
        ) : null}
        {kind === "recuperacion_inactivo" ? (
          <Field>
            <FieldLabel>Días sin visitas para considerar inactivo</FieldLabel>
            <Input value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value)} inputMode="numeric" />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel>Silencio desde</FieldLabel>
            <Input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Silencio hasta</FieldLabel>
            <Input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </Field>
        </div>
        <p className="text-sm text-muted-foreground">
          Los envíos automáticos exigen opt-in vigente del contacto; sin él el trabajo queda omitido y visible en
          resultados. Los enlaces de confirmar/cancelar incluidos no exponen datos del paciente.
        </p>
        {formError ? <FieldError>{formError}</FieldError> : null}
      </div>
    </FormDrawer>
  )
}

function CampaignsPanel({
  campaigns,
  canWrite,
  onChanged,
  onDirtyChange,
}: {
  campaigns: AutomationRule[]
  canWrite: boolean
  onChanged: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [name, setName] = useState("")
  const [tags, setTags] = useState("")
  const [stageIds, setStageIds] = useState<string[]>([])
  const [channel, setChannel] = useState("whatsapp")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = name !== "" || tags !== "" || stageIds.length > 0 || channel !== "whatsapp"
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const [preview, setPreview] = useState<{
    total: number
    consentidos: number
    sinConsentimiento: number
    sample: Array<{ id: string; displayName: string }>
  } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const pipelinesQuery = useQuery({
    queryKey: ["automation-pipelines"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }> }>(
        "/api/pipelines",
      ),
  })
  const pipelines = pipelinesQuery.data?.data ?? []

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

  function toggleStage(id: string) {
    setStageIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  async function handlePreview() {
    setError(null)
    setPreviewing(true)
    try {
      const result = await apiFetch<{ data: NonNullable<typeof preview> }>(
        "/api/automations/campaigns/preview",
        {
          method: "POST",
          body: JSON.stringify({
            tags: tagList.length ? tagList : undefined,
            opportunityStageIds: stageIds.length ? stageIds : undefined,
            channel,
          }),
        },
      )
      setPreview(result.data)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError("Ingresa el nombre de la campaña")
      return
    }
    setSaving(true)
    try {
      const segment: { tags?: string[]; opportunityStageIds?: string[] } = {}
      if (tagList.length) segment.tags = tagList
      if (stageIds.length) segment.opportunityStageIds = stageIds
      await apiFetch("/api/automations/rules", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind: "campana",
          channel,
          enabled: false,
          config: { segment, quietStart: "21:00", quietEnd: "08:00" },
        }),
      })
      setName("")
      setTags("")
      setStageIds([])
      setChannel("whatsapp")
      setPreview(null)
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {campaigns.length > 0 ? (
        <div className="flex flex-col gap-2">
          {campaigns.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-sm font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.channel} · segmento: {describeSegment(c.config.segment)} ·{" "}
                  {c.enabled ? "activa" : "pausada"}
                </p>
              </div>
              <Badge variant={c.enabled ? "success" : "secondary"}>{c.enabled ? "Activa" : "Pausada"}</Badge>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="Sin campañas"
          description="Las campañas solo llegan a contactos con marketing consentido y siempre incluyen baja."
        />
      )}
      {canWrite ? (
        <form onSubmit={handleCreate} className="flex flex-col gap-4 rounded-md border p-4">
          <fieldset disabled={saving} className="contents">
          <h3 className="font-heading text-base font-medium">Nueva campaña (nace pausada)</h3>
          <Field>
            <FieldLabel>Nombre</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Limpieza preventiva marzo" />
          </Field>
          <Field>
            <FieldLabel>Etiquetas del segmento (separadas por comas, vacío = todos)</FieldLabel>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ortodoncia, vip" />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Etapas de oportunidad (vacío = todas)</legend>
            {pipelinesQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Cargando etapas…</p>
            ) : pipelines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin pipelines: el segmento usa solo etiquetas.</p>
            ) : (
              pipelines.map((pipeline) => (
                <div key={pipeline.id} className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">{pipeline.name}</p>
                  <div className="flex flex-wrap gap-2">
                    {pipeline.stages.map((stage) => (
                      <label key={stage.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={stageIds.includes(stage.id)}
                          onChange={() => toggleStage(stage.id)}
                        />
                        {stage.name}
                      </label>
                    ))}
                  </div>
                </div>
              ))
            )}
          </fieldset>
          <Field>
            <FieldLabel>Canal</FieldLabel>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="whatsapp">WhatsApp (permite iniciar conversación)</option>
              <option value="telegram">Telegram (requiere mensaje previo)</option>
              <option value="messenger">Messenger (requiere mensaje previo)</option>
              <option value="instagram">Instagram (requiere mensaje previo)</option>
            </select>
            <p className="text-xs text-muted-foreground">
              En canales distintos de WhatsApp solo reciben contactos con conversación previa y ventana vigente.
            </p>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={previewing} onClick={handlePreview}>
              {previewing ? "Calculando…" : "Vista previa de alcance"}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creando…" : "Crear campaña"}
            </Button>
          </div>
          {preview ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">
                Alcance: {preview.total} contactos · {preview.consentidos} con marketing consentido ·{" "}
                {preview.sinConsentimiento} sin consentimiento (no reciben nada).
              </p>
              {preview.sample.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Muestra (primeros {preview.sample.length}):{" "}
                  {preview.sample.map((s) => s.displayName).join(", ")}
                  {preview.total > preview.sample.length ? `, entre otros.` : "."}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
          </fieldset>
        </form>
      ) : null}
    </div>
  )
}

const CONSENT_PURPOSES = ["recordatorio", "seguimiento", "marketing"] as const
const CONSENT_CHANNELS = ["whatsapp", "telegram", "messenger", "instagram"] as const

function ConsentsPanel({ canWrite }: { canWrite: boolean }) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<ContactHit | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const searchQuery = useQuery({
    queryKey: ["automation-contact-search", query],
    queryFn: () =>
      apiFetch<{ data: { items: ContactHit[] } | ContactHit[] }>(
        `/api/contacts?q=${encodeURIComponent(query)}&limit=8`,
      ),
    enabled: query.trim().length >= 2 && !selected,
  })
  const rawItems = searchQuery.data?.data
  const hits: ContactHit[] = Array.isArray(rawItems) ? rawItems : (rawItems?.items ?? [])

  const consentsQuery = useQuery({
    queryKey: ["automation-consents", selected?.id],
    queryFn: () => apiFetch<{ data: ConsentRow[] }>(`/api/automations/contacts/${selected!.id}/consents`),
    enabled: !!selected,
  })
  const consents = consentsQuery.data?.data ?? []
  const statusOf = (purpose: string, channel: string) =>
    consents.find((c) => c.purpose === purpose && c.channel === channel)?.status ?? "sin registro"

  async function setConsent(contactId: string, purpose: string, channel: string, granted: boolean) {
    setError(null)
    setSaving(`${purpose}:${channel}`)
    try {
      await apiFetch(`/api/automations/contacts/${contactId}/consents`, {
        method: "POST",
        body: JSON.stringify({ purpose, channel, granted, source: "recepcion" }),
      })
      await consentsQuery.refetch()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Buscar contacto</FieldLabel>
        <Input
          value={selected ? selected.displayName : query}
          onChange={(e) => {
            setSelected(null)
            setQuery(e.target.value)
          }}
          placeholder="Nombre del contacto (mínimo 2 letras)"
        />
      </Field>
      {!selected && hits.length > 0 ? (
        <div className="flex flex-col gap-1">
          {hits.map((h) => (
            <Button key={h.id} type="button" variant="outline" onClick={() => setSelected(h)}>
              {h.displayName}
            </Button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-heading text-base font-medium">{selected.displayName}</h3>
            <Button type="button" variant="outline" onClick={() => setSelected(null)}>
              Cambiar
            </Button>
          </div>
          {CONSENT_PURPOSES.map((purpose) => (
            <div key={purpose} className="rounded-md border p-3">
              <p className="text-sm font-medium capitalize">{purpose}</p>
              <div className="mt-2 flex flex-col gap-2">
                {CONSENT_CHANNELS.map((channel) => {
                  const status = statusOf(purpose, channel)
                  const granted = status === "granted"
                  return (
                    <div key={channel} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">
                        {channel} · {status === "sin registro" ? "sin registro" : granted ? "permitido" : "revocado"}
                      </span>
                      {canWrite ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={saving === `${purpose}:${channel}`}
                          onClick={() => setConsent(selected.id, purpose, channel, !granted)}
                        >
                          {granted ? "Revocar" : "Otorgar"}
                        </Button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      ) : null}
    </div>
  )
}
