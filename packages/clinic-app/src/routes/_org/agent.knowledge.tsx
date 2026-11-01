import {
  Badge,
  Button,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  DatePickerButton,
  ErrorState,
  FormDrawer,
  PageHeader,
  PageShell,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  useListSearch,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useRef, useState } from "react"
import { z } from "zod"
import { KnowledgeAnswers } from "../../components/agent/knowledge-answers"
import { KnowledgeBasics } from "../../components/agent/knowledge-basics"
import { KnowledgeDetail } from "../../components/agent/knowledge-detail"
import {
  type KnowledgeBasics as Basics,
  type KnowledgeBasicItem,
  type KnowledgeEntry,
  type KnowledgeSources as Sources,
} from "../../components/agent/knowledge-model"
import { KnowledgeSources } from "../../components/agent/knowledge-sources"
import { LessonDrawer } from "../../components/agent/lesson-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { KnowledgePageSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/knowledge")({
  pendingComponent: KnowledgePageSkeleton,
  component: AgentKnowledgePage,
})

const KIND_LABEL: Record<string, string> = { faq: "Pregunta frecuente", info_sede: "Información de sede", politica: "Política" }
/** Límites de una respuesta en el servidor (`agent-knowledge.ts`, `knowledge.ts`). */
const TITLE_CHARS = 200
const BODY_CHARS = 8000
const ASK_FORM_CHARS = 120
const ASK_FORM_LIMIT = 20

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
}

/** Lo que se revisa al guardar, con las palabras y los límites del servidor. */
const draftSchema = z
  .object({
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    branchId: z.string(),
    validFrom: z.string(),
    validUntil: z.string(),
    askForms: z.string(),
    basicKey: z.string(),
    publish: z.boolean(),
  })
  .superRefine((draft, ctx) => {
    const title = draft.title.trim()
    if (!title) ctx.addIssue({ code: "custom", path: ["title"], message: "Escribe la pregunta." })
    else if (title.length > TITLE_CHARS) {
      ctx.addIssue({ code: "custom", path: ["title"], message: `Escribe como mucho ${TITLE_CHARS} caracteres.` })
    }
    const body = draft.body.trim()
    if (!body) ctx.addIssue({ code: "custom", path: ["body"], message: "Escribe la respuesta." })
    else if (body.length > BODY_CHARS) {
      ctx.addIssue({ code: "custom", path: ["body"], message: `Escribe como mucho ${BODY_CHARS} caracteres.` })
    }
    // El servidor junta los espacios de cada forma antes de medirla.
    const lines = draft.askForms.split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    const long = lines.findIndex((line) => line.length > ASK_FORM_CHARS)
    if (long >= 0) {
      ctx.addIssue({ code: "custom", path: ["askForms"], message: `La línea ${long + 1} pasa de ${ASK_FORM_CHARS} caracteres.` })
    } else if (lines.filter(Boolean).length > ASK_FORM_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["askForms"],
        message: `Escribe hasta ${ASK_FORM_LIMIT} formas de preguntar, una por línea.`,
      })
    }
    if (draft.validFrom && draft.validUntil && draft.validUntil < draft.validFrom) {
      ctx.addIssue({ code: "custom", path: ["validUntil"], message: "La vigencia termina antes de empezar." })
    }
  })

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
  /** «Responder las que faltan»: al guardar una pregunta básica se pasa a la siguiente. */
  const [basicsRun, setBasicsRun] = useState(false)
  /** Valores con los que se abrió el cajón: el formulario vuelve a ellos al reiniciarse. */
  const [draftStart, setDraftStart] = useState<Draft>(EMPTY_DRAFT)
  const formOpen = creating || editing !== null

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
  }

  /** Alta cuya publicación falló: reintentar la corrige y la publica, no crea otra. */
  const createdId = useRef<string | null>(null)
  const saveMutation = useMutation({
    retry: false,
    mutationFn: async ({ draft, editingId }: { draft: Draft; editingId: string | null }) => {
      const payload = {
        title: draft.title,
        body: draft.body,
        branchId: draft.branchId || null,
        validFrom: draft.validFrom || null,
        validUntil: draft.validUntil || null,
        askForms: draft.askForms.split("\n").map((line) => line.trim()).filter(Boolean),
        basicKey: draft.basicKey || null,
      }
      if (editingId) {
        return apiFetch(`/api/agent/knowledge/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) })
      }
      if (createdId.current) {
        await apiFetch(`/api/agent/knowledge/${createdId.current}`, { method: "PATCH", body: JSON.stringify(payload) })
      } else {
        const created = await apiFetch<{ data: KnowledgeEntry }>("/api/agent/knowledge", {
          method: "POST",
          body: JSON.stringify({ kind: draft.kind, ...payload }),
        })
        createdId.current = created.data.id
      }
      if (draft.publish) {
        await apiFetch(`/api/agent/knowledge/${createdId.current}/status`, {
          method: "POST",
          body: JSON.stringify({ status: "publicada" }),
        })
      }
    },
    // Si el alta salió y la publicación no, la respuesta existe como borrador: se refleja ya.
    onSettled: () => invalidate(),
  })

  /** Lo que el envío necesita saber de la pantalla al guardar (se actualiza en cada render). */
  const submitContext = useRef<{ editing: KnowledgeEntry | null; next: Draft | null }>({
    editing: null,
    next: null,
  })
  const form = useAppForm({
    defaultValues: draftStart,
    validators: { onSubmit: draftSchema },
    onSubmit: async ({ value, formApi }) => {
      const { editing: entry, next } = submitContext.current
      await saveMutation.mutateAsync({ draft: value, editingId: entry?.id ?? null })
      createdId.current = null
      // `next`: la pregunta básica que sigue cuando se están respondiendo las que faltan.
      if (next) {
        saveMutation.reset()
        setDraftStart(next)
        formApi.reset(next)
      } else closeForm()
    },
  })
  const surface = useFormSurface(form, {
    // Cada forma de preguntar que el servidor señala (`askForms[2]`) va al campo de formas.
    fieldMap: (key) => (key.startsWith("askForms") ? "askForms" : undefined),
  })
  const values = useStore(form.store, (state) => state.values)
  const formDirty = formOpen && surface.isDirty

  const statusMutation = useMutation({
    retry: false,
    mutationFn: (entry: KnowledgeEntry) =>
      apiFetch(`/api/agent/knowledge/${entry.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: entry.status === "publicada" ? "borrador" : "publicada" }),
      }),
    onSuccess: () => invalidate(),
  })

  const entries = entriesQuery.data?.pages.flatMap((page) => page.data) ?? []
  const entriesTotal = entriesQuery.data?.pages[0]?.total ?? entries.length
  const basics = basicsQuery.data?.data ?? null
  const branches = (branchesQuery.data?.data ?? []).filter((branch) => branch.isActive !== false)

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso al conocimiento del agente. Solicita acceso a la administración." />
      </PageShell>
    )
  }

  const missing = basics?.items.filter((item) => !item.covered) ?? []
  const detail = entries.find((entry) => entry.id === detailId) ?? null

  function open(next: Draft, target: { entry?: KnowledgeEntry; basicsRun?: boolean }) {
    saveMutation.reset()
    createdId.current = null
    setDetailId(null)
    setDraftStart(next)
    form.reset(next)
    setEditing(target.entry ?? null)
    setCreating(!target.entry)
    setBasicsRun(target.basicsRun === true)
  }

  function openCreate() {
    open(EMPTY_DRAFT, {})
  }

  /** «Lo que solo tú sabes»: empieza por la primera que falta y sigue con las demás. */
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

  function closeForm() {
    setEditing(null)
    setCreating(false)
    setBasicsRun(false)
  }

  // En «Responder las que faltan», la que sigue a la que se está respondiendo.
  const runRest = basicsRun ? missing.filter((item) => item.key !== values.basicKey) : []
  const runIndex = missing.findIndex((item) => item.key === values.basicKey)
  const runNext = runRest.length > 0 ? (missing.slice(runIndex + 1).find((item) => item.key !== values.basicKey) ?? runRest[0]) : undefined
  submitContext.current = { editing, next: runNext ? basicDraft(runNext) : null }

  // Una respuesta perdida tras guardar no se sabe si quedó: no se vuelve a enviar a ciegas.
  const ambiguous = isAmbiguousMutationError(saveMutation.error)
  function submit(event: FormEvent) {
    if (ambiguous) {
      event.preventDefault()
      return
    }
    surface.onSubmit(event)
  }

  const branchOptions = editing?.branchId && editing.branchName && !branches.some((branch) => branch.id === editing.branchId)
    ? [...branches, { id: editing.branchId, name: editing.branchName }]
    : branches

  return (
    <PageShell className={`flex flex-col gap-6 ${canWrite ? "max-sm:pb-24" : ""}`}>
      <PageDraftGuard dirty={formDirty || saveMutation.isPending} />
      <PageHeader
        title="Agente"
        subtitle={`Lo que ${receptionName} sabe para atender. Lo de tus datos lo lee en el momento; aquí agregas lo que solo tú sabes.`}
      />
      <AgentTabs />
      {/* Conocimiento es de recepción (ADR 0120): Clío y Argos no lo usan. */}
      <p className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="soft">Solo {receptionName}</Badge>
        Es lo que usa para responder a pacientes. Clío y Argos no lo usan.
      </p>

      <KnowledgeBasics
        basics={basics}
        isPending={basicsQuery.isPending}
        error={basicsQuery.isError ? basicsQuery.error : null}
        onRetry={() => void basicsQuery.refetch()}
        canWrite={canWrite}
        onAnswerMissing={startBasics}
      />

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
        statusError={statusMutation.error ? submitErrorMessage(statusMutation.error) : null}
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
          title={editing ? "Editar respuesta" : basicsRun ? "Responder lo que solo tú sabes" : "Nueva respuesta"}
          description={
            basicsRun
              ? runNext
                ? `Faltan ${missing.length}. Al guardar pasas a la siguiente; puedes dejar cualquiera sin responder.`
                : "Es la última que falta."
              : `${receptionName} la cita tal cual. Escríbela como se la dirías a un paciente.`
          }
          {...surface}
          onSubmit={submit}
          submitLabel={runNext ? "Guardar y seguir" : "Guardar"}
          cancelLabel="Cancelar"
          submitDisabled={ambiguous}
          // Mientras no se pueda volver a guardar, el porqué sigue a la vista aunque se escriba.
          error={ambiguous ? submitErrorMessage(saveMutation.error) : surface.error}
        >
          <FieldGroup>
            {basicsRun && missing.length > 1 ? (
              <form.AppField name="basicKey">
                {(field) => (
                  <field.Control id="nc-falta" label="Pregunta" description="Puedes responderlas en el orden que quieras.">
                    {(control) => (
                      <Select
                        value={field.state.value}
                        onValueChange={(value) => {
                          const item = missing.find((candidate) => candidate.key === value)
                          if (!item) return
                          // Cambiar de pregunta conserva lo escrito en la respuesta y no cuenta como cambio.
                          form.setFieldValue("title", item.question, { dontUpdateMeta: true })
                          form.setFieldValue("basicKey", item.key, { dontUpdateMeta: true })
                        }}
                      >
                        <SelectTrigger
                          id={control.id}
                          aria-invalid={control.invalid || undefined}
                          aria-describedby={control.describedBy}
                          className="w-full"
                        >
                          <SelectValue>{missing.find((item) => item.key === field.state.value)?.question ?? "Elige una pregunta"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {missing.map((item) => (
                            <SelectItem key={item.key} value={item.key}>
                              {item.question}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : null}
                {creating && !basicsRun ? (
                  <form.AppField name="kind">
                    {(field) => (
                      <field.SelectField
                        id="nc-tipo"
                        label="Tipo"
                        options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
                      />
                    )}
                  </form.AppField>
                ) : null}
                <form.AppField name="title">
                  {(field) => (
                    <field.TextField id="nc-titulo" label="La pregunta" maxLength={TITLE_CHARS} placeholder="¿Atienden sin cita?" />
                  )}
                </form.AppField>
                <form.AppField name="body">
                  {(field) => (
                    <field.TextareaField
                      id="nc-cuerpo"
                      label="La respuesta"
                      rows={5}
                      maxLength={BODY_CHARS}
                      placeholder="Respuesta oficial…"
                    />
                  )}
                </form.AppField>
                <form.AppField name="askForms">
                  {(field) => (
                    <field.TextareaField
                      id="nc-formas"
                      label="Otras formas de preguntarlo"
                      description={`Una por línea. Ayudan a ${receptionName} a encontrar esta respuesta.`}
                      rows={3}
                      placeholder={"¿Puedo ir sin reservar?\n¿Reciben pacientes sin turno?"}
                    />
                  )}
                </form.AppField>
                <form.AppField name="branchId">
                  {(field) => (
                    <field.SelectField
                      id="nc-sede"
                      label="Sede"
                      options={[
                        { value: "", label: "Todas las sedes" },
                        ...branchOptions.map((branch) => ({ value: branch.id, label: `Solo ${branch.name}` })),
                      ]}
                    />
                  )}
                </form.AppField>
                <FieldSet>
                  <FieldLegend variant="label">Vigencia</FieldLegend>
                  <FieldDescription>
                    Déjalas vacías si vale siempre. Pasada la fecha, {receptionName} deja de usarla sin que hagas nada.
                  </FieldDescription>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <form.AppField name="validFrom">
                      {(field) => (
                        <field.Control id="nc-desde" label="Vale desde">
                          {(control) => (
                            <DatePickerButton
                              {...control.props}
                              className="w-full"
                              value={field.state.value}
                              emptyLabel="Desde ya"
                              onChange={(validFrom) => {
                                field.handleChange(validFrom)
                                // Un periodo no termina antes de empezar.
                                const validUntil = form.getFieldValue("validUntil")
                                if (validUntil && validFrom && validUntil < validFrom) form.setFieldValue("validUntil", validFrom)
                              }}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                    <form.AppField name="validUntil">
                      {(field) => (
                        <field.Control id="nc-hasta" label="Vale hasta">
                          {(control) => (
                            <DatePickerButton
                              {...control.props}
                              className="w-full"
                              value={field.state.value}
                              min={values.validFrom || undefined}
                              emptyLabel="Sin vencimiento"
                              onChange={(validUntil) => field.handleChange(validUntil)}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  </div>
                </FieldSet>
                {basicsRun ? (
                  // Lo que ya está en los datos no se escribe otra vez (ADR 0120).
                  <div className="flex flex-col gap-1 rounded-xl border border-agent-border bg-agent-soft px-3.5 py-3 text-sm text-primary-soft-foreground">
                    <span className="font-semibold">Esto ya lo sabe por tus datos</span>
                    <span>
                      Horario, sedes, equipo, servicios con su precio y duración, promociones, medios de pago y urgencias. Si algo está mal, se
                      corrige donde vive.
                    </span>
                  </div>
                ) : (
                  <form.AppField name="basicKey">
                    {(field) => (
                      <field.SelectField
                        id="nc-basica"
                        label="Responde a «Lo que solo tú sabes»"
                        options={[
                          { value: "", label: "Ninguna" },
                          ...(basics?.items ?? []).map((item) => ({ value: item.key, label: item.question })),
                          // Una respuesta de antes puede tener una pregunta que ya no está en la lista: se conserva.
                          ...(values.basicKey && !(basics?.items ?? []).some((item) => item.key === values.basicKey)
                            ? [{ value: values.basicKey, label: "Una pregunta de la lista anterior" }]
                            : []),
                        ]}
                      />
                    )}
                  </form.AppField>
                )}
                {creating ? (
                  <form.AppField name="publish">
                    {(field) => (
                      <field.CheckboxField
                        id="nc-publicar"
                        label="Publicar al guardar"
                        description={`Sin publicar queda como borrador y ${receptionName} no la usa.`}
                      />
                    )}
                  </form.AppField>
                ) : null}
          </FieldGroup>
        </FormDrawer>
      ) : null}
    </PageShell>
  )
}
