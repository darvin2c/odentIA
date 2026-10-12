import { Button } from "@odentia/ui"
import { DetailDrawer, DetailSection, SubmitButton } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { BookOpen, CalendarDays, CircleAlert, CircleCheck, GraduationCap, MessagesSquare, Notebook, Tag, UserRound } from "lucide-react"
import type { ReactNode } from "react"
import { apiFetch } from "../../lib/api"
import { ANSWER_CHECK_LABEL, type AnswerBasisItem, type AnswerTrace } from "../../lib/agent"
import { mutationErrorMessage } from "../../lib/query-error"

const BASIS_ICON: Record<string, ReactNode> = {
  agenda: <CalendarDays aria-hidden />,
  servicios: <Tag aria-hidden />,
  conocimiento: <BookOpen aria-hidden />,
  indicaciones: <BookOpen aria-hidden />,
  persona: <UserRound aria-hidden />,
  comercial: <UserRound aria-hidden />,
  caso: <Notebook aria-hidden />,
  conversacion: <MessagesSquare aria-hidden />,
  otros_canales: <MessagesSquare aria-hidden />,
  leccion: <GraduationCap aria-hidden />,
}

const AGENT_NAME: Record<string, string> = {
  recepcion: "Recepción",
  clinico: "Asistente clínico",
  asesor: "Asesor",
  ayuda: "Ayuda",
}

/** Lo que pasó con la respuesta, con lo que el sistema registra de ella. */
const OUTCOME: Record<AnswerTrace["outcome"], string> = {
  enviada: "Envió esta respuesta. No quedó esperando nada más por ella.",
  pendiente: "Dejó esta respuesta esperando una decisión antes de enviarse.",
  bloqueada: "No la envió: tenía un dato que no estaba en lo que consultó.",
  fallida: "Esta respuesta no llegó a enviarse.",
}

function BasisRow({ item, action }: { item: AnswerBasisItem; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border bg-card p-3 text-sm">
      <span className="mt-0.5 shrink-0 text-primary-soft-foreground [&>svg]:size-4">{BASIS_ICON[item.kind] ?? <BookOpen aria-hidden />}</span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{item.kind === "leccion" && item.detail ? item.detail : item.label}</span>
        <span className="block text-muted-foreground">{item.kind === "leccion" ? item.label : item.detail}</span>
      </span>
      {action}
    </li>
  )
}

/** «el precio, la fecha y la hora», según lo que la respuesta llevaba. */
function checkedKinds(trace: AnswerTrace): string {
  const names = [...new Set(trace.checks.map((check) => ANSWER_CHECK_LABEL[check.kind].toLowerCase()))].map((name) =>
    name === "precio" ? "el precio" : `la ${name}`,
  )
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`
}

/**
 * En qué se basó una respuesta del agente: la pregunta, los datos que usó, las
 * lecciones que aplicó, lo que se comprobó antes de enviarla y qué pasó con
 * ella. Quien atiende conversaciones dice si estuvo bien o la corrige.
 */
export function AnswerTraceDrawer({
  trace,
  locale = "es-PE",
  timeZone,
  onClose,
  onCorrect,
  canMark = false,
  onOpenLesson,
}: {
  trace: AnswerTrace | null
  locale?: string
  timeZone?: string
  onClose: () => void
  /** Quien atiende conversaciones corrige la respuesta desde aquí. */
  onCorrect?: (trace: AnswerTrace) => void
  /** Puede decir «Sí, estuvo bien». */
  canMark?: boolean
  /** Quien administra el agente abre la lección para retirarla. */
  onOpenLesson?: (lessonId: string) => void
}) {
  const ok = useMutation({
    retry: false,
    mutationFn: (traceId: string) => apiFetch(`/api/agent/learning/answers/${traceId}/ok`, { method: "POST" }),
  })
  if (!trace) return null
  const when = new Date(trace.createdAt).toLocaleString(locale, {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const data = trace.basis.filter((item) => item.kind !== "leccion")
  const lessons = trace.basis.filter((item) => item.kind === "leccion")
  const failed = trace.checks.filter((check) => !check.ok)
  const canReview = trace.outcome === "enviada" && (canMark || onCorrect !== undefined)
  const okError = mutationErrorMessage(ok.error)
  const close = () => {
    ok.reset()
    onClose()
  }

  return (
    <DetailDrawer
      open
      title="En qué se basó"
      description={`Respuesta de ${AGENT_NAME[trace.agent] ?? "el agente"} · ${when}`}
      onClose={close}
      isSubmitting={ok.isPending}
      actions={
        canReview && !ok.isSuccess ? (
          <>
            {onCorrect ? (
              <Button type="button" variant="outline" onClick={() => onCorrect(trace)}>
                Corregir
              </Button>
            ) : null}
            {canMark ? (
              <SubmitButton type="button" pending={ok.isPending} onClick={() => ok.mutate(trace.id)}>
                Sí, estuvo bien
              </SubmitButton>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 text-sm">
          {trace.question ? (
            <p className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2">
              <span className="sr-only">La persona escribió: </span>
              {trace.question}
            </p>
          ) : null}
          <p className="max-w-[90%] self-end whitespace-pre-wrap rounded-2xl rounded-br-sm border border-agent-border bg-agent-soft px-3 py-2">
            <span className="sr-only">El agente respondió: </span>
            {trace.replyText}
          </p>
        </div>

        <DetailSection title="Datos que usó">
          {data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No consultó ninguna fuente en este turno: respondió con lo que ya había en la conversación.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.map((item) => (
                <BasisRow key={`${item.kind}-${item.label}`} item={item} />
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Lecciones que aplicó">
          {lessons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No usó ninguna lección de tu clínica. Cuando usa una, aparece aquí y se puede retirar.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {lessons.map((item) => (
                <BasisRow
                  key={`${item.ref ?? item.detail}-${item.label}`}
                  item={item}
                  action={
                    item.ref && onOpenLesson ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 shrink-0 sm:min-h-8"
                        onClick={() => item.ref && onOpenLesson(item.ref)}
                      >
                        Retirar
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </DetailSection>

        {trace.checks.length === 0 ? (
          <p className="rounded-xl border bg-card p-3 text-sm text-muted-foreground">
            Esta respuesta no llevaba precios, fechas ni horas que comprobar.
          </p>
        ) : failed.length === 0 ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-success/40 bg-success/10 p-3 text-sm">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>
              <span className="block font-semibold">Comprobado antes de enviar</span>
              {checkedKinds(trace).replace(/^./, (first) => first.toUpperCase())}{" "}
              {trace.checks.length === 1 ? "coincide" : "coinciden"} con los datos que usó.
            </span>
          </div>
        ) : (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span>
              <span className="block font-semibold">No coincidía con los datos que usó</span>
              {failed.map((check) => `${ANSWER_CHECK_LABEL[check.kind]}: ${check.value}`).join(" · ")}
            </span>
          </div>
        )}

        <DetailSection title="Lo que hizo y lo que espera">
          <p className="text-sm">{OUTCOME[trace.outcome]}</p>
        </DetailSection>

        {canReview ? (
          <div className="flex flex-col gap-1 text-sm">
            {ok.isSuccess ? (
              <p role="status" className="font-semibold">
                Quedó marcada como una buena respuesta.
              </p>
            ) : (
              <p className="font-semibold">¿Estuvo bien esta respuesta?</p>
            )}
            {okError ? (
              <p role="alert" className="text-destructive">
                {okError}
              </p>
            ) : null}
            <p className="text-muted-foreground">
              Cualquiera que atiende conversaciones puede marcarla. Lo que se aprende lo aprueba quien administra.
            </p>
          </div>
        ) : null}
      </div>
    </DetailDrawer>
  )
}
