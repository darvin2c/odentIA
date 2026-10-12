import { Badge, Button, Checkbox, cn, Field, FieldLabel, Input, Textarea, useIsMobile } from "@odentia/ui"
import { AgentMark, ConfirmDialog, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Undo2 } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import {
  agentName,
  impactSummary,
  LESSON_KIND_LABEL,
  type LessonImpact,
  type LessonItem,
  type LessonKind,
  type LessonPreview,
  lessonScopeChip,
  lessonUsage,
  previewCounts,
  previewSummary,
} from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { mutationErrorMessage } from "../../lib/query-error"
import { SURFACE_ACTIONS } from "./correct-drawer"

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
const WITHOUT_LABEL: Record<LessonKind, string> = {
  respuesta_oficial: "Sin la respuesta",
  regla: "Sin la regla",
  ejemplo: "Sin el ejemplo",
}
const SECTION_TITLE = "text-xs font-bold tracking-wider text-muted-foreground uppercase"
const LESSON_QUERIES = ["agent-learning", "agent-lesson", "agent-overview", "agent-knowledge", "agent-knowledge-basics"]

/** «hoy», «ayer», «el martes» (esta semana) o «el 3 de octubre». */
function dayOf(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return "hoy"
  if (days === 1) return "ayer"
  if (days < 7) return `el ${date.toLocaleDateString("es", { weekday: "long" })}`
  return `el ${date.toLocaleDateString("es", { day: "numeric", month: "long" })}`
}

/**
 * De dónde sale una lección, con lo que el servidor registra: qué la originó,
 * quién, cuándo, de qué agente era la respuesta y quién la recibió. `short`
 * deja solo el origen y el día, para la tarjeta de la lista.
 */
export function lessonOriginText(lesson: LessonItem, options: { short?: boolean } = {}): string {
  const day = dayOf(lesson.createdAt)
  // «de hoy», «de ayer», «del martes».
  const ofDay = day.startsWith("el ") ? `del ${day.slice(3)}` : `de ${day}`
  const who = lesson.proposedByName
  const agent = agentName(lesson.agent)
  const received = lesson.contactName ? `, la que recibió ${lesson.contactName}` : ""
  if (lesson.origin === "borrador_editado") {
    if (options.short) return `De un borrador que tu equipo cambió antes de aprobarlo, ${day}.`
    return `De un borrador de ${agent} que ${who ?? "tu equipo"} cambió antes de aprobarlo, ${day}${lesson.contactName ? `. Era para ${lesson.contactName}` : ""}.`
  }
  if (lesson.origin === "respuesta_buena") {
    if (options.short) return `De una respuesta que tu equipo dio por buena, ${day}.`
    return `De una respuesta de ${agent} que ${who ?? "tu equipo"} dio por buena, ${day}${received}.`
  }
  if (options.short) return `De una corrección ${ofDay}.`
  return `De una corrección ${ofDay}${who ? `, de ${who},` : ""} a una respuesta de ${agent}${received}.`
}

function BeforeAfter({
  before,
  after,
  beforeLabel = "Antes",
  afterLabel = "Después",
  strike = false,
}: {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  /** Tacha lo que deja de valer; la etiqueta ya lo dice sin depender del tachado. */
  strike?: boolean
}) {
  return (
    <dl className="grid gap-2 text-sm">
      <div className="flex flex-col gap-0.5 rounded-xl bg-muted px-3.5 py-3">
        <dt className="text-xs font-bold text-muted-foreground">{beforeLabel}</dt>
        <dd className={cn("whitespace-pre-wrap", strike ? "text-muted-foreground line-through" : "")}>{before || "—"}</dd>
      </div>
      <div className="flex flex-col gap-0.5 rounded-xl bg-success-soft px-3.5 py-3">
        <dt className="text-xs font-bold text-success">{afterLabel}</dt>
        <dd className="whitespace-pre-wrap">{after || "—"}</dd>
      </div>
    </dl>
  )
}

/**
 * El resultado de probar una lección, cuando ya se pidió: cuántas responden
 * igual y cuántas cambian, la proporción y cada pregunta con su antes y su
 * ahora. No lanza la prueba: solo presenta lo que devolvió.
 */
function PreviewResult({ preview, beforeLabel, afterLabel }: { preview: LessonPreview; beforeLabel: string; afterLabel: string }) {
  const counts = previewCounts(preview)
  const rest = counts.total - counts.answered
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <p className="font-bold">
          Lo probé con {counts.total} {counts.total === 1 ? "pregunta" : "preguntas"}
        </p>
        {counts.total > 0 ? <p className="text-muted-foreground">{previewSummary(counts)}</p> : null}
      </div>
      {counts.total > 0 ? (
        <div
          role="img"
          aria-label={`${counts.same} ${counts.same === 1 ? "igual" : "iguales"} y ${counts.changed} que ${counts.changed === 1 ? "cambia" : "cambian"}`}
          className="flex h-3 gap-[3px]"
        >
          {counts.same > 0 ? <span className="rounded-full bg-primary/40" style={{ flexGrow: counts.same, flexBasis: 0 }} /> : null}
          {counts.changed > 0 ? <span className="rounded-full bg-warning/70" style={{ flexGrow: counts.changed, flexBasis: 0 }} /> : null}
        </div>
      ) : (
        <p className="text-muted-foreground">No hay ninguna pregunta que volver a responder.</p>
      )}
      <ul className="flex flex-col">
        {preview.cases.map((item) => (
          <li key={item.question} className="flex flex-col gap-1.5 border-t py-2.5 last:pb-0">
            <p className="font-semibold">{item.question}</p>
            {item.same ? (
              <p className="text-muted-foreground">Responde igual: «{item.after}»</p>
            ) : (
              <dl className="grid gap-1.5">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-xs leading-5 font-bold text-muted-foreground">{beforeLabel}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap text-muted-foreground">{item.before}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-xs leading-5 font-bold text-success">{afterLabel}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap">{item.after}</dd>
                </div>
              </dl>
            )}
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <p className="text-xs text-muted-foreground">
          Volví a responder {counts.answered === 1 ? "la que toca" : `las ${counts.answered} que tocan`} el tema. {rest === 1 ? "El otro caso de prueba no lo toca y no recibe" : `Los otros ${rest} casos de prueba no lo tocan y no reciben`} nada distinto.
        </p>
      ) : null}
      {preview.model === "fake" ? (
        <p className="text-xs text-muted-foreground">
          Modelo de demostración: siempre responde lo mismo, así que esta prueba no dice cómo respondería un proveedor real.
        </p>
      ) : null}
    </div>
  )
}

/** La prueba de una lección: se lanza con su botón (llama al modelo) y muestra el resultado cuando existe. */
function LessonTest({
  lessonId,
  impact,
  title,
  summary,
  runLabel,
  beforeLabel,
  afterLabel,
  canRun,
  resetKey,
}: {
  lessonId: string
  impact: LessonImpact | null
  title: string
  /** Sustituye al resumen de casos cuando su redacción no vale para este paso. */
  summary?: string
  runLabel: string
  beforeLabel: string
  afterLabel: string
  canRun: boolean
  /** Cambia cuando la lección se edita: el resultado anterior ya no vale. */
  resetKey?: string
}) {
  // Llama al modelo: solo cuando la persona lo pide.
  const preview = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: LessonPreview }>(`/api/agent/learning/lessons/${lessonId}/preview`, { method: "POST" }),
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de lección o de texto.
  useEffect(() => {
    preview.reset()
  }, [lessonId, resetKey])
  const error =
    preview.error instanceof ApiError
      ? (preview.error.shape.message ?? "No pudimos probarla")
      : preview.error
        ? "No pudimos probarla. Vuelve a intentarlo."
        : null
  return (
    <section aria-label={title} className="flex flex-col gap-2.5 rounded-xl border p-4 text-left text-sm">
      {preview.data ? (
        <PreviewResult preview={preview.data.data} beforeLabel={beforeLabel} afterLabel={afterLabel} />
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <h4 className="font-bold">{title}</h4>
            {impact ? <p className="text-muted-foreground">{summary ?? impactSummary(impact)}</p> : null}
          </div>
          {canRun ? (
            <>
              <SubmitButton
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 self-start sm:min-h-8"
                pending={preview.isPending}
                onClick={() => preview.mutate()}
              >
                {runLabel}
              </SubmitButton>
              <p className="text-xs text-muted-foreground">
                Vuelve a responder la pregunta que la originó y los casos que tocan el tema. Usa el modelo: tarda unos segundos.
              </p>
            </>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function Chips({ lesson }: { lesson: LessonItem }) {
  return (
    <>
      <Badge variant="secondary">{LESSON_KIND_LABEL[lesson.kind]}</Badge>
      <Badge variant={lesson.scope === "clinica" ? "secondary" : "soft"}>{lessonScopeChip(lesson.scope)}</Badge>
    </>
  )
}

function useLesson(lessonId: string | null) {
  return useQuery({
    queryKey: ["agent-lesson", lessonId],
    queryFn: () => apiFetch<{ data: { lesson: LessonItem; impact: LessonImpact } }>(`/api/agent/learning/lessons/${lessonId}`),
    enabled: lessonId !== null,
    retry: false,
  })
}

/**
 * Retirar algo que el agente aprendió: una confirmación, no un formulario. Dice
 * quién la aprobó y cuánto se usa, deja probar qué pasa sin ella y retira
 * también su caso de prueba salvo que se desmarque.
 */
export function WithdrawLessonDialog({ lessonId, onClose, onWithdrawn }: { lessonId: string | null; onClose: () => void; onWithdrawn?: () => void }) {
  const queryClient = useQueryClient()
  const [withdrawCase, setWithdrawCase] = useState(true)
  const query = useLesson(lessonId)
  const lesson = query.data?.data.lesson ?? null
  const impact = query.data?.data.impact ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: la casilla vuelve a su valor al abrir otra lección.
  useEffect(() => {
    setWithdrawCase(true)
  }, [lessonId])
  const hasCase = Boolean(lesson?.question.trim())
  const withdraw = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch(`/api/agent/learning/lessons/${lessonId}/withdraw`, {
        method: "POST",
        body: JSON.stringify({ withdrawCase: hasCase && withdrawCase }),
      }),
    onSuccess: () => {
      for (const key of LESSON_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] })
      onWithdrawn?.()
      close()
    },
  })
  function close() {
    withdraw.reset()
    onClose()
  }
  const approved =
    lesson?.approvedByName && lesson.approvedAt
      ? `La aprobó ${lesson.approvedByName} el ${new Date(lesson.approvedAt).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" })}`
      : null
  const usage = lesson ? lessonUsage(lesson).text : ""
  const description = !lesson
    ? query.isError
      ? "No pudimos cargar la lección."
      : "Cargando…"
    : approved
      ? `${approved} · ${usage.charAt(0).toLowerCase()}${usage.slice(1)}`
      : usage
  const error = mutationErrorMessage(withdraw.error)

  return (
    <ConfirmDialog
      open={lessonId !== null}
      title={lesson ? `Retirar «${lesson.title}»` : "Retirar"}
      description={description}
      confirmLabel={lesson ? WITHDRAW_LABEL[lesson.kind] : "Retirar"}
      variant="default"
      pending={withdraw.isPending}
      confirmDisabled={!lesson || lesson.status !== "activa"}
      onConfirm={() => withdraw.mutate()}
      onClose={close}
    >
      {lesson ? (
        <div className="-mx-1 flex max-h-[50dvh] flex-col gap-3 overflow-y-auto px-1 text-left text-sm">
          <p className="flex flex-wrap items-center justify-center gap-1.5">
            <Chips lesson={lesson} />
          </p>
          <LessonTest
            lessonId={lesson.id}
            impact={impact}
            title="Qué pasa si la retiras"
            summary={impact?.total === 0 ? "No tienes otros casos de prueba: ninguno cambia al retirarla." : undefined}
            runLabel="Ver cómo respondería sin ella"
            beforeLabel="Hoy"
            afterLabel={WITHOUT_LABEL[lesson.kind]}
            canRun={lesson.status === "activa"}
          />
          {hasCase ? (
            <label htmlFor="leccion-retirar-caso" className="flex min-h-11 cursor-pointer items-start gap-2.5">
              <Checkbox
                id="leccion-retirar-caso"
                className="mt-0.5"
                checked={withdrawCase}
                onCheckedChange={(value) => setWithdrawCase(value === true)}
              />
              <span>
                <span className="font-semibold">Retirar también su caso de prueba</span>
                <span className="block text-muted-foreground">Si lo dejas, seguirá esperando la respuesta de hoy.</span>
              </span>
            </label>
          ) : null}
          <p className="flex items-start gap-2.5 rounded-xl bg-muted px-3.5 py-3">
            <Undo2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>Deja de usarla al instante. Queda en Retiradas con su historia y la puedes restaurar cuando quieras.</span>
          </p>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  )
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5 text-sm">
      <h4 id={id} className={SECTION_TITLE}>
        {title}
      </h4>
      {children}
    </section>
  )
}

/**
 * Una lección, de principio a fin: propuesta (ver, editar, probar, aprobar o
 * descartar), activa (verla y pasar a retirarla, que se confirma en su
 * diálogo) y retirada (restaurar). Nada se activa ni se retira sin que una
 * persona lo decida aquí.
 */
export function LessonDrawer({ lessonId, canWrite, onClose }: { lessonId: string | null; canWrite: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const [editing, setEditing] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [draft, setDraft] = useState<{ title: string; body: string; kind: LessonKind }>({ title: "", body: "", kind: "regla" })

  const query = useLesson(lessonId)
  const lesson = query.data?.data.lesson ?? null
  const impact = query.data?.data.impact ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de lección o de estado, para no pisar lo que se está escribiendo.
  useEffect(() => {
    if (!lesson) return
    setDraft({ title: lesson.title, body: lesson.body, kind: lesson.kind })
    setEditing(false)
  }, [lesson?.id, lesson?.status])

  const refresh = () => {
    for (const key of LESSON_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] })
  }
  const act = useMutation({
    retry: false,
    mutationFn: (input: { action: "approve" | "discard" | "restore" }) =>
      apiFetch(`/api/agent/learning/lessons/${lessonId}/${input.action}`, { method: "POST" }),
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
      setEditing(false)
      refresh()
    },
  })

  function close() {
    act.reset()
    save.reset()
    setWithdrawing(false)
    onClose()
  }

  const proposed = lesson?.status === "propuesta"
  const active = lesson?.status === "activa"
  const withdrawn = lesson?.status === "retirada"
  const dirty = Boolean(lesson) && editing && (draft.title !== lesson?.title || draft.body !== lesson?.body || draft.kind !== lesson?.kind)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!lesson || act.isPending || save.isPending) return
    if (editing) save.mutate({ title: draft.title.trim(), body: draft.body.trim(), kind: draft.kind })
    else if (proposed) act.mutate({ action: "approve" })
    else if (withdrawn) act.mutate({ action: "restore" })
  }

  const title = !lesson
    ? "Lección"
    : proposed
      ? "Lección propuesta"
      : active
        ? "Lección activa"
        : withdrawn
          ? `Restaurar «${lesson.title}»`
          : "Lección descartada"
  const changesExisting = lesson?.kind === "respuesta_oficial" && lesson.knowledgeEntry !== null && lesson.status === "propuesta"
  // El pie del formulario lleva «Guardar cambios» y «Restaurar»; aprobar y retirar van en el pie propio, con lo demás que se puede hacer.
  const ownActions = !editing && (proposed || active)

  return (
    <>
      <FormDrawer
        open={lessonId !== null}
        onClose={close}
        title={title}
        onSubmit={submit}
        isSubmitting={act.isPending || save.isPending}
        isLoading={query.isPending && lessonId !== null}
        isDirty={dirty}
        error={query.isError ? "No pudimos cargar la lección." : mutationErrorMessage(act.error ?? save.error)}
        submitLabel={editing ? "Guardar cambios" : "Restaurar"}
        cancelLabel={editing ? "Cancelar" : "Cerrar"}
        hideSubmit={!canWrite || !lesson || ownActions || lesson.status === "descartada"}
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
              <div className="flex items-start gap-3">
                <AgentMark className="size-10" />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                  <h3 className="font-heading text-xl leading-7 font-bold">
                    {changesExisting ? `Cambiar la respuesta «${lesson.knowledgeEntry?.title}»` : lesson.title}
                  </h3>
                  <Badge variant="secondary">{LESSON_KIND_LABEL[lesson.kind]}</Badge>
                </div>
              </div>

              <Block id="leccion-origen" title="De dónde sale">
                <p>{lessonOriginText(lesson)}</p>
                {lesson.approvedByName && lesson.approvedAt ? (
                  <p className="text-muted-foreground">
                    La aprobó {lesson.approvedByName} el {new Date(lesson.approvedAt).toLocaleDateString("es", { day: "numeric", month: "long" })}.
                    {active ? ` ${lessonUsage(lesson).text}.` : ""}
                  </p>
                ) : null}
              </Block>

              <Block id="leccion-alcance" title="A quién se aplica">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={lesson.scope === "clinica" ? "secondary" : "soft"}>{lessonScopeChip(lesson.scope)}</Badge>
                  <p className="min-w-0 flex-1 basis-48 text-muted-foreground">{SCOPE_WHY[lesson.kind]}</p>
                </div>
              </Block>

              <Block id="leccion-cambio" title={proposed ? "Qué cambia" : "Qué dice"}>
                {!proposed ? (
                  <p className="whitespace-pre-wrap rounded-xl bg-success-soft px-3.5 py-3">{lesson.body}</p>
                ) : changesExisting ? (
                  <BeforeAfter before={lesson.knowledgeEntry?.body ?? ""} after={lesson.body} strike />
                ) : (
                  <BeforeAfter before={lesson.originalReply} after={lesson.body} beforeLabel="Respondió" afterLabel="Aprende" />
                )}
                {changesExisting && canWrite ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto min-h-11 self-start p-0 text-left whitespace-normal sm:min-h-8"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ knowledgeEntryId: null })}
                  >
                    Guardarla como respuesta nueva, sin cambiar la que ya existe
                  </Button>
                ) : null}
              </Block>

              {proposed ? (
                <LessonTest
                  lessonId={lesson.id}
                  impact={impact}
                  title="Tus casos de prueba"
                  runLabel="Ver cómo respondería con ella"
                  beforeLabel="Antes"
                  afterLabel="Ahora"
                  canRun={canWrite}
                  resetKey={`${lesson.kind}|${lesson.title}|${lesson.body}|${lesson.knowledgeEntryId ?? ""}`}
                />
              ) : null}

              {proposed && lesson.question.trim() ? (
                <p className="flex items-start gap-2.5 rounded-xl border border-agent-border bg-agent-soft px-3.5 py-3 text-sm">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" aria-hidden />
                  <span>
                    La pregunta{lesson.contactName ? ` de ${lesson.contactName}` : ""} queda guardada como caso de prueba: «{lesson.question}». Si otra
                    lección toca ese tema, la verás entre los casos que pueden cambiar antes de activarla.
                  </span>
                </p>
              ) : null}

              {withdrawn ? (
                <p className="text-sm text-muted-foreground">Está retirada: el agente no la usa. Restaurarla la vuelve a activar tal como estaba.</p>
              ) : null}
              {(proposed || active) && !canWrite ? (
                <p className="text-sm">{proposed ? "La aprueba quien administra el agente." : "La retira quien administra el agente."}</p>
              ) : null}

              {proposed && canWrite ? (
                <div className={SURFACE_ACTIONS}>
                  <SubmitButton type="submit" className="min-h-11 w-full" pending={act.isPending && act.variables?.action === "approve"} disabled={act.isPending || save.isPending}>
                    Aprobar y activar
                  </SubmitButton>
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" className="min-h-11 sm:min-h-10" disabled={act.isPending} onClick={() => setEditing(true)}>
                      Editar el texto
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 text-destructive hover:text-destructive sm:min-h-10"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ action: "discard" })}
                    >
                      Descartar
                    </Button>
                  </div>
                  {isMobile ? null : (
                    <p className="text-center text-sm text-muted-foreground">Si después no te convence, la retiras y todo vuelve a como estaba.</p>
                  )}
                </div>
              ) : null}
              {active && canWrite ? (
                <div className={SURFACE_ACTIONS}>
                  <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => setWithdrawing(true)}>
                    {WITHDRAW_LABEL[lesson.kind]}
                  </Button>
                </div>
              ) : null}
            </>
          )
        ) : null}
        </div>
      </FormDrawer>
      <WithdrawLessonDialog lessonId={withdrawing ? lessonId : null} onClose={() => setWithdrawing(false)} onWithdrawn={close} />
    </>
  )
}
