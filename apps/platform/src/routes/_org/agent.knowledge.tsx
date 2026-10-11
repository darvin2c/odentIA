import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { CircleCheck, CircleHelp, Database, MessageCircleQuestion } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { AgentTabs } from "../../components/agent-tabs"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import { isAmbiguousMutationError, mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/knowledge")({
  component: AgentKnowledgePage,
})

type KnowledgeState = "borrador" | "programada" | "vigente" | "vencida"

interface KnowledgeEntry {
  id: string
  kind: string
  title: string
  body: string
  branchId: string | null
  branchName: string | null
  status: string
  state: KnowledgeState
  validFrom: string | null
  validUntil: string | null
  askForms: string[]
  basicKey: string | null
  version: number
  updatedAt: string
}

interface Revision {
  version: number
  title: string
  body: string
  createdAt: string
}

interface BasicItem {
  key: string
  question: string
  covered: boolean
  coveredBy: "respuesta" | "datos" | null
  entryId: string | null
  dataSource: string | null
}

interface Basics {
  items: BasicItem[]
  covered: number
  total: number
}

interface Gap {
  ids: string[]
  question: string
  count: number
  lastAt: string
  conversationId: string
  teamAnswer: string | null
}

const KIND_LABEL: Record<string, string> = { faq: "Pregunta frecuente", info_sede: "Información de sede", politica: "Política" }

const STATE_LABEL: Record<KnowledgeState, string> = {
  vigente: "Vigente",
  programada: "Programada",
  vencida: "Vencida",
  borrador: "Borrador",
}
const STATE_VARIANT: Record<KnowledgeState, "success" | "soft" | "destructive" | "secondary"> = {
  vigente: "success",
  programada: "soft",
  vencida: "destructive",
  borrador: "secondary",
}

const FILTERS: Array<{ value: "todas" | KnowledgeState; label: string }> = [
  { value: "todas", label: "Todas" },
  { value: "vigente", label: "Vigentes" },
  { value: "borrador", label: "Borradores" },
  { value: "vencida", label: "Vencidas" },
  { value: "programada", label: "Programadas" },
]

/** Fecha de la clínica (AAAA-MM-DD) tal cual, sin pasar por la zona del navegador. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number)
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1)).toLocaleDateString("es-PE", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function validityLabel(entry: Pick<KnowledgeEntry, "validFrom" | "validUntil">): string {
  if (entry.validFrom && entry.validUntil) return `Del ${dayLabel(entry.validFrom)} al ${dayLabel(entry.validUntil)}`
  if (entry.validFrom) return `Desde el ${dayLabel(entry.validFrom)}`
  if (entry.validUntil) return `Hasta el ${dayLabel(entry.validUntil)}`
  return "Sin fecha de fin"
}

interface Draft {
  kind: string
  title: string
  body: string
  branchId: string
  validFrom: string
  validUntil: string
  askForms: string
  basicKey: string
  publish: boolean
  /** Al cerrar una pregunta sin respuesta: usar una respuesta que ya existe en vez de escribir otra. */
  existingId: string
}

const EMPTY_DRAFT: Draft = {
  kind: "faq",
  title: "",
  body: "",
  branchId: "",
  validFrom: "",
  validUntil: "",
  askForms: "",
  basicKey: "",
  publish: true,
  existingId: "",
}

/** Preguntas básicas pendientes a la vista; el resto, bajo demanda para no enterrar las respuestas. */
const MISSING_PREVIEW = 5
/** Botones compactos en escritorio, de 44 px en móvil. */
const TOUCH = "min-h-11 sm:min-h-8"

function AgentKnowledgePage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [filter, setFilter] = useState<"todas" | KnowledgeState>("todas")
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [answering, setAnswering] = useState<Gap | null>(null)
  const [revisionsFor, setRevisionsFor] = useState<KnowledgeEntry | null>(null)
  const [showCovered, setShowCovered] = useState(false)
  const [showAllMissing, setShowAllMissing] = useState(false)
  const [form, setForm] = useState<Draft>(EMPTY_DRAFT)
  const [baseline, setBaseline] = useState<Draft>(EMPTY_DRAFT)
  const formOpen = creating || editing !== null || answering !== null
  const formDirty = formOpen && !sameDraft(form, baseline)

  const entriesQuery = useQuery({
    queryKey: ["agent-knowledge"],
    queryFn: () => apiFetch<{ data: KnowledgeEntry[] }>("/api/agent/knowledge?limit=100"),
    enabled: canRead,
    retry: false,
  })
  const basicsQuery = useQuery({
    queryKey: ["agent-knowledge-basics"],
    queryFn: () => apiFetch<{ data: Basics }>("/api/agent/knowledge/basics"),
    enabled: canRead,
    retry: false,
  })
  const gapsQuery = useQuery({
    queryKey: ["agent-knowledge-gaps"],
    queryFn: () => apiFetch<{ data: Gap[] }>("/api/agent/knowledge/gaps"),
    enabled: canRead,
    retry: false,
  })
  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    enabled: canWrite && formOpen,
  })
  const revisionsQuery = useQuery({
    queryKey: ["agent-knowledge-revisions", revisionsFor?.id],
    queryFn: () => apiFetch<{ data: Revision[] }>(`/api/agent/knowledge/${revisionsFor?.id}/revisions`),
    enabled: canRead && revisionsFor !== null,
    retry: false,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge-basics"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge-gaps"] })
  }

  const saveMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (answering) {
        const answer = form.existingId
          ? { ids: answering.ids, entryId: form.existingId }
          : { ids: answering.ids, title: form.title, body: form.body, basicKey: form.basicKey || null }
        return apiFetch("/api/agent/knowledge/gaps/answer", { method: "POST", body: JSON.stringify(answer) })
      }
      const payload = {
        title: form.title,
        body: form.body,
        branchId: form.branchId || null,
        validFrom: form.validFrom || null,
        validUntil: form.validUntil || null,
        askForms: form.askForms.split("\n").map((line) => line.trim()).filter(Boolean),
        basicKey: form.basicKey || null,
      }
      if (editing) {
        return apiFetch(`/api/agent/knowledge/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      }
      const created = await apiFetch<{ data: KnowledgeEntry }>("/api/agent/knowledge", {
        method: "POST",
        body: JSON.stringify({ kind: form.kind, ...payload }),
      })
      if (form.publish) {
        await apiFetch(`/api/agent/knowledge/${created.data.id}/status`, {
          method: "POST",
          body: JSON.stringify({ status: "publicada" }),
        })
      }
      return created
    },
    onSuccess: () => {
      closeForm()
      invalidate()
    },
    // Si el alta salió y la publicación no, la respuesta existe como borrador: se refleja ya.
    onError: () => invalidate(),
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

  const discardMutation = useMutation({
    retry: false,
    mutationFn: (gap: Gap) =>
      apiFetch("/api/agent/knowledge/gaps/discard", { method: "POST", body: JSON.stringify({ ids: gap.ids }) }),
    onSuccess: () => invalidate(),
  })

  const entries = entriesQuery.data?.data ?? []
  const basics = basicsQuery.data?.data ?? null
  const gaps = gapsQuery.data?.data ?? []
  const visible = useMemo(() => {
    const wanted = search.trim().toLowerCase()
    return entries.filter(
      (entry) =>
        (filter === "todas" || entry.state === filter) &&
        (!wanted ||
          entry.title.toLowerCase().includes(wanted) ||
          entry.body.toLowerCase().includes(wanted) ||
          entry.askForms.some((formText) => formText.toLowerCase().includes(wanted))),
    )
  }, [entries, filter, search])

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso al conocimiento del agente. Solicita acceso a la administración." />
      </PageShell>
    )
  }

  const error = mutationErrorMessage(saveMutation.error)
  const missing = basics?.items.filter((item) => !item.covered) ?? []
  const covered = basics?.items.filter((item) => item.covered) ?? []

  function open(next: Draft, target: { entry?: KnowledgeEntry; gap?: Gap }) {
    saveMutation.reset()
    setForm(next)
    setBaseline(next)
    setEditing(target.entry ?? null)
    setAnswering(target.gap ?? null)
    setCreating(!target.entry && !target.gap)
  }

  function openCreate(preset: Partial<Draft> = {}) {
    open({ ...EMPTY_DRAFT, ...preset }, {})
  }

  function openEdit(entry: KnowledgeEntry) {
    open(
      {
        ...EMPTY_DRAFT,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        branchId: entry.branchId ?? "",
        validFrom: entry.validFrom ?? "",
        validUntil: entry.validUntil ?? "",
        askForms: entry.askForms.join("\n"),
        basicKey: entry.basicKey ?? "",
        publish: false,
      },
      { entry },
    )
  }

  function openAnswer(gap: Gap) {
    open({ ...EMPTY_DRAFT, title: gap.question, body: gap.teamAnswer ?? "" }, { gap })
  }

  function closeForm() {
    setEditing(null)
    setCreating(false)
    setAnswering(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saveMutation.isPending || isAmbiguousMutationError(saveMutation.error)) return
    saveMutation.mutate()
  }

  const usesExisting = answering !== null && form.existingId !== ""
  const incomplete = usesExisting ? false : !form.title.trim() || !form.body.trim()
  const publishedEntries = entries.filter((entry) => entry.status === "publicada")

  return (
    <PageShell className="flex flex-col gap-6">
      <PageDraftGuard dirty={formDirty || saveMutation.isPending} />
      <PageHeader title="Agente" subtitle="Lo que el agente sabe de tu clínica: solo responde con lo publicado y vigente, o con tus datos." />
      <AgentTabs />

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
        <section aria-labelledby="sin-respuesta" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-warning [&>svg]:size-5">
              <MessageCircleQuestion aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id="sin-respuesta" className="font-heading text-base font-semibold">
                No supo responder{gaps.length > 0 ? ` · ${gaps.length}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground">
                Preguntas para las que buscó una respuesta oficial y no la encontró.
              </p>
            </div>
          </div>
          {gapsQuery.isPending ? (
            <LoadingState message="Cargando preguntas…" />
          ) : gapsQuery.isError ? (
            <QueryErrorState error={gapsQuery.error} onRetry={() => void gapsQuery.refetch()} />
          ) : gaps.length === 0 ? (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
              Nada pendiente: encontró respuesta para todo lo que buscó.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {gaps.map((gap) => (
                <li key={gap.ids[0]} className="flex flex-col gap-2 rounded-xl border p-4">
                  <p className="font-semibold">«{gap.question}»</p>
                  <p className="text-xs text-muted-foreground">
                    {gap.count === 1 ? "La preguntó 1 persona" : `La preguntaron ${gap.count} veces`} ·{" "}
                    <Link to="/inbox" search={{ conversation: gap.conversationId }} className="font-semibold text-primary hover:underline">
                      Ver la conversación
                    </Link>
                  </p>
                  {gap.teamAnswer ? (
                    <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                      <span className="font-semibold">Tu equipo respondió:</span> {gap.teamAnswer}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nadie del equipo respondió todavía en esa conversación.</p>
                  )}
                  {canWrite ? (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" className={TOUCH} onClick={() => openAnswer(gap)}>
                        Guardar como respuesta oficial
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={TOUCH}
                        disabled={discardMutation.isPending}
                        onClick={() => discardMutation.mutate(gap)}
                      >
                        Descartar
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {discardMutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(discardMutation.error) ?? "No pudimos descartar la pregunta."}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="lo-basico" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-primary-soft-foreground [&>svg]:size-5">
              <CircleHelp aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="lo-basico" className="font-heading text-base font-semibold">
                Lo básico de una clínica{basics ? ` · ${basics.covered} de ${basics.total}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground">Lo que casi todos preguntan. Conviene tenerlo respondido antes de dejarlo atender solo.</p>
            </div>
          </div>
          {basicsQuery.isPending ? (
            <LoadingState message="Cargando…" />
          ) : basicsQuery.isError || !basics ? (
            <QueryErrorState error={basicsQuery.error} onRetry={() => void basicsQuery.refetch()} />
          ) : (
            <>
              <div
                role="progressbar"
                aria-label="Preguntas básicas respondidas"
                aria-valuemin={0}
                aria-valuemax={basics.total}
                aria-valuenow={basics.covered}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${(basics.covered / basics.total) * 100}%` }} />
              </div>
              {missing.length === 0 ? (
                <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">Todo lo básico está respondido.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {(showAllMissing ? missing : missing.slice(0, MISSING_PREVIEW)).map((item) => (
                    <li key={item.key} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="min-w-0 flex-1 text-sm">{item.question}</span>
                      {canWrite ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={TOUCH}
                          onClick={() => openCreate({ title: item.question, basicKey: item.key })}
                        >
                          Responder
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {missing.length > MISSING_PREVIEW ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className={`h-auto justify-start p-0 ${TOUCH}`}
                  aria-expanded={showAllMissing}
                  onClick={() => setShowAllMissing((value) => !value)}
                >
                  {showAllMissing ? "Ver menos" : `Ver las ${missing.length} que faltan`}
                </Button>
              ) : null}
              {covered.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className={`h-auto justify-start p-0 ${TOUCH}`}
                    aria-expanded={showCovered}
                    onClick={() => setShowCovered((value) => !value)}
                  >
                    {showCovered
                      ? "Ocultar las respondidas"
                      : covered.length === 1
                        ? "Ver la respondida"
                        : `Ver las ${covered.length} respondidas`}
                  </Button>
                  {showCovered ? (
                    <ul className="flex flex-col gap-1.5">
                      {covered.map((item) => (
                        <li key={item.key} className="flex items-start gap-2 text-sm">
                          <span className="mt-0.5 shrink-0 text-success [&>svg]:size-4">
                            <CircleCheck aria-hidden />
                          </span>
                          <span className="min-w-0">
                            {item.question}{" "}
                            <span className="text-muted-foreground">
                              · {item.coveredBy === "datos" ? `Con tus datos: ${item.dataSource ?? "sistema"}` : "Con una respuesta oficial"}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="respuestas" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="respuestas" className="font-heading text-base font-semibold">
              Respuestas oficiales{entries.length > 0 ? ` · ${entries.length}` : ""}
            </h2>
            <p className="text-sm text-muted-foreground">El agente las cita tal cual. Una respuesta vencida deja de usarse sola.</p>
          </div>
          {canWrite ? (
            <Button type="button" className="min-h-11 sm:min-h-9" onClick={() => openCreate()}>
              Nueva respuesta
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field className="w-full sm:w-64">
            <FieldLabel htmlFor="buscar-respuesta" className="sr-only">
              Buscar en las respuestas
            </FieldLabel>
            <Input
              id="buscar-respuesta"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar en las respuestas…"
            />
          </Field>
          <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1.5" aria-label="Estado de la respuesta">
            {FILTERS.map((option) => {
              const total = option.value === "todas" ? entries.length : entries.filter((entry) => entry.state === option.value).length
              if (option.value !== "todas" && option.value !== "vigente" && total === 0) return null
              return (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={filter === option.value ? "default" : "outline"}
                  className={`rounded-full ${TOUCH}`}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label} · {total}
                </Button>
              )
            })}
          </fieldset>
        </div>
        {statusMutation.isError ? (
          <ErrorState
            title="No pudimos confirmar el cambio de estado"
            message={mutationErrorMessage(statusMutation.error) ?? undefined}
            onRetry={() => {
              void entriesQuery.refetch().then((result) => {
                if (result.isSuccess) statusMutation.reset()
              })
            }}
            retryLabel="Consultar estado actual"
          />
        ) : null}
        {entriesQuery.isPending ? (
          <LoadingState message="Cargando respuestas…" />
        ) : entriesQuery.isError ? (
          <QueryErrorState error={entriesQuery.error} onRetry={() => void entriesQuery.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState
            title="Todavía no hay respuestas oficiales"
            description="Sin ellas, el agente solo puede responder con tus sedes, servicios y agenda."
            {...(canWrite ? { actionLabel: "Escribir la primera respuesta", onAction: () => openCreate() } : {})}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="Sin resultados"
            description="Ninguna respuesta coincide con la búsqueda o el estado elegido."
            actionLabel="Ver todas"
            onAction={() => {
              setFilter("todas")
              setSearch("")
            }}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((entry) => (
              <li key={entry.id} className="elevated flex flex-col gap-2 rounded-xl border bg-card p-5 sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATE_VARIANT[entry.state]}>{STATE_LABEL[entry.state]}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {KIND_LABEL[entry.kind] ?? entry.kind} · {entry.branchName ? `Solo ${entry.branchName}` : "Todas las sedes"} ·{" "}
                    {validityLabel(entry)}
                  </span>
                </div>
                <h3 className="font-semibold">{entry.title}</h3>
                <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>
                {entry.askForms.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    También la encuentra como: {entry.askForms.slice(0, 3).map((text) => `«${text}»`).join(", ")}
                    {entry.askForms.length > 3 ? ` y ${entry.askForms.length - 3} más` : ""}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {canWrite ? (
                    <>
                      <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={() => openEdit(entry)}>
                        Editar
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={TOUCH}
                        onClick={() => statusMutation.mutate(entry)}
                        disabled={statusMutation.isPending || isAmbiguousMutationError(statusMutation.error)}
                      >
                        {entry.status === "publicada" ? "Despublicar" : "Publicar"}
                      </Button>
                    </>
                  ) : null}
                  <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={() => setRevisionsFor(entry)}>
                    Ver versiones · v{entry.version}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tus-datos" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-primary-soft-foreground [&>svg]:size-5">
            <Database aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="tus-datos" className="font-heading text-base font-semibold">
              Lo que toma de tus datos
            </h2>
            <p className="text-sm text-muted-foreground">No hace falta escribirlo: lo lee en el momento, así que un cambio vale desde la siguiente respuesta.</p>
          </div>
        </div>
        <ul className="grid gap-2 sm:grid-cols-3">
          {[
            { to: "/services", title: "Servicios y tarifas", detail: "Qué ofreces y cuánto cuesta, con su moneda." },
            { to: "/branches", title: "Sedes", detail: "Dirección, teléfono y cómo llegar." },
            { to: "/settings/availability", title: "Disponibilidad", detail: "Los horarios reales para ofrecer citas." },
          ].map((source) => (
            <li key={source.to}>
              <Link to={source.to} className="lift flex min-h-11 flex-col rounded-xl border p-3 hover:bg-accent/60">
                <span className="text-sm font-semibold text-primary">{source.title}</span>
                <span className="text-sm text-muted-foreground">{source.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {canWrite ? (
        <FormDrawer
          open={formOpen}
          onClose={closeForm}
          title={answering ? "Guardar como respuesta oficial" : editing ? "Editar respuesta" : "Nueva respuesta"}
          description={
            answering
              ? "La próxima vez que lo pregunten, el agente responderá con esto."
              : "El agente la cita tal cual. Escríbela como se la dirías a un paciente."
          }
          onSubmit={submit}
          isSubmitting={saveMutation.isPending}
          isDirty={formDirty}
          error={error}
          submitLabel={answering ? "Guardar y publicar" : "Guardar"}
          cancelLabel="Cancelar"
          submitDisabled={incomplete || isAmbiguousMutationError(saveMutation.error)}
        >
          {answering ? (
            <>
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                <span className="font-semibold">Preguntaron:</span> «{answering.question}»
                {answering.count > 1 ? ` · ${answering.count} veces` : ""}
              </p>
              {publishedEntries.length > 0 ? (
                <Field>
                  <FieldLabel htmlFor="nc-existente">¿Ya tienes una respuesta para esto?</FieldLabel>
                  <Select
                    value={form.existingId || "nueva"}
                    onValueChange={(value) => setForm({ ...form, existingId: !value || value === "nueva" ? "" : value })}
                  >
                    <SelectTrigger id="nc-existente" aria-label="Respuesta existente">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nueva">No, escribir una nueva</SelectItem>
                      {publishedEntries.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Si eliges una, esta forma de preguntar se suma a esa respuesta y no se crea otra.
                  </FieldDescription>
                </Field>
              ) : null}
            </>
          ) : null}
          {usesExisting ? null : (
            <>
              {creating ? (
                <Field>
                  <FieldLabel htmlFor="nc-tipo">Tipo</FieldLabel>
                  <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value ?? "faq" })}>
                    <SelectTrigger id="nc-tipo" aria-label="Tipo">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="faq">Pregunta frecuente</SelectItem>
                      <SelectItem value="info_sede">Información de sede</SelectItem>
                      <SelectItem value="politica">Política</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="nc-titulo">La pregunta</FieldLabel>
                <Input
                  id="nc-titulo"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  placeholder="¿Atienden sin cita?"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="nc-cuerpo">La respuesta</FieldLabel>
                <Textarea
                  id="nc-cuerpo"
                  rows={5}
                  value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                  placeholder="Respuesta oficial…"
                />
              </Field>
            </>
          )}
          {answering ? null : (
            <>
              <Field>
                <FieldLabel htmlFor="nc-formas">Otras formas de preguntarlo</FieldLabel>
                <Textarea
                  id="nc-formas"
                  rows={3}
                  value={form.askForms}
                  onChange={(event) => setForm({ ...form, askForms: event.target.value })}
                  placeholder={"¿Puedo ir sin reservar?\n¿Reciben pacientes sin turno?"}
                />
                <FieldDescription>Una por línea. Ayudan al agente a encontrar esta respuesta.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="nc-sede">Sede</FieldLabel>
                <Select
                  value={form.branchId || "todas"}
                  onValueChange={(value) => setForm({ ...form, branchId: !value || value === "todas" ? "" : value })}
                >
                  <SelectTrigger id="nc-sede" aria-label="Sede">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todas">Todas las sedes</SelectItem>
                    {(branchesQuery.data?.data ?? []).map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        Solo {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="nc-desde">Vale desde</FieldLabel>
                  <Input
                    id="nc-desde"
                    type="date"
                    value={form.validFrom}
                    onChange={(event) => setForm({ ...form, validFrom: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="nc-hasta">Vale hasta</FieldLabel>
                  <Input
                    id="nc-hasta"
                    type="date"
                    value={form.validUntil}
                    min={form.validFrom || undefined}
                    onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
                  />
                </Field>
              </div>
              <p className="-mt-2 text-sm text-muted-foreground">
                Déjalas vacías si vale siempre. Pasada la fecha, el agente deja de usarla sin que hagas nada.
              </p>
              <Field>
                <FieldLabel htmlFor="nc-basica">Pregunta básica que cubre</FieldLabel>
                <Select
                  value={form.basicKey || "ninguna"}
                  onValueChange={(value) => setForm({ ...form, basicKey: !value || value === "ninguna" ? "" : value })}
                >
                  <SelectTrigger id="nc-basica" aria-label="Pregunta básica">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ninguna">Ninguna</SelectItem>
                    {(basics?.items ?? []).map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.question}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {creating ? (
                <Field>
                  <label htmlFor="nc-publicar" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      id="nc-publicar"
                      checked={form.publish}
                      onCheckedChange={(value) => setForm({ ...form, publish: value === true })}
                    />
                    Publicar al guardar
                  </label>
                  <FieldDescription>Sin publicar queda como borrador y el agente no la usa.</FieldDescription>
                </Field>
              ) : null}
            </>
          )}
        </FormDrawer>
      ) : null}

      <DetailDrawer
        open={revisionsFor !== null}
        title="Versiones"
        description={revisionsFor?.title}
        onClose={() => setRevisionsFor(null)}
      >
        {revisionsQuery.isPending ? (
          <LoadingState message="Cargando versiones…" />
        ) : revisionsQuery.isError ? (
          <QueryErrorState error={revisionsQuery.error} onRetry={() => void revisionsQuery.refetch()} />
        ) : (
          <ul className="flex flex-col gap-4">
            {(revisionsQuery.data?.data ?? []).map((revision) => (
              <li key={revision.version} className="flex flex-col gap-1 text-sm">
                <p>
                  <span className="font-semibold">Versión {revision.version}</span>{" "}
                  <span className="text-muted-foreground">· {new Date(revision.createdAt).toLocaleString("es-PE")}</span>
                </p>
                <p className="font-medium">{revision.title}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{revision.body}</p>
              </li>
            ))}
          </ul>
        )}
      </DetailDrawer>
    </PageShell>
  )
}
