import { Button, Checkbox, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import {
  impactSummary,
  LESSON_KIND_LABEL,
  type LessonImpact,
  type LessonItem,
  type LessonKind,
  type LessonPreview,
  lessonScopeLabel,
} from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { mutationErrorMessage } from "../../lib/query-error"

const KINDS: LessonKind[] = ["respuesta_oficial", "regla", "ejemplo"]
const SCOPE_WHY: Record<LessonKind, string> = {
  respuesta_oficial: "Es un dato de la clínica: lo usa cualquier agente que lo necesite.",
  regla: "Es una regla de comportamiento: vale solo para este agente.",
  ejemplo: "Es un ejemplo de cómo responder: lo usa solo este agente, en preguntas parecidas.",
}
const WITHDRAW_LABEL: Record<LessonKind, string> = {
  respuesta_oficial: "Retirar la respuesta",
  regla: "Retirar la regla",
  ejemplo: "Retirar el ejemplo",
}

function BeforeAfter({ before, after, beforeLabel = "Antes", afterLabel = "Después" }: { before: string; after: string; beforeLabel?: string; afterLabel?: string }) {
  return (
    <dl className="grid gap-2 text-sm">
      <div className="rounded-xl border bg-muted/50 p-3">
        <dt className="text-xs font-semibold text-muted-foreground">{beforeLabel}</dt>
        <dd className="whitespace-pre-wrap">{before || "—"}</dd>
      </div>
      <div className="rounded-xl border border-agent-border bg-agent-soft p-3">
        <dt className="text-xs font-semibold text-primary-soft-foreground">{afterLabel}</dt>
        <dd className="whitespace-pre-wrap">{after || "—"}</dd>
      </div>
    </dl>
  )
}

/**
 * Una lección, de principio a fin: propuesta (ver, editar, probar, aprobar o
 * descartar), activa (probar qué pasa sin ella y retirarla) y retirada
 * (restaurar). Nada se activa ni se retira sin que una persona lo decida aquí.
 */
export function LessonDrawer({ lessonId, canWrite, onClose }: { lessonId: string | null; canWrite: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<{ title: string; body: string; kind: LessonKind }>({ title: "", body: "", kind: "regla" })
  const [withdrawCase, setWithdrawCase] = useState(false)

  const query = useQuery({
    queryKey: ["agent-lesson", lessonId],
    queryFn: () => apiFetch<{ data: { lesson: LessonItem; impact: LessonImpact } }>(`/api/agent/learning/lessons/${lessonId}`),
    enabled: lessonId !== null,
    retry: false,
  })
  const lesson = query.data?.data.lesson ?? null
  const impact = query.data?.data.impact ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de lección o de estado, para no pisar lo que se está escribiendo.
  useEffect(() => {
    if (!lesson) return
    setDraft({ title: lesson.title, body: lesson.body, kind: lesson.kind })
    setEditing(false)
    setWithdrawCase(false)
  }, [lesson?.id, lesson?.status])

  const refresh = () => {
    for (const key of ["agent-learning", "agent-lesson", "agent-overview", "agent-knowledge", "agent-knowledge-basics"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  const act = useMutation({
    retry: false,
    mutationFn: (input: { action: "approve" | "discard" | "withdraw" | "restore"; body?: unknown }) =>
      apiFetch(`/api/agent/learning/lessons/${lessonId}/${input.action}`, {
        method: "POST",
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      }),
    onSuccess: () => {
      refresh()
      close()
    },
  })
  const save = useMutation({
    retry: false,
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/agent/learning/lessons/${lessonId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      preview.reset()
      setEditing(false)
      refresh()
    },
  })
  // Llama al modelo: solo cuando la persona lo pide.
  const preview = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: LessonPreview }>(`/api/agent/learning/lessons/${lessonId}/preview`, { method: "POST" }),
  })

  function close() {
    act.reset()
    save.reset()
    preview.reset()
    onClose()
  }

  const proposed = lesson?.status === "propuesta"
  const active = lesson?.status === "activa"
  const dirty = Boolean(lesson) && editing && (draft.title !== lesson?.title || draft.body !== lesson?.body || draft.kind !== lesson?.kind)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!lesson || act.isPending || save.isPending) return
    if (editing) save.mutate({ title: draft.title.trim(), body: draft.body.trim(), kind: draft.kind })
    else if (proposed) act.mutate({ action: "approve" })
    else if (active) act.mutate({ action: "withdraw", body: { withdrawCase } })
    else if (lesson.status === "retirada") act.mutate({ action: "restore" })
  }

  const submitLabel = editing
    ? "Guardar cambios"
    : proposed
      ? "Aprobar y activar"
      : active
        ? WITHDRAW_LABEL[lesson.kind]
        : "Restaurar"
  const title = !lesson
    ? "Lección"
    : proposed
      ? "Lección propuesta"
      : active
        ? `Retirar «${lesson.title}»`
        : `Restaurar «${lesson.title}»`
  const previewError =
    preview.error instanceof ApiError
      ? (preview.error.shape.message ?? "No pudimos probarla")
      : preview.error
        ? "No pudimos probarla. Vuelve a intentarlo."
        : null
  const changesExisting = lesson?.kind === "respuesta_oficial" && lesson.knowledgeEntry !== null && lesson.status === "propuesta"

  return (
    <FormDrawer
      open={lessonId !== null}
      onClose={close}
      title={title}
      description={lesson ? `${LESSON_KIND_LABEL[lesson.kind]} · ${lessonScopeLabel(lesson.scope)}` : undefined}
      onSubmit={submit}
      isSubmitting={act.isPending || save.isPending}
      isLoading={query.isPending && lessonId !== null}
      isDirty={dirty}
      error={query.isError ? "No pudimos cargar la lección." : mutationErrorMessage(act.error ?? save.error)}
      submitLabel={submitLabel}
      cancelLabel={editing ? "Cancelar" : "Cerrar"}
      hideSubmit={!canWrite || !lesson || lesson.status === "descartada"}
      submitDisabled={editing && (!draft.title.trim() || !draft.body.trim())}
    >
      <div className="flex flex-col gap-5">
      {lesson ? (
        editing ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-semibold">Qué clase de lección es</legend>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((kind) => (
                  <Button
                    key={kind}
                    type="button"
                    size="sm"
                    variant={draft.kind === kind ? "default" : "outline"}
                    aria-pressed={draft.kind === kind}
                    className="min-h-11 rounded-full sm:min-h-8"
                    onClick={() => setDraft({ ...draft, kind })}
                  >
                    {LESSON_KIND_LABEL[kind]}
                  </Button>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">{SCOPE_WHY[draft.kind]}</p>
            </fieldset>
            <Field>
              <FieldLabel htmlFor="leccion-titulo">Título</FieldLabel>
              <Input id="leccion-titulo" maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="leccion-texto">
                {draft.kind === "regla" ? "La regla" : draft.kind === "ejemplo" ? "La respuesta de ejemplo" : "La respuesta oficial"}
              </FieldLabel>
              <Textarea id="leccion-texto" rows={6} maxLength={2000} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </Field>
          </>
        ) : (
          <>
            <section aria-labelledby="leccion-titulo-ver" className="flex flex-col gap-1">
              <h3 id="leccion-titulo-ver" className="font-heading text-base font-semibold">
                {changesExisting ? `Cambiar la respuesta «${lesson.knowledgeEntry?.title}»` : lesson.title}
              </h3>
              <p className="text-sm text-muted-foreground">
                {lesson.question ? `De una corrección a la pregunta «${lesson.question}».` : "De una corrección de tu equipo."}
                {lesson.proposedByName ? ` La hizo ${lesson.proposedByName}.` : ""}
                {lesson.approvedByName && lesson.approvedAt
                  ? ` La aprobó ${lesson.approvedByName} el ${new Date(lesson.approvedAt).toLocaleDateString("es-PE", { day: "numeric", month: "long" })}.`
                  : ""}
              </p>
            </section>

            <section aria-labelledby="leccion-alcance" className="flex flex-col gap-1 text-sm">
              <h3 id="leccion-alcance" className="font-semibold">
                A quién se aplica
              </h3>
              <p>
                {lessonScopeLabel(lesson.scope)}. <span className="text-muted-foreground">{SCOPE_WHY[lesson.kind]}</span>
              </p>
            </section>

            <section aria-labelledby="leccion-cambio" className="flex flex-col gap-2">
              <h3 id="leccion-cambio" className="text-sm font-semibold">
                {active ? "Qué dice" : "Qué cambia"}
              </h3>
              {active || lesson.status === "retirada" ? (
                <p className="whitespace-pre-wrap rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">{lesson.body}</p>
              ) : changesExisting ? (
                <BeforeAfter before={lesson.knowledgeEntry?.body ?? ""} after={lesson.body} />
              ) : (
                <BeforeAfter before={lesson.originalReply} after={lesson.body} beforeLabel="Respondió" afterLabel="Aprende" />
              )}
              {changesExisting && canWrite ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto min-h-11 self-start p-0 sm:min-h-8"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ knowledgeEntryId: null })}
                >
                  Guardarla como respuesta nueva, sin cambiar la que ya existe
                </Button>
              ) : null}
            </section>

            {proposed || active ? (
              <section aria-labelledby="leccion-casos" className="flex flex-col gap-2 text-sm">
                <h3 id="leccion-casos" className="font-semibold">
                  {active ? "Qué pasa si la retiras" : "Tus casos de prueba"}
                </h3>
                {impact ? <p>{impactSummary(impact)}</p> : null}
                {preview.data ? (
                  <ul className="flex flex-col gap-3">
                    {preview.data.data.cases.map((item) => (
                      <li key={item.question} className="flex flex-col gap-1.5">
                        <p className="font-medium">«{item.question}»</p>
                        {item.same ? (
                          <p className="text-muted-foreground">Responde igual: «{item.after}»</p>
                        ) : (
                          <BeforeAfter before={item.before} after={item.after} beforeLabel="Hoy" afterLabel={active ? "Sin la lección" : "Con la lección"} />
                        )}
                      </li>
                    ))}
                    {preview.data.data.cases.length === 0 ? <li className="text-muted-foreground">No hay ninguna pregunta que volver a responder.</li> : null}
                    {preview.data.data.model === "fake" ? (
                      <li className="text-xs text-muted-foreground">
                        Modelo de demostración: siempre responde lo mismo, así que esta prueba no dice cómo respondería un proveedor real.
                      </li>
                    ) : null}
                  </ul>
                ) : canWrite ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 self-start sm:min-h-8"
                      disabled={preview.isPending}
                      onClick={() => preview.mutate()}
                    >
                      {preview.isPending ? "Respondiendo…" : active ? "Ver cómo respondería sin ella" : "Ver cómo respondería con ella"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Vuelve a responder la pregunta que la originó y los casos que tocan el tema. Usa el modelo: tarda unos segundos.
                    </p>
                  </>
                ) : null}
                {previewError ? (
                  <p role="alert" className="text-destructive">
                    {previewError}
                  </p>
                ) : null}
              </section>
            ) : null}

            {proposed ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {lesson.question
                    ? "La pregunta queda guardada como caso de prueba. Si después no te convence, la retiras y todo vuelve a como estaba."
                    : "Si después no te convence, la retiras y todo vuelve a como estaba."}
                </p>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setEditing(true)}>
                      Editar el texto
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ action: "discard" })}
                    >
                      Descartar
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm">La aprueba quien administra el agente.</p>
                )}
              </>
            ) : null}

            {active && canWrite ? (
              <>
                <label htmlFor="leccion-retirar-caso" className="flex min-h-11 cursor-pointer items-start gap-2 text-sm sm:min-h-8">
                  <Checkbox
                    id="leccion-retirar-caso"
                    className="mt-0.5"
                    checked={withdrawCase}
                    onCheckedChange={(value) => setWithdrawCase(value === true)}
                  />
                  <span>
                    Retirar también su caso de prueba
                    <span className="block text-muted-foreground">Si lo dejas, seguirá esperando la respuesta de hoy.</span>
                  </span>
                </label>
                <p className="text-sm text-muted-foreground">
                  Deja de usarla al instante. Queda en Retiradas con su historia y la puedes restaurar cuando quieras.
                </p>
              </>
            ) : null}
            {lesson.status === "retirada" ? (
              <p className="text-sm text-muted-foreground">Está retirada: el agente no la usa. Restaurarla la vuelve a activar tal como estaba.</p>
            ) : null}
          </>
        )
      ) : null}
      </div>
    </FormDrawer>
  )
}
