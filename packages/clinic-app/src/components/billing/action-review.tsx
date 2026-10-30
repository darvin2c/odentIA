/**
 * «Pedir revisión» de una fila de «Cada acción de tus agentes» (issue 77,
 * ADR 0054, tablero 6). El spam de quien no es paciente se devuelve al
 * instante hasta la parte de las conversaciones del mes que dicen las
 * condiciones comerciales (ADR 0074); lo demás lo revisa odentIA y se sigue en
 * Soporte. Lo decide el servidor: esta pantalla solo dice lo que puede pasar.
 */
import { cn, FieldLabel, RadioGroup, RadioGroupItem, toast } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { businessDaysWords, type SaasTerms, useSaasTerms } from "../../lib/billing"
import type { SaasActionKind } from "./consumption"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { formatMicros } from "./money"
import { appWords } from "../../lib/product-words"

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
  terms ? `Lo revisa ${appWords().name} en ${businessDaysWords(terms.reviewAnswerDays)}.` : `Lo revisa ${appWords().name}.`

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

// Los mismos límites que la ruta: el motivo es obligatorio y la nota tiene tope.
const reviewSchema = z.object({
  reason: z.custom<ReviewReason | "">((value) => typeof value === "string").refine((value) => value !== "", "Elige por qué no debió cobrarse."),
  note: z.string().trim().max(NOTE_MAX, `Lo que cuentas admite hasta ${NOTE_MAX} caracteres.`),
  allowRead: z.boolean(),
})

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
  return `No se cobra: ${appWords().name} la devolvió`
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
  })
  const form = useAppForm({
    defaultValues: { reason: "" as ReviewReason | "", note: "", allowRead: false },
    validators: { onSubmit: reviewSchema },
    onSubmit: async ({ value }) => {
      if (!target || !value.reason) return
      const result = await request.mutateAsync({
        actionId: target.id,
        reason: value.reason,
        note: value.note.trim() || null,
        allowRead: Boolean(target.conversationId) && value.allowRead,
      })
      void queryClient.invalidateQueries({ queryKey: ["billing", organizationId] })
      toast.success(
        result.automatic
          ? "Listo: no se cobra y la persona pasó a Spam"
          : terms
            ? `Pediste la revisión: ${appWords().name} responde en ${businessDaysWords(terms.reviewAnswerDays)} y la sigues en Soporte`
            : "Pediste la revisión: la sigues en Soporte",
      )
      onClose()
    },
  })
  // Cada fila empieza en blanco.
  useEffect(() => {
    if (target) form.reset()
  }, [target, form])
  const surface = useFormSurface(form)
  const reason = useStore(form.store, (state) => state.values.reason)
  const options = REASONS.filter((option) => !option.onlyConversation || target?.kind === "conversacion")
  const who = target?.personName ?? "Sin persona"
  return (
    <FormDrawer
      {...surface}
      open={target !== null}
      onClose={onClose}
      title="Pedir revisión de este cobro"
      description={
        target
          ? `${KIND_WORDS[target.kind]} con ${who} · ${day(target.occurredAt)}${target.priceMicros !== null ? ` · ${formatMicros(target.priceMicros, "USD")}` : ""}`
          : undefined
      }
      submitLabel="Pedir revisión"
    >
      <form.AppField name="reason">
        {(field) => (
          <field.Group legend="¿Por qué no debió cobrarse?">
            {(control) => (
              <RadioGroup
                name={control.name}
                aria-invalid={control.invalid || undefined}
                aria-describedby={control.describedBy}
                value={field.state.value}
                onValueChange={(next) => {
                  field.handleChange(String(next) as ReviewReason)
                  field.handleBlur()
                }}
              >
                {options.map((option) => (
                  <FieldLabel
                    key={option.value}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-normal",
                      reason === option.value && "border-primary bg-primary/5",
                    )}
                  >
                    <RadioGroupItem value={option.value} className="mt-0.5" aria-invalid={control.invalid || undefined} />
                    <span className="grid gap-0.5">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.outcome(terms)}</span>
                    </span>
                  </FieldLabel>
                ))}
              </RadioGroup>
            )}
          </field.Group>
        )}
      </form.AppField>
      <form.AppField name="note">
        {(field) => (
          <field.TextareaField
            label="Cuéntanos qué pasó (opcional)"
            maxLength={NOTE_MAX}
            rows={3}
            placeholder="Por ejemplo: le dio un horario del sábado que no tenemos."
          />
        )}
      </form.AppField>
      {target?.conversationId ? (
        <form.AppField name="allowRead">
          {(field) => (
            <field.CheckboxField
              className="items-start gap-2.5 rounded-xl border p-3"
              label={`Dejo que ${appWords().name} lea esta conversación`}
              description={`Solo esta, hasta que responda la revisión${terms ? ` y como mucho ${terms.reviewReadDays} ${terms.reviewReadDays === 1 ? "día" : "días"}` : ""}. Sin esto, ${appWords().name} solo ve lo que hizo el agente, sin los mensajes.`}
            />
          )}
        </form.AppField>
      ) : null}
    </FormDrawer>
  )
}
