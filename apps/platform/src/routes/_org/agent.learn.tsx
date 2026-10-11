import { Badge, Button } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { CorrectDrawer, type CorrectionTarget } from "../../components/agent/correct-drawer"
import { LessonDrawer } from "../../components/agent/lesson-drawer"
import { AgentTabs } from "../../components/agent-tabs"
import {
  impactSummary,
  type LearningOverview,
  LESSON_KIND_LABEL,
  type LessonItem,
  lessonScopeLabel,
  REVIEW_REASON_LABEL,
  type ReviewItem,
} from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/learn")({
  component: AgentLearnPage,
})

const PREVIEW = 3
const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6">
      <div>
        <h2 id={id} className="font-heading text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", { weekday: "long", hour: "2-digit", minute: "2-digit" })
}

function usage(lesson: LessonItem): string {
  if (lesson.uses === 0) return "Sin usar todavía"
  const times = `${lesson.uses} ${lesson.uses === 1 ? "vez" : "veces"}`
  return lesson.kind === "respuesta_oficial" ? `Consultada ${times}` : lesson.kind === "regla" ? `Aplicó a ${times}` : `Usado ${times}`
}

function LessonRow({ lesson, action, onOpen, children }: { lesson: LessonItem; action: string; onOpen: () => void; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{LESSON_KIND_LABEL[lesson.kind]}</Badge>
          <span className="font-semibold">{lesson.title}</span>
        </p>
        <p className="text-sm text-muted-foreground">{lessonScopeLabel(lesson.scope)}</p>
        {children}
      </div>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onOpen}>
        {action}
      </Button>
    </li>
  )
}

function AgentLearnPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canWrite = usePermission("agent.write")
  const canCorrect = canDecide || canWrite
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [allReview, setAllReview] = useState(false)
  const [allLearned, setAllLearned] = useState(false)

  const query = useQuery({
    queryKey: ["agent-learning"],
    queryFn: () => apiFetch<{ data: LearningOverview }>("/api/agent/learning"),
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
      question: item.question,
      reply: item.reply,
      teamReply: item.teamReply,
      basis: item.basis,
      why:
        item.reason === "equipo_tomo"
          ? "Alguien de tu equipo escribió justo después y respondió otra cosa."
          : item.reason === "repitio_pregunta"
            ? "La persona volvió a preguntar lo mismo después de esta respuesta."
            : item.reason === "muestra"
              ? "Es una muestra al azar: nada indica que esté mal."
              : REVIEW_REASON_LABEL[item.reason],
    })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle="Revisas lo dudoso y apruebas lo que propone aprender. Lo demás no necesita tu tiempo." />
      <AgentTabs />
      {query.isPending ? (
        <LoadingState message="Cargando lo que hay por revisar…" />
      ) : query.isError || !data ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <p className="-mt-2 text-sm text-muted-foreground">
            Cada agente aprende lo suyo y no se mezcla con los otros. Solo las respuestas oficiales son de toda la clínica.
          </p>

          <Section
            id="por-revisar"
            title={data.review.length > 0 ? `Por revisar · ${data.review.length}` : "Por revisar"}
            hint="Las que algo hizo dudar y una muestra al azar. Son para que las mires, no un veredicto de que estuvieron mal."
          >
            {data.review.length === 0 ? (
              <EmptyState
                title="Nada por revisar"
                description="Cuando tu equipo retome una conversación tras una respuesta del agente, o alguien repita una pregunta, aparecerá aquí."
              />
            ) : (
              <ul className="flex flex-col divide-y">
                {(allReview ? data.review : data.review.slice(0, PREVIEW)).map((item) => (
                  <li key={item.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={item.reason === "muestra" ? "secondary" : "default"}>{REVIEW_REASON_LABEL[item.reason]}</Badge>
                      <span className="text-muted-foreground">
                        {item.contactName ?? "Interlocutor"}
                        {item.channel ? ` · ${channelLabel(item.channel)}` : ""} · {when(item.createdAt)}
                      </span>
                    </p>
                    <dl className="grid gap-1 text-sm">
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0 text-muted-foreground">Preguntó</dt>
                        <dd className="min-w-0 whitespace-pre-wrap">{item.question || "—"}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0 text-muted-foreground">Respondió</dt>
                        <dd className="min-w-0 whitespace-pre-wrap">{item.reply}</dd>
                      </div>
                    </dl>
                    <div className="flex flex-wrap items-center gap-2">
                      {canCorrect ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            disabled={markOk.isPending}
                            onClick={() => markOk.mutate({ id: item.id })}
                          >
                            Estuvo bien
                          </Button>
                          {item.question ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 sm:min-h-8"
                              disabled={markOk.isPending}
                              onClick={() => markOk.mutate({ id: item.id, asExample: true })}
                            >
                              Guardar como ejemplo
                            </Button>
                          ) : null}
                          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => correct(item)}>
                            Corregir
                          </Button>
                        </>
                      ) : null}
                      <Link to="/inbox" search={{ conversation: item.conversationId }} className={LINK}>
                        Abrir la conversación
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {markOk.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(markOk.error)}
              </p>
            ) : null}
            {!allReview && data.review.length > PREVIEW ? (
              <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setAllReview(true)}>
                {data.review.length - PREVIEW === 1 ? "Ver la otra" : `Ver las otras ${data.review.length - PREVIEW}`}
              </Button>
            ) : null}
          </Section>

          <Section
            id="por-aprobar"
            title={data.proposed.length > 0 ? `Lecciones por aprobar · ${data.proposed.length}` : "Lecciones por aprobar"}
            hint="Lo que propone aprender. Nada cambia hasta que apruebes."
          >
            {data.proposed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay lecciones esperando. Aparecen cuando corriges una respuesta o cambias un borrador antes de aprobarlo.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {data.proposed.map((lesson) => (
                  <LessonRow key={lesson.id} lesson={lesson} action={canWrite ? "Ver y aprobar" : "Ver"} onOpen={() => setLessonId(lesson.id)}>
                    <p className="mt-1 text-sm">{impactSummary(lesson.impact)}</p>
                  </LessonRow>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="lo-aprendido"
            title={data.learned.length > 0 ? `Lo aprendido · ${data.learned.length}` : "Lo aprendido"}
            hint="Cada una dice de quién es y cuánto se usa. Cualquiera se puede retirar."
          >
            {data.learned.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no aprobaste ninguna lección.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {(allLearned ? data.learned : data.learned.slice(0, PREVIEW + 1)).map((lesson) => (
                  <LessonRow key={lesson.id} lesson={lesson} action={canWrite ? "Retirar" : "Ver"} onOpen={() => setLessonId(lesson.id)}>
                    <p className="text-sm text-muted-foreground">{usage(lesson)}</p>
                  </LessonRow>
                ))}
              </ul>
            )}
            {!allLearned && data.learned.length > PREVIEW + 1 ? (
              <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setAllLearned(true)}>
                Ver las {data.learned.length}
              </Button>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {data.cases === 0
                ? "Aún no hay casos de prueba: cada lección aprobada guarda el suyo."
                : `${data.cases} ${data.cases === 1 ? "caso de prueba guardado" : "casos de prueba guardados"}: preguntas reales con la respuesta que diste por buena.`}
            </p>
            {data.withdrawn.length > 0 ? (
              <div className="flex flex-col gap-2 border-t pt-4">
                <h3 className="text-sm font-semibold">
                  Retiradas · {data.withdrawn.length}, se pueden restaurar
                </h3>
                <ul className="flex flex-col divide-y">
                  {data.withdrawn.map((lesson) => (
                    <LessonRow key={lesson.id} lesson={lesson} action={canWrite ? "Restaurar" : "Ver"} onOpen={() => setLessonId(lesson.id)} />
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>
        </>
      )}
      <CorrectDrawer target={correcting} onClose={() => setCorrecting(null)} onCorrected={(lesson) => canWrite && setLessonId(lesson.id)} />
      <LessonDrawer lessonId={lessonId} canWrite={canWrite} onClose={() => setLessonId(null)} />
    </PageShell>
  )
}
