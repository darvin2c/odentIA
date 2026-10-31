import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { DatePickerButton, ErrorState, FormDrawer, PageHeader, PageShell, useListSearch } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { KnowledgeAnswers } from "../../components/agent/knowledge-answers"
import { KnowledgeBasics } from "../../components/agent/knowledge-basics"
import { KnowledgeDetail } from "../../components/agent/knowledge-detail"
import { KnowledgeGaps } from "../../components/agent/knowledge-gaps"
import {
  type KnowledgeBasicItem,
  type KnowledgeBasics as Basics,
  type KnowledgeEntry,
  type KnowledgeGap as Gap,
  type KnowledgeSources as Sources,
  TOUCH,
} from "../../components/agent/knowledge-model"
import { KnowledgeSources } from "../../components/agent/knowledge-sources"
import { LessonDrawer } from "../../components/agent/lesson-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import { activeOrgLocale } from "../../lib/locale"
import { useReceptionName } from "../../lib/agent-names"
import { isAmbiguousMutationError, mutationErrorMessage } from "../../lib/query-error"
import { KnowledgePageSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/knowledge")({
  pendingComponent: KnowledgePageSkeleton,
  component: AgentKnowledgePage,
})

const KIND_LABEL: Record<string, string> = { faq: "Pregunta frecuente", info_sede: "Información de sede", politica: "Política" }
/** Límite del título de una respuesta en el servidor. */
const TITLE_CHARS = 200

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

function basicDraft(item: KnowledgeBasicItem): Draft {
  return { ...EMPTY_DRAFT, title: item.question, basicKey: item.key }
}

function AgentKnowledgePage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  // Las respuestas las dice a los pacientes el agente de recepción.
  const receptionName = useReceptionName()
  const [detailId, setDetailId] = useState<string | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [answering, setAnswering] = useState<Gap | null>(null)
  /** «Responder las que faltan»: al guardar una pregunta básica se pasa a la siguiente. */
  const [basicsRun, setBasicsRun] = useState(false)
  const [form, setForm] = useState<Draft>(EMPTY_DRAFT)
  const [baseline, setBaseline] = useState<Draft>(EMPTY_DRAFT)
  const formOpen = creating || editing !== null || answering !== null
  const formDirty = formOpen && !sameDraft(form, baseline)

  // Por páginas (topes de la fase 4): la respuesta 101 también se abre. La
  // búsqueda va al servidor; la sede y el estado se filtran sobre lo cargado.
  const search = useListSearch().get("q")?.trim() ?? ""
  const entriesQuery = useInfiniteQuery({
    queryKey: ["agent-knowledge", search],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "100" })
      if (search) params.set("q", search)
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: KnowledgeEntry[]; nextCursor: string | null; total: number }>(`/api/agent/knowledge?${params}`)
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
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
  const sourcesQuery = useQuery({
    queryKey: ["agent-knowledge-sources"],
    queryFn: () => apiFetch<{ data: Sources }>("/api/agent/knowledge/sources"),
    enabled: canRead,
    retry: false,
  })
  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string; isActive?: boolean }> }>("/api/branches"),
    enabled: canRead,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge-basics"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-knowledge-gaps"] })
  }

  const saveMutation = useMutation({
    retry: false,
    // `next`: la pregunta básica que sigue cuando se están respondiendo las que faltan.
    mutationFn: async (_input: { next: Draft | null }) => {
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
    onSuccess: (_data, input) => {
      if (input.next) {
        saveMutation.reset()
        setForm(input.next)
        setBaseline(input.next)
      } else closeForm()
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

  // Lo que el equipo ya respondió se guarda tal cual. Repetirlo es seguro: una
  // pregunta ya cerrada no se cierra dos veces ni crea otra respuesta.
  const quickSaveMutation = useMutation({
    retry: false,
    mutationFn: (gap: Gap) =>
      apiFetch("/api/agent/knowledge/gaps/answer", {
        method: "POST",
        body: JSON.stringify({ ids: gap.ids, title: gap.question, body: gap.teamAnswer }),
      }),
    onSettled: () => invalidate(),
  })

  const discardMutation = useMutation({
    retry: false,
    mutationFn: (gap: Gap) =>
      apiFetch("/api/agent/knowledge/gaps/discard", { method: "POST", body: JSON.stringify({ ids: gap.ids }) }),
    onSuccess: () => {
      closeForm()
      invalidate()
    },
  })

  const entries = entriesQuery.data?.pages.flatMap((page) => page.data) ?? []
  const entriesTotal = entriesQuery.data?.pages[0]?.total ?? entries.length
  const basics = basicsQuery.data?.data ?? null
  const gaps = gapsQuery.data?.data ?? []
  const branches = (branchesQuery.data?.data ?? []).filter((branch) => branch.isActive !== false)

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso al conocimiento del agente. Solicita acceso a la administración." />
      </PageShell>
    )
  }

  const error = mutationErrorMessage(saveMutation.error)
  const missing = basics?.items.filter((item) => !item.covered) ?? []
  const detail = entries.find((entry) => entry.id === detailId) ?? null

  function open(next: Draft, target: { entry?: KnowledgeEntry; gap?: Gap; basicsRun?: boolean }) {
    saveMutation.reset()
    discardMutation.reset()
    setDetailId(null)
    setForm(next)
    setBaseline(next)
    setEditing(target.entry ?? null)
    setAnswering(target.gap ?? null)
    setCreating(!target.entry && !target.gap)
    setBasicsRun(target.basicsRun === true)
  }

  function openCreate() {
    open(EMPTY_DRAFT, {})
  }

  /** Responder lo básico: empieza por la primera que falta y sigue con las demás. */
  function startBasics() {
    const first = missing[0]
    if (first) open(basicDraft(first), { basicsRun: true })
    else openCreate()
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
    quickSaveMutation.reset()
    open({ ...EMPTY_DRAFT, title: gap.question.slice(0, TITLE_CHARS), body: gap.teamAnswer ?? "" }, { gap })
  }

  function quickSave(gap: Gap) {
    // Una pregunta más larga que un título se acorta a mano, no a ciegas.
    if (gap.question.length > TITLE_CHARS) openAnswer(gap)
    else quickSaveMutation.mutate(gap)
  }

  function closeForm() {
    setEditing(null)
    setCreating(false)
    setAnswering(null)
    setBasicsRun(false)
  }

  // En «Responder las que faltan», la que sigue a la que se está respondiendo.
  const runRest = basicsRun ? missing.filter((item) => item.key !== form.basicKey) : []
  const runIndex = missing.findIndex((item) => item.key === form.basicKey)
  const runNext = runRest.length > 0 ? (missing.slice(runIndex + 1).find((item) => item.key !== form.basicKey) ?? runRest[0]) : undefined

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saveMutation.isPending || isAmbiguousMutationError(saveMutation.error)) return
    saveMutation.mutate({ next: runNext ? basicDraft(runNext) : null })
  }

  const usesExisting = answering !== null && form.existingId !== ""
  const incomplete = usesExisting ? false : !form.title.trim() || !form.body.trim()
  const publishedEntries = entries.filter((entry) => entry.status === "publicada")
  const branchOptions = editing?.branchId && editing.branchName && !branches.some((branch) => branch.id === editing.branchId)
    ? [...branches, { id: editing.branchId, name: editing.branchName }]
    : branches

  return (
    <PageShell className={`flex flex-col gap-6 ${canWrite ? "max-sm:pb-24" : ""}`}>
      <PageDraftGuard dirty={formDirty || saveMutation.isPending} />
      <PageHeader title="Agente" subtitle="Solo responde con lo que está aquí. Si un dato falta, lo dice y pasa a una persona." />
      <AgentTabs />

      <div className="grid min-w-0 items-stretch gap-4 xl:grid-cols-2">
        <KnowledgeGaps
          gaps={gaps}
          isPending={gapsQuery.isPending}
          error={gapsQuery.isError ? gapsQuery.error : null}
          onRetry={() => void gapsQuery.refetch()}
          canWrite={canWrite}
          savingId={quickSaveMutation.isPending ? (quickSaveMutation.variables?.ids[0] ?? null) : null}
          blocked={quickSaveMutation.isPending}
          saveError={mutationErrorMessage(quickSaveMutation.error)}
          onSave={quickSave}
          onEdit={openAnswer}
        />
        <KnowledgeBasics
          basics={basics}
          isPending={basicsQuery.isPending}
          error={basicsQuery.isError ? basicsQuery.error : null}
          onRetry={() => void basicsQuery.refetch()}
          canWrite={canWrite}
          onAnswerMissing={startBasics}
        />
      </div>

      <KnowledgeAnswers
        entries={entries}
        total={entriesTotal}
        hasMore={entriesQuery.hasNextPage}
        loadingMore={entriesQuery.isFetchingNextPage}
        onLoadMore={() => void entriesQuery.fetchNextPage()}
        isPending={entriesQuery.isPending}
        error={entriesQuery.isError ? entriesQuery.error : null}
        onRetry={() => void entriesQuery.refetch()}
        branches={branches}
        canWrite={canWrite}
        canStartBasics={missing.length > 0}
        activeId={detailId}
        onOpen={(entry) => {
          statusMutation.reset()
          setDetailId(entry.id)
        }}
        onCreate={openCreate}
        onStartBasics={startBasics}
      />

      <KnowledgeSources sources={sourcesQuery.data?.data ?? null} />

      {canWrite ? (
        // En teléfono, la acción principal queda fija al pie.
        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
          <Button type="button" className="h-12 w-full text-base" onClick={openCreate}>
            Nueva respuesta
          </Button>
        </div>
      ) : null}

      <KnowledgeDetail
        entry={detail}
        canWrite={canWrite}
        statusPending={statusMutation.isPending}
        statusBlocked={isAmbiguousMutationError(statusMutation.error)}
        statusError={mutationErrorMessage(statusMutation.error)}
        onCheckStatus={() => {
          void entriesQuery.refetch().then((result) => {
            if (result.isSuccess) statusMutation.reset()
          })
        }}
        onClose={() => setDetailId(null)}
        onEdit={openEdit}
        onToggleStatus={(entry) => statusMutation.mutate(entry)}
        onOpenLesson={setLessonId}
      />

      <LessonDrawer lessonId={lessonId} canWrite={canWrite} onClose={() => setLessonId(null)} />

      {canWrite ? (
        <FormDrawer
          open={formOpen}
          onClose={closeForm}
          title={
            answering
              ? "Guardar como respuesta oficial"
              : editing
                ? "Editar respuesta"
                : basicsRun
                  ? "Responder lo básico"
                  : "Nueva respuesta"
          }
          description={
            answering
              ? `La próxima vez que lo pregunten, ${receptionName} responderá con esto.`
              : basicsRun
                ? runNext
                  ? `Faltan ${missing.length}. Al guardar pasas a la siguiente.`
                  : "Es la última que falta."
                : `${receptionName} la cita tal cual. Escríbela como se la dirías a un paciente.`
          }
          onSubmit={submit}
          isSubmitting={saveMutation.isPending}
          isDirty={formDirty}
          error={error}
          submitLabel={answering ? "Guardar y publicar" : runNext ? "Guardar y seguir" : "Guardar"}
          cancelLabel="Cancelar"
          submitDisabled={incomplete || isAmbiguousMutationError(saveMutation.error)}
        >
          <FieldGroup>
            {answering ? (
              <>
                <div className="flex flex-col gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  <p className="[overflow-wrap:anywhere]">
                    <span className="font-semibold">Preguntaron:</span> «{answering.question}»
                    {answering.count > 1 ? ` · ${answering.count} veces` : ""}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4">
                    <Link
                      to="/inbox"
                      search={{ conversation: answering.conversationId }}
                      className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline sm:min-h-8"
                    >
                      Ver la conversación
                    </Link>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className={`h-auto p-0 text-muted-foreground ${TOUCH}`}
                      disabled={discardMutation.isPending || saveMutation.isPending}
                      onClick={() => discardMutation.mutate(answering)}
                    >
                      No hace falta responderla: descartar
                    </Button>
                  </div>
                  {discardMutation.isError ? (
                    <p role="alert" className="text-destructive">
                      {mutationErrorMessage(discardMutation.error) ?? "No pudimos descartar la pregunta."}
                    </p>
                  ) : null}
                </div>
                {publishedEntries.length > 0 ? (
                  <Field>
                    <FieldLabel htmlFor="nc-existente">¿Ya tienes una respuesta para esto?</FieldLabel>
                    <Select
                      value={form.existingId || "nueva"}
                      onValueChange={(value) => setForm({ ...form, existingId: !value || value === "nueva" ? "" : value })}
                    >
                      <SelectTrigger id="nc-existente" aria-label="Respuesta existente" className="w-full">
                        <SelectValue>
                          {publishedEntries.find((entry) => entry.id === form.existingId)?.title ?? "No, escribir una nueva"}
                        </SelectValue>
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
            {basicsRun && missing.length > 1 ? (
              <Field>
                <FieldLabel htmlFor="nc-falta">Pregunta básica</FieldLabel>
                <Select
                  value={form.basicKey}
                  onValueChange={(value) => {
                    const item = missing.find((candidate) => candidate.key === value)
                    if (!item) return
                    // Cambiar de pregunta conserva lo escrito en la respuesta.
                    setForm({ ...form, title: item.question, basicKey: item.key })
                    setBaseline({ ...baseline, title: item.question, basicKey: item.key })
                  }}
                >
                  <SelectTrigger id="nc-falta" aria-label="Pregunta básica" className="w-full">
                    <SelectValue>{missing.find((item) => item.key === form.basicKey)?.question ?? "Elige una pregunta"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {missing.map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.question}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Puedes responderlas en el orden que quieras.</FieldDescription>
              </Field>
            ) : null}
            {usesExisting ? null : (
              <>
                {creating && !basicsRun ? (
                  <Field>
                    <FieldLabel htmlFor="nc-tipo">Tipo</FieldLabel>
                    <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value ?? "faq" })}>
                      <SelectTrigger id="nc-tipo" aria-label="Tipo" className="w-full">
                        <SelectValue>{KIND_LABEL[form.kind] ?? form.kind}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(KIND_LABEL).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="nc-titulo">La pregunta</FieldLabel>
                  <Input
                    id="nc-titulo"
                    value={form.title}
                    maxLength={TITLE_CHARS}
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
                  <FieldDescription>Una por línea. Ayudan a {receptionName} a encontrar esta respuesta.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="nc-sede">Sede</FieldLabel>
                  <Select
                    value={form.branchId || "todas"}
                    onValueChange={(value) => setForm({ ...form, branchId: !value || value === "todas" ? "" : value })}
                  >
                    <SelectTrigger id="nc-sede" aria-label="Sede" className="w-full">
                      <SelectValue>
                        {form.branchId
                          ? `Solo ${branchOptions.find((branch) => branch.id === form.branchId)?.name ?? "una sede"}`
                          : "Todas las sedes"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todas">Todas las sedes</SelectItem>
                      {branchOptions.map((branch) => (
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
                    <DatePickerButton
                      id="nc-desde"
                      className="w-full"
                      value={form.validFrom}
                      emptyLabel="Desde ya"
                      onChange={(validFrom) =>
                        setForm({
                          ...form,
                          validFrom,
                          // Un periodo no termina antes de empezar.
                          validUntil: form.validUntil && validFrom && form.validUntil < validFrom ? validFrom : form.validUntil,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="nc-hasta">Vale hasta</FieldLabel>
                    <DatePickerButton
                      id="nc-hasta"
                      className="w-full"
                      value={form.validUntil}
                      min={form.validFrom || undefined}
                      emptyLabel="Sin vencimiento"
                      onChange={(validUntil) => setForm({ ...form, validUntil })}
                    />
                  </Field>
                </div>
                <p className="-mt-2 text-sm text-muted-foreground">
                  Déjalas vacías si vale siempre. Pasada la fecha, {receptionName} deja de usarla sin que hagas nada.
                </p>
                {basicsRun ? null : (
                  <Field>
                    <FieldLabel htmlFor="nc-basica">Pregunta básica que cubre</FieldLabel>
                    <Select
                      value={form.basicKey || "ninguna"}
                      onValueChange={(value) => setForm({ ...form, basicKey: !value || value === "ninguna" ? "" : value })}
                    >
                      <SelectTrigger id="nc-basica" aria-label="Pregunta básica" className="w-full">
                        <SelectValue>
                          {(basics?.items ?? []).find((item) => item.key === form.basicKey)?.question ?? "Ninguna"}
                        </SelectValue>
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
                )}
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
                    <FieldDescription>Sin publicar queda como borrador y {receptionName} no la usa.</FieldDescription>
                  </Field>
                ) : null}
              </>
            )}
          </FieldGroup>
        </FormDrawer>
      ) : null}
    </PageShell>
  )
}
