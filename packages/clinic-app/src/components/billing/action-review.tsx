/**
 * «Pedir revisión» de una fila de «Cada acción de tus agentes» (issue 77,
 * ADR 0054, tablero 6). El spam de quien no es paciente se devuelve al
 * instante hasta la parte de las conversaciones del mes que dicen las
 * condiciones comerciales (ADR 0074); lo demás lo revisa odentIA y se sigue en
 * Soporte. Lo decide el servidor: esta pantalla solo dice lo que puede pasar.
 */
import { Checkbox, cn, FieldLabel, RadioGroup, RadioGroupItem, Textarea, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { businessDaysWords, type SaasTerms, useSaasTerms } from "../../lib/billing"
import type { SaasActionKind } from "./consumption"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { formatMicros } from "./money"

export type ReviewReason = "spam" | "agente" | "doble" | "otro"

/** La revisión que entrega el servidor en cada fila. */
export interface ActionReview {
  id: string
  status: "pendiente" | "devuelta" | "mantenida"
  reason: ReviewReason
  automatic: boolean
  requestedAt: string
  answer: string | null
  decidedAt: string | null
  credited: boolean
  byName: string | null
  caseId: string | null
  /** Ya cobrada, pero la cubrió el crédito: no hay importe que devolver. */
  coveredByCredit: boolean
}

/** Lo que el cajón necesita de la fila. */
export interface ReviewTarget {
  id: string
  kind: SaasActionKind
  occurredAt: string
  personName: string | null
  priceMicros: number | null
  conversationId: string | null
}

/** Lo que pasa con cada motivo, con las cifras de las condiciones comerciales (ADR 0074); sin ellas aún, sin cifra. */
const reviewedByOdentia = (terms: SaasTerms | undefined) =>
  terms ? `Lo revisa odentIA en ${businessDaysWords(terms.reviewAnswerDays)}.` : "Lo revisa odentIA."

const REASONS: Array<{ value: ReviewReason; label: string; outcome: (terms: SaasTerms | undefined) => string; onlyConversation?: boolean }> = [
  {
    value: "spam",
    label: "Era spam, publicidad o un número equivocado",
    outcome: (terms) =>
      terms && terms.reviewAutoPercent > 0
        ? `Se devuelve al instante, hasta el ${terms.reviewAutoPercent} % de las conversaciones del mes, y la persona pasa a Spam.`
        : terms
          ? `${reviewedByOdentia(terms)} La persona pasa a Spam.`
          : "Se devuelve al instante y la persona pasa a Spam.",
    onlyConversation: true,
  },
  { value: "agente", label: "El agente respondió mal o no ayudó", outcome: reviewedByOdentia },
  { value: "doble", label: "Se cobró dos veces", outcome: reviewedByOdentia },
  { value: "otro", label: "Otro motivo", outcome: reviewedByOdentia },
]

const KIND_WORDS: Record<SaasActionKind, string> = {
  conversacion: "Conversación",
  consulta: "Consulta dictada",
  cita: "Cita recuperada",
  preguntas: "Paquete de preguntas",
  almacenamiento: "Almacenamiento",
}

const NOTE_MAX = 1000

function day(iso: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() }).format(new Date(iso))
}

/**
 * Lo que dice la columna «Estado» de una fila con revisión. `charged`: la
 * fila ya salió en un cargo, así que lo devuelto va en el siguiente.
 */
export function reviewStateWords(review: ActionReview, priceMicros: number | null, charged: boolean): string {
  const money = priceMicros === null ? "" : formatMicros(priceMicros, "USD")
  if (review.status === "pendiente") return `En revisión · la pediste el ${day(review.requestedAt)}`
  if (review.status === "mantenida") return "Se mantiene"
  if (charged && review.coveredByCredit) return "Te dimos la razón · no se te cobró aparte: la cubrió el crédito del mes"
  if (charged) return review.credited ? `Devuelta: ${money}, descontada en el cargo siguiente` : `Devuelta: ${money} en tu próximo cargo`
  if (review.automatic) return `No se cobra: era spam${review.byName ? ` · lo marcó ${review.byName.split(" ")[0]}` : ""}`
  return "No se cobra: odentIA la devolvió"
}

/** El cajón «Pedir revisión de este cobro». */
export function ActionReviewDrawer({
  organizationId,
  target,
  onClose,
}: {
  organizationId: string
  target: ReviewTarget | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const terms = useSaasTerms().data
  const reasonId = useId()
  const noteId = useId()
  const readId = useId()
  const [reason, setReason] = useState<ReviewReason | "">("")
  const [note, setNote] = useState("")
  const [allowRead, setAllowRead] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (target) {
      setReason("")
      setNote("")
      setAllowRead(false)
      setError(null)
    }
  }, [target])
  const request = useMutation({
    mutationFn: (input: { actionId: string; reason: ReviewReason; note: string | null; allowRead: boolean }) =>
      apiFetch<{ data: { status: "pendiente" | "devuelta"; automatic: boolean; caseId: string | null } }>(
        `/api/account/billing/actions/${input.actionId}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: organizationId, reason: input.reason, note: input.note, allowRead: input.allowRead }),
        },
      ).then((res) => res.data),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["billing", organizationId] })
      toast.success(
        result.automatic
          ? "Listo: no se cobra y la persona pasó a Spam"
          : terms
            ? `Pediste la revisión: odentIA responde en ${businessDaysWords(terms.reviewAnswerDays)} y la sigues en Soporte`
            : "Pediste la revisión: la sigues en Soporte",
      )
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError && err.shape.message ? err.shape.message : "No se pudo pedir la revisión. Reintenta en un momento."),
  })
  const options = REASONS.filter((option) => !option.onlyConversation || target?.kind === "conversacion")
  const who = target?.personName ?? "Sin persona"
  return (
    <FormDrawer
      open={target !== null}
      onClose={onClose}
      title="Pedir revisión de este cobro"
      description={
        target
          ? `${KIND_WORDS[target.kind]} con ${who} · ${day(target.occurredAt)}${target.priceMicros !== null ? ` · ${formatMicros(target.priceMicros, "USD")}` : ""}`
          : undefined
      }
      onSubmit={(event) => {
        event.preventDefault()
        if (!target) return
        if (!reason) {
          setError("Elige por qué no debió cobrarse")
          return
        }
        setError(null)
        request.mutate({ actionId: target.id, reason, note: note.trim() || null, allowRead: Boolean(target.conversationId) && allowRead })
      }}
      isDirty={reason !== "" || note.trim() !== "" || allowRead}
      isSubmitting={request.isPending}
      error={error}
      submitLabel="Pedir revisión"
    >
      <div className="grid gap-2">
        <span id={reasonId} className="text-sm font-medium">
          ¿Por qué no debió cobrarse?
        </span>
        <RadioGroup aria-labelledby={reasonId} value={reason} onValueChange={(next) => setReason(String(next) as ReviewReason)}>
          {options.map((option) => (
            <FieldLabel
              key={option.value}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-normal",
                reason === option.value && "border-primary bg-primary/5",
              )}
            >
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.outcome(terms)}</span>
              </span>
            </FieldLabel>
          ))}
        </RadioGroup>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium">
          Cuéntanos qué pasó (opcional)
        </label>
        <Textarea
          id={noteId}
          maxLength={NOTE_MAX}
          rows={3}
          placeholder="Por ejemplo: le dio un horario del sábado que no tenemos."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {target?.conversationId ? (
        <div className="flex items-start gap-2.5 rounded-xl border p-3">
          <Checkbox id={readId} checked={allowRead} onCheckedChange={(checked) => setAllowRead(checked === true)} className="mt-0.5" />
          <label htmlFor={readId} className="grid gap-0.5 text-sm">
            <span className="font-medium">Dejo que odentIA lea esta conversación</span>
            <span className="text-xs text-muted-foreground">
              Solo esta, hasta que responda la revisión{terms ? ` y como mucho ${terms.reviewReadDays} ${terms.reviewReadDays === 1 ? "día" : "días"}` : ""}. Sin esto,
              odentIA solo ve lo que hizo el agente, sin los mensajes.
            </span>
          </label>
        </div>
      ) : null}
    </FormDrawer>
  )
}
