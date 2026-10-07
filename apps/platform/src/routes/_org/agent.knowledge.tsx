import { Badge, Button, Field, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@odentia/ui"
import { EmptyState, ErrorState, FormDrawer, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { isAmbiguousMutationError, mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/agent/knowledge")({
  component: AgentKnowledgePage,
})

interface KnowledgeEntry {
  id: string
  kind: string
  title: string
  body: string
  branchId: string | null
  branchName: string | null
  status: string
  version: number
  updatedAt: string
}

interface Revision {
  version: number
  title: string
  body: string
  createdAt: string
}

const KIND_LABEL: Record<string, string> = { faq: "Pregunta frecuente", info_sede: "Info de sede", politica: "Política" }

function AgentKnowledgePage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [kindFilter, setKindFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState("publicada")
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [revisionsFor, setRevisionsFor] = useState<KnowledgeEntry | null>(null)
  const [form, setForm] = useState({ kind: "faq", title: "", body: "", branchId: "" })
  const [baseline, setBaseline] = useState(form)
  const formDirty = (creating || editing !== null) && !sameDraft(form, baseline)

  const entriesQuery = useQuery({
    queryKey: ["agent-knowledge", kindFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (kindFilter) params.set("kind", kindFilter)
      if (statusFilter) params.set("status", statusFilter)
      return apiFetch<{ data: KnowledgeEntry[] }>(`/api/agent/knowledge?${params}`)
    },
    enabled: canRead,
    retry: false,
  })
  const revisionsQuery = useQuery({
    queryKey: ["agent-knowledge-revisions", revisionsFor?.id],
    queryFn: () => apiFetch<{ data: Revision[] }>(`/api/agent/knowledge/${revisionsFor?.id}/revisions`),
    enabled: canRead && revisionsFor !== null,
    retry: false,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge"] })
  }

  const saveMutation = useMutation({
    retry: false,
    mutationFn: () => {
      const payload = {
        kind: form.kind,
        title: form.title,
        body: form.body,
        branchId: form.branchId || null,
      }
      if (editing) {
        return apiFetch(`/api/agent/knowledge/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      }
      return apiFetch("/api/agent/knowledge", { method: "POST", body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      setEditing(null)
      setCreating(false)
      invalidate()
    },
  })

  const statusMutation = useMutation({
    retry: false,
    mutationFn: (entry: KnowledgeEntry) =>
      apiFetch(`/api/agent/knowledge/${entry.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: entry.status === "publicada" ? "borrador" : "publicada" }),
      }),
    onSuccess: () => invalidate(),
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso al conocimiento del agente. Solicita acceso a la administración." />
      </PageShell>
    )
  }

  const entries = entriesQuery.data?.data ?? []
  const revisions = revisionsQuery.data?.data ?? []
  const error = mutationErrorMessage(saveMutation.error)

  function openCreate() {
    saveMutation.reset()
    setEditing(null)
    const initial = { kind: "faq", title: "", body: "", branchId: "" }
    setForm(initial)
    setBaseline(initial)
    setCreating(true)
  }

  function openEdit(entry: KnowledgeEntry) {
    saveMutation.reset()
    setCreating(false)
    const initial = { kind: entry.kind, title: entry.title, body: entry.body, branchId: entry.branchId ?? "" }
    setForm(initial)
    setBaseline(initial)
    setEditing(entry)
  }

  function closeForm() {
    setEditing(null)
    setCreating(false)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saveMutation.isPending || isAmbiguousMutationError(saveMutation.error)) return
    saveMutation.mutate()
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <PageDraftGuard dirty={formDirty || saveMutation.isPending} />
      <PageHeader
        title="Conocimiento del agente"
        subtitle="Respuestas oficiales versionadas: solo lo publicado alimenta al agente"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Field className="w-56">
          <FieldLabel htmlFor="filtro-tipo">Tipo</FieldLabel>
          <Select value={kindFilter || "todos"} onValueChange={(value) => setKindFilter(value === "todos" ? "" : (value ?? ""))}>
            <SelectTrigger id="filtro-tipo" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="faq">Preguntas frecuentes</SelectItem>
              <SelectItem value="info_sede">Info de sede</SelectItem>
              <SelectItem value="politica">Políticas</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-56">
          <FieldLabel htmlFor="filtro-estado">Estado</FieldLabel>
          <Select value={statusFilter || "todos"} onValueChange={(value) => setStatusFilter(value === "todos" ? "" : (value ?? ""))}>
            <SelectTrigger id="filtro-estado" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="publicada">Publicadas</SelectItem>
              <SelectItem value="borrador">Borradores</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {canWrite ? (
          <Button type="button" size="sm" onClick={openCreate}>
            Nueva entrada
          </Button>
        ) : null}
      </div>
      {statusMutation.isError ? (
        <ErrorState title="No pudimos confirmar el cambio de estado" message={mutationErrorMessage(statusMutation.error) ?? undefined} onRetry={() => { void entriesQuery.refetch().then(result => { if (result.isSuccess) statusMutation.reset() }) }} retryLabel="Consultar estado actual" />
      ) : null}
      {entriesQuery.isPending ? (
        <LoadingState message="Cargando entradas…" />
      ) : entriesQuery.isError ? (
        <QueryErrorState error={entriesQuery.error} onRetry={() => { void entriesQuery.refetch() }} />
      ) : entries.length === 0 ? (
        <EmptyState title={kindFilter || statusFilter ? "Sin resultados" : "Sin entradas"} description={kindFilter || statusFilter ? "Prueba otro tipo o estado para encontrar entradas." : "Crea la primera respuesta oficial de la clínica."} />
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-2 rounded-md bg-card p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={entry.status === "publicada" ? "success" : "secondary"}>
                  {entry.status === "publicada" ? "Publicada" : "Borrador"}
                </Badge>
                <Badge variant="secondary">{KIND_LABEL[entry.kind] ?? entry.kind}</Badge>
                <span className="text-xs text-muted-foreground">v{entry.version}</span>
                {entry.branchName ? <span className="text-xs text-muted-foreground">{entry.branchName}</span> : null}
              </div>
              <div className="font-medium">{entry.title}</div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>
              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => openEdit(entry)}>
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => statusMutation.mutate(entry)}
                    disabled={statusMutation.isPending || isAmbiguousMutationError(statusMutation.error)}
                  >
                    {entry.status === "publicada" ? "Despublicar" : "Publicar"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRevisionsFor(entry)}>
                    Ver versiones
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <FormDrawer
          open={creating || editing !== null}
          onClose={closeForm}
          title={editing ? "Editar entrada" : "Nueva entrada"}
          onSubmit={submit}
          isSubmitting={saveMutation.isPending}
          isDirty={formDirty}
          error={error}
          submitLabel="Guardar"
          cancelLabel="Cancelar"
          submitDisabled={!form.title.trim() || !form.body.trim() || isAmbiguousMutationError(saveMutation.error)}
        >
          <Field>
            <FieldLabel htmlFor="nc-tipo">Tipo</FieldLabel>
            <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value ?? "faq" })}>
              <SelectTrigger id="nc-tipo" aria-label="Tipo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="faq">Pregunta frecuente</SelectItem>
                <SelectItem value="info_sede">Info de sede</SelectItem>
                <SelectItem value="politica">Política</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="nc-titulo">Título</FieldLabel>
            <Input
              id="nc-titulo"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="¿Atienden sin cita?"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nc-cuerpo">Contenido (se cita tal cual)</FieldLabel>
            <Textarea
              id="nc-cuerpo"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="Respuesta oficial…"
            />
          </Field>
        </FormDrawer>
      ) : null}
      {revisionsFor ? (
        <div className="flex flex-col gap-2 rounded-md bg-card p-6">
          <div className="font-heading text-base font-medium">Versiones de “{revisionsFor.title}”</div>
          {revisionsQuery.isPending ? (
            <LoadingState message="Cargando versiones…" />
          ) : revisionsQuery.isError ? (
            <QueryErrorState error={revisionsQuery.error} onRetry={() => { void revisionsQuery.refetch() }} />
          ) : revisions.length === 0 ? (
            <EmptyState title="Sin versiones" description="Esta entrada todavía no tiene versiones anteriores." />
          ) : (
            <ul className="flex flex-col gap-2">
              {revisions.map((r) => (
                <li key={r.version} className="text-sm">
                  <span className="font-medium">v{r.version}</span>{" "}
                  <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString("es-PE")}</span>
                  <p className="whitespace-pre-wrap text-muted-foreground">{r.body}</p>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setRevisionsFor(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      ) : null}
    </PageShell>
  )
}
