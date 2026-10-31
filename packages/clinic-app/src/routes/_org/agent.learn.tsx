import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, useIsMobile } from "@odentia/ui"
import { AgentSurface, EmptyState, ErrorState, PageHeader, PageShell, RowActions, ViewTabs, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import type { AdminOverview } from "../../lib/admin"
import { CorrectDrawer, type CorrectionTarget } from "../../components/agent/correct-drawer"
import { LessonDrawer, lessonOriginText, WithdrawLessonDialog } from "../../components/agent/lesson-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import {
  type AgentOverview,
  type AgentRoles,
  agentName,
  impactSummary,
  type LearningOverview,
  LESSON_KIND_LABEL,
  type LessonItem,
  lessonScopeChip,
  lessonScopeFor,
  namedAgentRoles,
  lessonUsage,
  REVIEW_REASON_LABEL,
  type ReviewItem,
} from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type AgentConfig, useCan, usePermission } from "../../lib/crm"
import { canCorrectAgent } from "../../lib/screen-rules"
import { useOrgEvents } from "../../lib/org-events"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { LearnPageSkeleton, LearnSkeleton } from "../../components/skeletons/agent"

export const Route = createFileRoute("/_org/agent/learn")({
  pendingComponent: LearnPageSkeleton,
  component: AgentLearnPage,
})

const PREVIEW = 3
const LINK = "h-auto min-h-11 p-0 sm:min-h-8"

function when(iso: string): string {
  return new Date(iso).toLocaleString("es", { weekday: "long", hour: "2-digit", minute: "2-digit" })
}

/** Por qué una respuesta entró a revisión, dicho en una frase para quien la corrige. */
function whyHere(item: ReviewItem): string {
  if (item.reason === "equipo_tomo") return "Alguien de tu equipo escribió justo después y respondió otra cosa."
  if (item.reason === "repitio_pregunta") return "La persona volvió a preguntar lo mismo después de esta respuesta."
  if (item.reason === "muestra") return "Es una muestra al azar: nada indica que esté mal."
  return REVIEW_REASON_LABEL[item.reason]
}

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
  const receptionName = useReceptionName()
  return (
    <li className="flex min-h-13 flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-4 py-2 first:border-t-0 sm:px-5">
      <span className="w-full text-xs font-bold text-muted-foreground sm:w-32 sm:shrink-0">{LESSON_KIND_LABEL[lesson.kind]}</span>
      <span className="min-w-0 flex-1 basis-56 font-semibold">{lesson.title}</span>
      <Badge variant={lesson.scope === "clinica" ? "secondary" : "soft"}>{lessonScopeChip(lesson.scope, receptionName)}</Badge>
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

function AgentLearnPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const canCorrect = canCorrectAgent(useCan())
  const receptionName = useReceptionName()
  const [agent, setAgent] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [withdrawId, setWithdrawId] = useState<string | null>(null)
  const [allReview, setAllReview] = useState(false)
  const [allLearned, setAllLearned] = useState(false)
  const [showWithdrawn, setShowWithdrawn] = useState(false)

  const query = useQuery({
    queryKey: ["agent-learning"],
    queryFn: () => apiFetch<{ data: LearningOverview }>("/api/agent/learning"),
    enabled: canRead,
    retry: false,
  })
  // De qué agente: las fichas dan los nombres y cada agente dice si está encendido
  // donde ya lo dice el Resumen (mismas consultas, compartidas con esa pantalla).
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    select: (body) => ({ data: namedAgentRoles(body.data, receptionName) }),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const overviewQuery = useQuery({
    queryKey: ["agent-overview"],
    queryFn: () => apiFetch<{ data: AgentOverview }>("/api/agent/overview"),
    enabled: canRead,
    retry: false,
    staleTime: 30_000,
  })
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    enabled: canRead,
  })
  const adminQuery = useQuery({
    queryKey: ["agent-admin", "overview"],
    queryFn: () => apiFetch<{ data: AdminOverview }>("/api/agent/admin/overview"),
    enabled: canRead,
    retry: false,
  })
  useOrgEvents(["agent.run.recorded", "agent.proposal.decided", "stream.reconnected"], () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-learning"] })
  })
  const markOk = useMutation({
    retry: false,
    mutationFn: (input: { id: string; asExample?: boolean }) =>
      apiFetch(`/api/agent/learning/review/${input.id}/ok`, {
        method: "POST",
        body: JSON.stringify(input.asExample ? { asExample: true } : {}),
      }),
    onSettled: () => {
      for (const key of ["agent-learning", "agent-overview"]) void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })

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
      question: item.question,
      reply: item.reply,
      teamReply: item.teamReply,
      basis: item.basis,
      checks: item.checks,
      why: whyHere(item),
    })

  // Encendido o apagado según quien lo sabe; sin el dato no se afirma ninguno de los dos.
  const isOn = (id: string): boolean | undefined =>
    id === "recepcion"
      ? overviewQuery.data?.data.enabled
      : id === "asistente_clinico"
        ? configQuery.data?.data.clinicalAssistantEnabled
        : id === "administrador"
          ? adminQuery.data?.data.enabled
          : undefined
  const ofAgent = (lesson: LessonItem) => agent === null || lesson.agent === agent || lesson.scope === "clinica"
  const review = (data?.review ?? []).filter((item) => agent === null || item.agent === agent)
  const proposed = (data?.proposed ?? []).filter(ofAgent)
  const learned = (data?.learned ?? []).filter(ofAgent)
  // Las reglas son de cada agente: pasado el tope, las más antiguas dejan de llegarle. Cuenta el que más tiene.
  const rulesOfAgent = Math.max(
    0,
    ...Object.values(
      learned
        .filter((lesson) => lesson.kind === "regla")
        .reduce<Record<string, number>>((byAgent, lesson) => ({ ...byAgent, [lesson.scope]: (byAgent[lesson.scope] ?? 0) + 1 }), {}),
    ),
  )
  const withdrawn = (data?.withdrawn ?? []).filter(ofAgent)
  // Los agentes que la clínica enciende o apaga: son los que aprenden de ella.
  const agents = (rolesQuery.data?.data.roles ?? [])
    .filter((role) => role.switchable)
    .map((role) => {
      const pending = (data?.review ?? []).filter((item) => item.agent === role.id).length + (data?.proposed ?? []).filter((lesson) => lesson.agent === role.id).length
      const own = pending + [...(data?.learned ?? []), ...(data?.withdrawn ?? [])].filter((lesson) => lesson.agent === role.id).length
      const off = !role.available || isOn(role.id) === false
      return { id: role.id as string, name: role.name, pending, off, disabled: off && own === 0 }
    })
  const openId = correcting?.reviewItemId ?? null

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader title="Agente" subtitle="Revisas lo dudoso y apruebas lo que propone aprender. Lo demás no necesita tu tiempo." />
      <AgentTabs learnPending={data ? data.review.length + data.proposed.length : undefined} />
      {query.isPending ? (
        <SkeletonRegion message="Cargando lo que hay por revisar…">
          <LearnSkeleton />
        </SkeletonRegion>
      ) : query.isError || !data ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="-mt-1 flex flex-col gap-1.5">
            {agents.length > 0 ? (
              <ViewTabs
                label="De qué agente"
                value={agent ?? "todos"}
                options={[
                  { value: "todos", label: "Todos los agentes" },
                  ...agents.map((item) => ({
                    value: item.id,
                    label: item.off ? `${item.name} · apagado` : item.name,
                    count: item.pending > 0 ? item.pending : undefined,
                    disabled: item.disabled,
                  })),
                ]}
                onValueChange={(next) => setAgent(next === "todos" ? null : next)}
              />
            ) : null}
            <p className="text-sm text-muted-foreground">
              Cada agente aprende lo suyo y no se mezcla con los otros. Solo el conocimiento de la clínica es de todos.
            </p>
          </div>

          <Section
            id="por-revisar"
            title={review.length > 0 ? `Por revisar · ${review.length}` : "Por revisar"}
            hint="Las que algo hizo dudar y una muestra al azar."
          >
            {review.length === 0 ? (
              agent !== null && data.review.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 rounded-xl border bg-card px-4 py-3 text-sm">
                  <p className="min-w-0 flex-1 basis-48 text-muted-foreground">Nada por revisar de {agentName(agent, receptionName)}.</p>
                  <Button type="button" variant="link" className={LINK} onClick={() => setAgent(null)}>
                    Ver todos los agentes
                  </Button>
                </div>
              ) : (
                <EmptyState
                  title="Nada por revisar"
                  description="Cuando tu equipo retome una conversación tras una respuesta del agente, o alguien repita una pregunta, aparecerá aquí. También puedes corregir cualquier respuesta desde la Bandeja, en «En qué se basó»."
                  actionLabel="Ir a la Bandeja"
                  onAction={() => void navigate({ to: "/inbox", search: { conversation: undefined } })}
                />
              )
            ) : (
              <ul className="flex flex-col gap-2.5">
                {(allReview ? review : review.slice(0, PREVIEW)).map((item) => {
                  const open = openId === item.id
                  const reason = REVIEW_REASON_LABEL[item.reason]
                  const who = item.contactName ?? "Interlocutor"
                  const more = (
                    <RowActions
                      label={`Más acciones de la respuesta a ${who}`}
                      items={[
                        {
                          key: "conversacion",
                          label: "Abrir la conversación",
                          onSelect: () => void navigate({ to: "/inbox", search: { conversation: item.conversationId } }),
                        },
                        ...(canCorrect && item.question
                          ? [
                              {
                                key: "ejemplo",
                                label: "Estuvo bien: guardar como ejemplo",
                                disabled: markOk.isPending,
                                onSelect: () => markOk.mutate({ id: item.id, asExample: true }),
                              },
                            ]
                          : []),
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
                                  {agentName(item.agent, receptionName)} · {reason.charAt(0).toLowerCase()}
                                  {reason.slice(1)}
                                </Badge>
                              </p>
                              {more}
                            </div>
                            <p className="font-bold whitespace-pre-wrap">{item.question || "—"}</p>
                            <p className="whitespace-pre-wrap text-muted-foreground">Respondió: {item.reply}</p>
                          </>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="soft">{agentName(item.agent, receptionName)}</Badge>
                              <Badge variant={item.reason === "muestra" ? "secondary" : "warning"}>{reason}</Badge>
                              <span className="min-w-0 flex-1 basis-40 text-muted-foreground">
                                {who}
                                {item.channel ? ` · ${channelLabel(item.channel)}` : ""} · {when(item.createdAt)}
                              </span>
                              {open ? <Badge variant="soft">Abierta al lado</Badge> : null}
                              {more}
                            </div>
                            <dl className="grid gap-1.5">
                              <div className="flex gap-2.5">
                                <dt className="w-18 shrink-0 text-muted-foreground">Preguntó</dt>
                                <dd className="min-w-0 font-semibold whitespace-pre-wrap">{item.question || "—"}</dd>
                              </div>
                              <div className="flex gap-2.5">
                                <dt className="w-18 shrink-0 text-muted-foreground">Respondió</dt>
                                <dd className="min-w-0 whitespace-pre-wrap">{item.reply}</dd>
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
                              disabled={markOk.isPending}
                              onClick={() => markOk.mutate({ id: item.id })}
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
            {markOk.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(markOk.error)}
              </p>
            ) : null}
            {!allReview && review.length > PREVIEW ? (
              <Button type="button" variant="link" className={cn(LINK, "self-start")} onClick={() => setAllReview(true)}>
                {review.length - PREVIEW === 1 ? "Ver la otra" : `Ver las otras ${review.length - PREVIEW}`}
              </Button>
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
                No hay lecciones esperando. Aparecen cuando corriges una respuesta o cambias un borrador antes de aprobarlo.
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
                      <p className="font-bold text-primary-soft-foreground">{lessonScopeFor(lesson.scope, receptionName)}</p>
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
            hint={isMobile ? "De cada agente. Cualquiera se puede retirar." : "Cada una dice de quién es y cuánto se usa. Cualquiera se puede retirar."}
            fold={isMobile}
          >
            <div className="elevated flex flex-col rounded-xl border bg-card">
              {data && rulesOfAgent > data.ruleLimit ? (
                <p role="status" className="border-b px-4 py-3 text-sm sm:px-5">
                  El agente usa tus {data.ruleLimit} reglas más recientes: las {rulesOfAgent - data.ruleLimit} más antiguas ya no le
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
      <CorrectDrawer target={correcting} onClose={() => setCorrecting(null)} onCorrected={(lesson) => canWrite && setLessonId(lesson.id)} />
      <LessonDrawer lessonId={lessonId} canWrite={canWrite} onClose={() => setLessonId(null)} />
      <WithdrawLessonDialog lessonId={withdrawId} onClose={() => setWithdrawId(null)} />
    </PageShell>
  )
}
