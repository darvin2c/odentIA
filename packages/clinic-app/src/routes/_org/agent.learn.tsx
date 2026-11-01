import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, useIsMobile } from "@odentia/ui"
import { AgentSurface, EmptyState, ErrorState, PageHeader, PageShell, RowActions, submitErrorMessage, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Check, ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { CorrectDrawer, type CorrectionTarget } from "../../components/agent/correct-drawer"
import { LessonDrawer, lessonOriginText, WithdrawLessonDialog } from "../../components/agent/lesson-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import {
  askedWords,
  impactSummary,
  type LearningOverview,
  LESSON_KIND_LABEL,
  type LessonItem,
  lessonUsage,
  REVIEW_REASON_LABEL,
  type ReviewItem,
  reviewWhen,
} from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { useCan, usePermission } from "../../lib/crm"
import { canCorrectAgent } from "../../lib/screen-rules"
import { useOrgEvents } from "../../lib/org-events"
import { QueryErrorState } from "../../lib/query-error"
import { LearnPageSkeleton, LearnSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/learn")({
  pendingComponent: LearnPageSkeleton,
  component: AgentLearnPage,
})

const PREVIEW = 3
const LINK = "h-auto min-h-11 p-0 sm:min-h-8"
const LABEL = "w-18 shrink-0 text-muted-foreground"

/** Por qué una respuesta entró a revisión, dicho en una frase para quien la corrige. */
function whyHere(item: ReviewItem): string {
  if (item.reason === "no_encontro") return `Buscó «${item.query ?? ""}» y no encontró nada. Eso no significa que haya respondido mal.`
  if (item.reason === "equipo_tomo") return "Alguien de tu equipo escribió justo después."
  if (item.reason === "repitio_pregunta") return "La persona volvió a preguntar lo mismo después de esta respuesta."
  if (item.reason === "muestra") return "Es una muestra al azar: nada indica que esté mal."
  return REVIEW_REASON_LABEL[item.reason]
}

/** Cómo se nombra una respuesta en su aviso: lo que buscó o lo que escribió, en corto. */
function shortName(item: ReviewItem): string {
  const text = (item.query ?? item.question).replace(/\s+/g, " ").trim()
  return text.length <= 60 ? text : `${text.slice(0, 59).trimEnd()}…`
}

/** Lo que ya se decidió en esta visita: queda a la vista con lo que sigue haciendo o lo que se puede deshacer. */
type Decided = { item: ReviewItem } & ({ state: "bien" } | { state: "ejemplo" } | { state: "sumada"; answer: string })

/**
 * Sección de la pantalla. En ventana ancha, título y contenido a la vista. En
 * teléfono, las que se pliegan (`fold`) son una fila que se abre: lo primero
 * que se ve es lo que hay por revisar.
 */
function Section({
  id,
  title,
  hint,
  fold = false,
  tone = "plain",
  children,
}: {
  id: string
  title: string
  hint: string
  fold?: boolean
  tone?: "plain" | "agent"
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!fold) {
    return (
      <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 id={id} className="font-heading text-base font-bold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {children}
      </section>
    )
  }
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "relative flex min-h-16 items-center gap-2.5 rounded-xl border px-3.5 py-2.5",
            tone === "agent" ? "border-agent-border bg-agent-soft" : "bg-card",
          )}
        >
          <div className="min-w-0 flex-1">
            <h2 id={id} className="font-heading text-base font-bold">
              {/* La fila entera abre la sección: el botón se estira sobre ella. */}
              <CollapsibleTrigger className="rounded-xl text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
                {title}
              </CollapsibleTrigger>
            </h2>
            <p className="text-sm text-muted-foreground">{hint}</p>
          </div>
          <ChevronRight className={cn("size-4.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open ? "rotate-90" : "")} aria-hidden />
        </div>
        <CollapsibleContent className="pt-2.5">{children}</CollapsibleContent>
      </Collapsible>
    </section>
  )
}

function LearnedRow({ lesson, usage, action, warn = false, onOpen }: { lesson: LessonItem; usage?: { text: string; stale: boolean }; action: string; warn?: boolean; onOpen: () => void }) {
  return (
    <li className="flex min-h-13 flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-4 py-2 first:border-t-0 sm:px-5">
      <span className="w-full text-xs font-bold text-muted-foreground sm:w-32 sm:shrink-0">{LESSON_KIND_LABEL[lesson.kind]}</span>
      <span className="min-w-0 flex-1 basis-56 font-semibold">{lesson.title}</span>
      {usage ? (
        <span className={cn("text-sm sm:w-32 sm:shrink-0", usage.stale ? "font-bold text-warning" : "text-muted-foreground")}>{usage.text}</span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`${action} «${lesson.title}»`}
        className={cn("ml-auto min-h-11 sm:min-h-8", warn ? "border-warning/40 bg-warning-soft font-bold text-warning hover:bg-warning-soft" : "")}
        onClick={onOpen}
      >
        {action}
      </Button>
    </li>
  )
}

/** El aviso que queda en el lugar de una respuesta ya decidida: dice qué pasó y qué se puede hacer todavía. */
function DecidedRow({
  decided,
  receptionName,
  pending,
  onExample,
  onUndo,
}: {
  decided: Decided
  receptionName: string
  pending: boolean
  onExample: () => void
  onUndo: () => void
}) {
  const name = shortName(decided.item)
  const canBeExample = Boolean(decided.item.question.trim() && decided.item.reply.trim())
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-sm">
      <Check className="size-4 shrink-0 text-success" aria-hidden />
      <p className="min-w-0 flex-1 basis-56">
        {decided.state === "bien" ? (
          <>
            <span className="font-semibold">«{name}» quedó como bien.</span>{" "}
            <span className="text-muted-foreground">{receptionName} sigue respondiendo igual.</span>
          </>
        ) : decided.state === "ejemplo" ? (
          <>
            <span className="font-semibold">«{name}» quedó como ejemplo por aprobar.</span>{" "}
            <span className="text-muted-foreground">{receptionName} lo usa cuando se apruebe.</span>
          </>
        ) : (
          <>
            <span className="font-semibold">
              «{name}» se sumó a «{decided.answer}».
            </span>{" "}
            <span className="text-muted-foreground">{receptionName} la encuentra desde ahora.</span>
          </>
        )}
      </p>
      {decided.state === "bien" ? (
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          {canBeExample ? (
            <Button type="button" variant="outline" size="sm" className="min-h-11 max-sm:flex-1 sm:min-h-9" disabled={pending} onClick={onExample}>
              Guardar como ejemplo
            </Button>
          ) : null}
          <Button type="button" variant="link" className={LINK} disabled={pending} onClick={onUndo}>
            Deshacer
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function AgentLearnPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const canCorrect = canCorrectAgent(useCan())
  const receptionName = useReceptionName()
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [withdrawId, setWithdrawId] = useState<string | null>(null)
  const [allReview, setAllReview] = useState(false)
  const [allLearned, setAllLearned] = useState(false)
  const [showWithdrawn, setShowWithdrawn] = useState(false)
  const [decided, setDecided] = useState<Decided[]>([])

  const query = useQuery({
    queryKey: ["agent-learning"],
    queryFn: async () => {
      const result = await apiFetch<{ data: LearningOverview }>("/api/agent/learning")
      // Leer la lista la concilia en el servidor: el número del menú se pone al día con ella.
      void queryClient.invalidateQueries({ queryKey: ["agent-summary"] })
      return result
    },
    enabled: canRead,
    retry: false,
  })
  useOrgEvents(["agent.run.recorded", "agent.proposal.decided", "stream.reconnected"], () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-learning"] })
  })
  const refresh = () => Promise.all(["agent-learning", "agent-overview", "agent-summary"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
  const decide = (next: Decided) => setDecided((current) => [...current.filter((row) => row.item.id !== next.item.id), next])
  const markOk = useMutation({
    retry: false,
    mutationFn: (item: ReviewItem) => apiFetch(`/api/agent/learning/review/${item.id}/ok`, { method: "POST", body: "{}" }),
    onSuccess: (_, item) => decide({ item, state: "bien" }),
    onSettled: () => refresh(),
  })
  const saveExample = useMutation({
    retry: false,
    mutationFn: (item: ReviewItem) => apiFetch(`/api/agent/learning/review/${item.id}/example`, { method: "POST", body: "{}" }),
    onSuccess: (_, item) => decide({ item, state: "ejemplo" }),
    onSettled: () => refresh(),
  })
  const undo = useMutation({
    retry: false,
    mutationFn: (item: ReviewItem) => apiFetch(`/api/agent/learning/review/${item.id}/reopen`, { method: "POST", body: "{}" }),
    // Primero vuelve a la lista y después se va el aviso: la fila no salta.
    onSuccess: async (_, item) => {
      await refresh()
      setDecided((current) => current.filter((row) => row.item.id !== item.id))
    },
  })
  const deciding = markOk.isPending || saveExample.isPending || undo.isPending
  const decideError = markOk.error ?? saveExample.error ?? undo.error

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso a lo que aprende el agente." />
      </PageShell>
    )
  }

  const data = query.data?.data
  const correct = (item: ReviewItem) =>
    setCorrecting({
      reviewItemId: item.id,
      agent: item.agent,
      reason: item.reason,
      query: item.query,
      context: [item.contactName ?? "Interlocutor", item.channel ? channelLabel(item.channel) : null, reviewWhen(item.createdAt)].filter(Boolean).join(" · "),
      question: item.question,
      reply: item.reply,
      teamReply: item.teamReply,
      basis: item.basis,
      checks: item.checks,
      why: whyHere(item),
    })

  const review = data?.review ?? []
  const proposed = data?.proposed ?? []
  const learned = data?.learned ?? []
  const withdrawn = data?.withdrawn ?? []
  // Las reglas le llegan todas: pasado el tope, las más antiguas dejan de llegarle.
  const rulesLearned = learned.filter((lesson) => lesson.kind === "regla").length
  const openId = correcting?.reviewItemId ?? null
  // Lo decidido en esta visita queda en su lugar, en el orden de la lista; lo que vuelve a estar pendiente manda.
  const rows: Array<{ item: ReviewItem; decided?: Decided }> = [
    ...(allReview ? review : review.slice(0, PREVIEW)).map((item) => ({ item })),
    ...decided.filter((row) => !review.some((item) => item.id === row.item.id)).map((row) => ({ item: row.item, decided: row })),
  ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader title="Agente" subtitle={`Revisas lo dudoso de ${receptionName} y apruebas lo que propone aprender. Lo demás no necesita tu tiempo.`} />
      <AgentTabs learnPending={data ? data.reviewTotal + data.proposed.length : undefined} />
      {query.isPending ? (
        <SkeletonRegion message="Cargando lo que hay por revisar…">
          <LearnSkeleton />
        </SkeletonRegion>
      ) : query.isError || !data ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <Section
            id="por-revisar"
            title={data.reviewTotal > 0 ? `Por revisar · ${data.reviewTotal}` : "Por revisar"}
            hint="Las que algo hizo dudar y una muestra al azar."
          >
            {rows.length === 0 ? (
              <EmptyState
                title="Nada por revisar"
                description="Aparece aquí lo que busque y no encuentre, y lo que tu equipo retome o alguien repita tras una respuesta del agente. También puedes corregir cualquier respuesta desde la Bandeja, en «En qué se basó»."
                actionLabel="Ir a la Bandeja"
                onAction={() => void navigate({ to: "/inbox", search: { conversation: undefined } })}
              />
            ) : (
              <ul className="flex flex-col gap-2.5">
                {rows.map(({ item, decided: done }) => {
                  if (done) {
                    return (
                      <li key={item.id}>
                        <DecidedRow
                          decided={done}
                          receptionName={receptionName}
                          pending={deciding}
                          onExample={() => saveExample.mutate(item)}
                          onUndo={() => undo.mutate(item)}
                        />
                      </li>
                    )
                  }
                  const open = openId === item.id
                  const reason = REVIEW_REASON_LABEL[item.reason]
                  const who = item.contactName ?? "Interlocutor"
                  const times = item.asked ? askedWords(item.asked) : null
                  const more = (
                    <RowActions
                      label={`Más acciones de la respuesta a ${who}`}
                      items={[
                        {
                          key: "conversacion",
                          label: "Abrir la conversación",
                          onSelect: () => void navigate({ to: "/inbox", search: { conversation: item.conversationId } }),
                        },
                      ]}
                    />
                  )
                  return (
                    <li key={item.id}>
                      <article
                        className={cn(
                          "flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm",
                          open ? "border-primary ring-1 ring-primary" : "",
                        )}
                      >
                        {isMobile ? (
                          <>
                            <div className="flex items-start gap-2">
                              <p className="min-w-0 flex-1 pt-2.5">
                                <Badge variant={item.reason === "muestra" ? "secondary" : "warning"} className="h-auto min-h-5.5 whitespace-normal">
                                  {times ? `${reason} · ${times}` : reason}
                                </Badge>
                              </p>
                              {more}
                            </div>
                            {item.before ? <p className="text-muted-foreground">Antes: {item.before}</p> : null}
                            <p className="font-bold whitespace-pre-wrap">{item.question || "—"}</p>
                            {item.query ? <p>Buscó: {item.query}</p> : null}
                            <p className="whitespace-pre-wrap text-muted-foreground">Respondió: {item.reply || "—"}</p>
                          </>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={item.reason === "muestra" ? "secondary" : "warning"}>{reason}</Badge>
                              <span className="min-w-0 flex-1 basis-40 text-muted-foreground">
                                {who}
                                {item.channel ? ` · ${channelLabel(item.channel)}` : ""} · {reviewWhen(item.createdAt)}
                                {times ? ` · ${times}` : ""}
                              </span>
                              {open ? <Badge variant="soft">Abierta al lado</Badge> : null}
                              {more}
                            </div>
                            <dl className="grid gap-1.5">
                              {item.before ? (
                                <div className="flex gap-2.5">
                                  <dt className={LABEL}>Antes</dt>
                                  <dd className="min-w-0 whitespace-pre-wrap text-muted-foreground">{item.before}</dd>
                                </div>
                              ) : null}
                              <div className="flex gap-2.5">
                                <dt className={LABEL}>Escribió</dt>
                                <dd className="min-w-0 font-semibold whitespace-pre-wrap">{item.question || "—"}</dd>
                              </div>
                              {item.query ? (
                                <div className="flex gap-2.5">
                                  <dt className={LABEL}>Buscó</dt>
                                  <dd className="min-w-0">{item.query}</dd>
                                </div>
                              ) : null}
                              <div className="flex gap-2.5">
                                <dt className={LABEL}>Respondió</dt>
                                <dd className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{item.reply || "—"}</dd>
                              </div>
                            </dl>
                          </>
                        )}
                        {canCorrect && !open ? (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 max-sm:flex-1 sm:min-h-9"
                              disabled={deciding}
                              onClick={() => markOk.mutate(item)}
                            >
                              Estuvo bien
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 border-primary text-primary-soft-foreground max-sm:flex-1 sm:min-h-9"
                              onClick={() => correct(item)}
                            >
                              Corregir
                            </Button>
                          </div>
                        ) : null}
                      </article>
                    </li>
                  )
                })}
              </ul>
            )}
            {decideError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitErrorMessage(decideError)}
              </p>
            ) : null}
            {!allReview && review.length > PREVIEW ? (
              <Button type="button" variant="link" className={cn(LINK, "self-start")} onClick={() => setAllReview(true)}>
                {review.length - PREVIEW === 1 ? "Ver la otra" : `Ver las otras ${review.length - PREVIEW}`}
              </Button>
            ) : null}
            {data.reviewTotal > review.length ? (
              <p className="text-sm text-muted-foreground">
                Se muestran las {review.length} más recientes de {data.reviewTotal}. Al decidirlas aparecen las demás.
              </p>
            ) : null}
          </Section>

          <Section
            id="por-aprobar"
            title={proposed.length > 0 ? `Lecciones por aprobar · ${proposed.length}` : "Lecciones por aprobar"}
            hint={isMobile ? "Nada cambia hasta que apruebes." : "Lo que propone aprender. Nada cambia hasta que apruebes."}
            fold={isMobile}
            tone="agent"
          >
            {proposed.length === 0 ? (
              <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                No hay lecciones esperando. Aparecen cuando corriges una respuesta o guardas una como ejemplo.
              </p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
                {proposed.map((lesson) => (
                  <li key={lesson.id} className="min-w-0">
                    <AgentSurface className="flex h-full flex-col items-start gap-2 p-4 text-sm">
                      <Badge variant="outline" className="border-transparent bg-card font-bold text-primary-soft-foreground">
                        {LESSON_KIND_LABEL[lesson.kind]}
                      </Badge>
                      <h3 className="font-heading text-base leading-snug font-bold">{lesson.title}</h3>
                      <p className="flex-1">
                        {lessonOriginText(lesson, receptionName, { short: true })} {impactSummary(lesson.impact)}
                      </p>
                      <Button
                        type="button"
                        className="min-h-11 sm:min-h-9"
                        aria-label={`${canWrite ? "Ver y aprobar" : "Ver"} «${lesson.title}»`}
                        onClick={() => setLessonId(lesson.id)}
                      >
                        {canWrite ? "Ver y aprobar" : "Ver"}
                      </Button>
                    </AgentSurface>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="lo-aprendido"
            title={learned.length > 0 ? `Lo aprendido · ${learned.length}` : "Lo aprendido"}
            hint={isMobile ? "Cualquiera se puede retirar." : "Cada una dice cuánto se usa. Cualquiera se puede retirar."}
            fold={isMobile}
          >
            <div className="elevated flex flex-col rounded-xl border bg-card">
              {data && rulesLearned > data.ruleLimit ? (
                <p role="status" className="border-b px-4 py-3 text-sm sm:px-5">
                  El agente usa tus {data.ruleLimit} reglas más recientes: las {rulesLearned - data.ruleLimit} más antiguas ya no le
                  llegan. Retira las que ya no hagan falta para que vuelvan a entrar todas.
                </p>
              ) : null}
              {learned.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">Todavía no aprobaste ninguna lección.</p>
              ) : (
                <ul className="flex flex-col">
                  {(allLearned ? learned : learned.slice(0, PREVIEW + 1)).map((lesson) => {
                    const usage = lessonUsage(lesson)
                    return (
                      <LearnedRow
                        key={lesson.id}
                        lesson={lesson}
                        usage={usage}
                        warn={canWrite && usage.stale}
                        action={canWrite ? "Retirar" : "Ver"}
                        onOpen={() => (canWrite ? setWithdrawId(lesson.id) : setLessonId(lesson.id))}
                      />
                    )
                  })}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-4 py-2 sm:px-5">
                {!allLearned && learned.length > PREVIEW + 1 ? (
                  <Button type="button" variant="link" className={LINK} onClick={() => setAllLearned(true)}>
                    Ver las {learned.length}
                  </Button>
                ) : null}
                {withdrawn.length > 0 ? (
                  <Button
                    type="button"
                    variant="link"
                    className={cn(LINK, "text-muted-foreground")}
                    aria-expanded={showWithdrawn}
                    aria-controls="aprender-retiradas"
                    onClick={() => setShowWithdrawn((value) => !value)}
                  >
                    Retiradas · {withdrawn.length}, se pueden restaurar
                  </Button>
                ) : null}
                <p className="flex min-h-11 items-center text-sm text-muted-foreground sm:ml-auto sm:min-h-8">
                  {data.cases === 0
                    ? "Aún no hay casos de prueba: cada lección aprobada guarda el suyo."
                    : `${data.cases} ${data.cases === 1 ? "caso de prueba guardado" : "casos de prueba guardados"}`}
                </p>
              </div>
              {showWithdrawn && withdrawn.length > 0 ? (
                <ul id="aprender-retiradas" aria-label="Retiradas" className="flex flex-col border-t">
                  {withdrawn.map((lesson) => (
                    <LearnedRow key={lesson.id} lesson={lesson} action={canWrite ? "Restaurar" : "Ver"} onOpen={() => setLessonId(lesson.id)} />
                  ))}
                </ul>
              ) : null}
            </div>
          </Section>
        </>
      )}
      <CorrectDrawer
        target={correcting}
        onClose={() => setCorrecting(null)}
        onCorrected={(lesson) => canWrite && setLessonId(lesson.id)}
        onMarkedOk={(id) => {
          const item = review.find((row) => row.id === id)
          if (item) decide({ item, state: "bien" })
        }}
        onAddedToAnswer={(id, answer) => {
          const item = review.find((row) => row.id === id)
          if (item) decide({ item, state: "sumada", answer })
        }}
      />
      <LessonDrawer lessonId={lessonId} canWrite={canWrite} onClose={() => setLessonId(null)} />
      <WithdrawLessonDialog lessonId={withdrawId} onClose={() => setWithdrawId(null)} />
    </PageShell>
  )
}
