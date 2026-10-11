import { Button } from "@odentia/ui"
import { DetailDrawer, DetailSection } from "@odentia/ui-patterns"
import { BookOpen, CalendarDays, CircleAlert, CircleCheck, GraduationCap, MessagesSquare, Notebook, Tag, UserRound } from "lucide-react"
import type { ReactNode } from "react"
import { ANSWER_CHECK_LABEL, type AnswerCheck, type AnswerTrace } from "../../lib/agent"

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

const OUTCOME_NOTE: Record<AnswerTrace["outcome"], string | null> = {
  enviada: null,
  pendiente: "Esta respuesta esperaba una decisión antes de enviarse.",
  bloqueada: "Esta respuesta no se envió: tenía un dato que no estaba en lo consultado.",
  fallida: "Esta respuesta no llegó a enviarse.",
}

function CheckRow({ check }: { check: AnswerCheck }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border bg-card p-3 text-sm">
      <span
        className={`mt-0.5 shrink-0 [&>svg]:size-4 ${check.ok ? "text-success" : "text-destructive"}`}
      >
        {check.ok ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      </span>
      <span className="min-w-0">
        <span className="font-semibold">
          {ANSWER_CHECK_LABEL[check.kind]}: {check.value}
        </span>
        <span className="block text-muted-foreground">
          {check.ok ? `Está en: ${check.source ?? "lo consultado"}` : "No está en lo consultado"}
        </span>
      </span>
    </li>
  )
}

/**
 * En qué se basó una respuesta del agente: qué consultó y qué datos se
 * comprobaron antes de enviarla. Solo lectura.
 */
export function AnswerTraceDrawer({
  trace,
  locale = "es-PE",
  timeZone,
  onClose,
  onCorrect,
}: {
  trace: AnswerTrace | null
  locale?: string
  timeZone?: string
  onClose: () => void
  /** Quien puede decidir por el agente corrige la respuesta desde aquí. */
  onCorrect?: (trace: AnswerTrace) => void
}) {
  if (!trace) return null
  const when = new Date(trace.createdAt).toLocaleString(locale, {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const note = OUTCOME_NOTE[trace.outcome]
  return (
    <DetailDrawer open title="En qué se basó" description={`Respuesta del agente · ${when}`} onClose={onClose}>
      <div className="flex flex-col gap-6">
        <DetailSection title="La respuesta">
          <p className="whitespace-pre-wrap rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
            {trace.replyText}
          </p>
          {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        </DetailSection>

        <DetailSection title="Lo que consultó">
          {trace.basis.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No consultó ninguna fuente en este turno: respondió con lo que ya había en la conversación.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {trace.basis.map((item) => (
                <li key={`${item.kind}-${item.label}`} className="flex items-start gap-2.5 rounded-xl border bg-card p-3 text-sm">
                  <span className="mt-0.5 shrink-0 text-primary-soft-foreground [&>svg]:size-4">
                    {BASIS_ICON[item.kind] ?? <BookOpen aria-hidden />}
                  </span>
                  <span className="min-w-0">
                    <span className="font-semibold">{item.label}</span>
                    {item.detail ? <span className="block text-muted-foreground">{item.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Datos comprobados antes de enviar">
          {trace.checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Esta respuesta no llevaba precios, fechas ni horas que comprobar.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {trace.checks.map((check) => (
                <CheckRow key={`${check.kind}-${check.value}`} check={check} />
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Se comprueban precios, fechas y horas contra lo consultado. El resto del texto no se revisa.
          </p>
        </DetailSection>

        {onCorrect && trace.outcome === "enviada" ? (
          <DetailSection title="¿No debió responder así?">
            <p className="text-sm text-muted-foreground">
              Corrígela y se propondrá qué aprender. Nada cambia hasta que lo apruebe quien administra el agente.
            </p>
            <Button type="button" variant="outline" className="min-h-11 self-start sm:min-h-9" onClick={() => onCorrect(trace)}>
              Corregir esta respuesta
            </Button>
          </DetailSection>
        ) : null}
      </div>
    </DetailDrawer>
  )
}
