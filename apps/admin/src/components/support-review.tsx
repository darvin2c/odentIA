/**
 * «Revisión de cobro» dentro de un caso de Soporte (issue 77, ADR 0054,
 * tablero 7): la fila que la clínica pidió revisar, el motivo, lo que contó,
 * la conversación solo con su permiso y mientras dure, y la decisión. Decide
 * quien tiene el rol admin, siempre con lo que se le dice a la clínica;
 * soporte lo lee y deja notas.
 */
import { Button, ScrollArea } from "@odentia/ui"
import { useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../lib/api"

export const caseReview = z.object({
  id: z.string(),
  status: z.enum(["pendiente", "devuelta", "mantenida"]),
  reason: z.string(),
  reasonWords: z.string(),
  note: z.string().nullable(),
  requestedAt: z.string(),
  requestedByName: z.string().nullable(),
  /** El último día para responder, con los días hábiles que regían al pedirla (condiciones comerciales). */
  answerBy: z.string().nullable(),
  readUntil: z.string().nullable(),
  answer: z.string().nullable(),
  decidedAt: z.string().nullable(),
  action: z.object({
    id: z.string(),
    kind: z.string(),
    occurredAt: z.string(),
    detail: z.string(),
    channel: z.string().nullable(),
    priceMicros: z.number().nullable(),
    currency: z.string().nullable(),
    charged: z.boolean(),
    coveredByCredit: z.boolean(),
    hasConversation: z.boolean(),
  }),
})
export type CaseReview = z.infer<typeof caseReview>

const reviewMessage = z.object({
  direction: z.string(),
  senderKind: z.string(),
  body: z.string().nullable(),
  createdAt: z.string(),
})

const KIND_WORDS: Record<string, string> = {
  conversacion: "Conversación · Sofi",
  consulta: "Consulta dictada · Clío",
  cita: "Cita recuperada · Argos",
}

const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  email: "Correo",
  webchat: "Chat web",
}

const day = (iso: string) => new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric", month: "short" }).format(new Date(iso))
const dayTime = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))

function money(micros: number | null, currency: string | null): string {
  if (micros === null) return "sin precio"
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency: currency ?? "USD", minimumFractionDigits: 2 }).format(micros / 1_000_000)
  } catch {
    return `${(micros / 1_000_000).toFixed(2)} ${currency ?? ""}`.trim()
  }
}

function speaker(message: z.infer<typeof reviewMessage>): string {
  if (message.direction === "in") return "Persona"
  return message.senderKind === "agent" ? "Agente" : message.senderKind === "user" ? "Equipo" : "Automático"
}

/** La decisión: lo que se le dice a la clínica (los mismos límites que la ruta) y si se le da la razón. */
const decideSchema = z.object({
  answer: z
    .string()
    .trim()
    .min(1, "Escribe qué le dices a la clínica")
    .max(1000, "Escribe como mucho 1000 caracteres"),
  accept: z.boolean(),
})

export function SupportCaseReview({
  caseId,
  review,
  roleLabel,
  isAdmin,
}: {
  caseId: string
  review: CaseReview
  /** El rol de quien pidió, tal como lo guarda el caso. */
  roleLabel: string
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const conversation = useQuery({
    queryKey: ["admin-support-review-conversation", caseId],
    queryFn: () =>
      api(`/api/admin/support/cases/${caseId}/review/conversation`).then((body: unknown) => z.array(reviewMessage).parse(body)),
    enabled: false,
    retry: false,
  })
  const decide = useMutation({
    mutationFn: (body: { accept: boolean; answer: string }) =>
      api(`/api/admin/support/cases/${caseId}/review/decide`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-support-cases"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-support-case"] })
    },
  })
  const form = useAppForm({
    defaultValues: { answer: "", accept: true },
    validators: { onSubmit: decideSchema },
    onSubmit: async ({ value, formApi }) => {
      await decide.mutateAsync({ accept: value.accept, answer: value.answer.trim() })
      formApi.reset()
    },
  })
  const onSubmit = useFormSubmit(form)
  const submitError = useFormSubmitError(form)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const { action } = review
  const price = money(action.priceMicros, action.currency)
  const channel = action.channel ? CHANNEL_WORDS[action.channel] : null
  const pending = review.status === "pendiente"

  return (
    <section aria-label="Revisión de cobro" className="flex flex-col gap-2.5 rounded-xl border px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">Revisión de cobro</h3>
        {pending && review.answerBy ? (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-bold">Responder antes del {day(review.answerBy)}</span>
        ) : pending ? (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-bold">Por responder</span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
            {review.status === "devuelta" ? "Devuelta" : "Se mantuvo"}
            {review.decidedAt ? ` · ${dayTime(review.decidedAt)}` : ""}
          </span>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted-foreground">Fila</dt>
        <dd>
          {KIND_WORDS[action.kind] ?? action.kind} del {dayTime(action.occurredAt)}
          {channel ? ` · ${channel}` : ""} · {price}
          {action.charged
            ? action.coveredByCredit
              ? " · ya facturada, la cubrió el crédito del mes: darle la razón no devuelve dinero"
              : " · ya facturada: si se devuelve, sale en el cargo siguiente"
            : " · aún sin facturar"}
          <span className="block text-muted-foreground">{action.detail}</span>
        </dd>
        <dt className="text-muted-foreground">Motivo</dt>
        <dd>{review.reasonWords}</dd>
        {review.note ? (
          <>
            <dt className="text-muted-foreground">Dice la clínica</dt>
            <dd>«{review.note}»</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Lo pidió</dt>
        <dd>
          {review.requestedByName ?? "Alguien de la clínica"}
          {roleLabel ? ` (${roleLabel.toLowerCase()})` : ""} · {dayTime(review.requestedAt)}
        </dd>
        {action.hasConversation ? (
          <>
            <dt className="text-muted-foreground">Conversación</dt>
            <dd>
              {review.readUntil ? (
                <span className="flex flex-col items-start gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={conversation.isFetching}
                    onClick={() => void conversation.refetch()}
                  >
                    {conversation.data ? "Volver a leer" : "Leer la conversación"}
                  </Button>
                  <span className="text-muted-foreground">
                    Con permiso de la clínica hasta la respuesta, como mucho hasta el {day(review.readUntil)} · queda en la auditoría
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {pending ? "La clínica no dio permiso para leerla: decide con lo que hizo el agente." : "El permiso para leerla terminó con la respuesta."}
                </span>
              )}
            </dd>
          </>
        ) : null}
      </dl>
      {conversation.isError ? (
        <p role="alert" className="text-destructive">
          {conversation.error instanceof Error ? conversation.error.message : "No se pudo leer la conversación."}
        </p>
      ) : null}
      {conversation.data ? (
        <ScrollArea className="flex max-h-80 flex-col rounded-lg bg-card">
          <ol className="flex flex-col gap-1.5 px-3 py-2" aria-label="Mensajes de la conversación">
            {conversation.data.map((message) => (
              <li key={`${message.createdAt}-${message.direction}-${message.senderKind}`}>
                <span className="text-xs font-bold text-muted-foreground">
                  {speaker(message)} · {dayTime(message.createdAt)}
                </span>
                <p className="whitespace-pre-wrap">{message.body ?? "(sin texto)"}</p>
              </li>
            ))}
          </ol>
        </ScrollArea>
      ) : null}

      {pending ? (
        isAdmin ? (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-1.5">
            <form.AppField name="answer">
              {(field) => (
                <field.TextareaField
                  label="Qué le decimos a la clínica (obligatorio)"
                  description="Sale como respuesta del caso y el caso queda resuelto."
                  rows={3}
                  maxLength={1000}
                  placeholder="Por ejemplo: tienen razón, el agente leyó el horario de verano. Devolvemos la conversación."
                />
              )}
            </form.AppField>
            <div className="flex flex-wrap gap-2">
              {/* Los dos botones envían el mismo formulario: cada uno dice antes qué se decide. */}
              <Button
                type="submit"
                className="min-h-11 sm:min-h-9"
                disabled={isSubmitting}
                onClick={() => form.setFieldValue("accept", true)}
              >
                {action.charged && action.coveredByCredit ? "Darle la razón" : `Devolver ${price}`}
              </Button>
              <Button
                type="submit"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={isSubmitting}
                onClick={() => form.setFieldValue("accept", false)}
              >
                Mantener el cobro
              </Button>
            </div>
            {submitError ? (
              <p role="alert" className="text-destructive">
                {submitError}
              </p>
            ) : null}
          </form>
        ) : (
          <p className="text-muted-foreground">Lo decide alguien con el rol Administración. Puedes dejar una nota interna en el caso.</p>
        )
      ) : review.answer ? (
        <p>
          <span className="text-muted-foreground">Se le dijo: </span>«{review.answer}»
        </p>
      ) : null}
    </section>
  )
}
