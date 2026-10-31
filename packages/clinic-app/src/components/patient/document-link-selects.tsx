/**
 * Vínculos contextuales de un documento: presupuesto, control, receta y pago.
 *
 * La atención y el tratamiento tienen sus propios selectores en cada superficie;
 * estos cuatro completan la cadena clínico-económica para que un archivo se lea
 * desde el hecho que lo originó. Sin vínculo, el documento sigue siendo válido.
 *
 * Es un grupo: cada selector lleva su nombre, pero el nombre, la ayuda y el
 * error del conjunto los pinta la pantalla (`FieldSet` + `FieldLegend` o
 * `aria-label`). `id` va al primer selector; los demás derivan de él.
 */
import {
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { fetchBudgets } from "../../lib/budgets"
import {
  fetchFollowUps,
  fetchPrescriptions,
  formatDate,
} from "../../lib/clinical-journey"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"

/** Vínculos soportados por la API; cadena vacía = sin vínculo. */
export interface DocumentLinkValue {
  budgetId: string
  followUpId: string
  prescriptionId: string
  paymentId: string
  encounterProcedureId: string
}

export function DocumentLinkSelects({
  id: idProp,
  patientId,
  value,
  onChange,
  procedures,
  invalid = false,
  onBlur,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: {
  /** El del primer selector (Procedimiento); los demás son `${id}-budget`, `${id}-follow-up`… */
  id?: string
  patientId: string
  value: DocumentLinkValue
  onChange: (patch: Partial<DocumentLinkValue>) => void
  /** Procedimientos de la atención elegida: sin atención no hay ninguno que vincular. */
  procedures?: Array<{ id: string; description: string }>
  /** El error lo dice la pantalla: el grupo solo se marca. */
  invalid?: boolean
  /** Al salir del grupo. */
  onBlur?: () => void
  "aria-describedby"?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}): React.JSX.Element {
  const fallbackId = useId()
  const id = idProp ?? fallbackId
  const marked = invalid || undefined
  // Formato de la clínica para los importes históricos (moneda congelada del pago).
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const budgets = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
  })
  const followUps = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
  })
  const prescriptions = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
  })
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
  })

  const budgetList = budgets.data?.data ?? []
  const followUpList = followUps.data?.data ?? []
  const prescriptionList = prescriptions.data?.data ?? []
  // Cobros con ticket + historial anterior sin ticket (nunca se esconde).
  const summary = account.data?.data ?? null
  const paymentList = [
    ...(summary?.cobros ?? []).flatMap((ticket) =>
      ticket.payments
        .filter((payment) => !payment.voidedAt)
        .map((payment) => ({
          id: payment.id,
          paidAt: ticket.createdAt,
          amountCents: payment.amountCents,
          currency: ticket.currency,
        })),
    ),
    ...(summary?.historico ?? [])
      .filter((row) => row.status === "vigente")
      .map((row) => ({
        id: row.paymentId,
        paidAt: row.paidAt,
        amountCents: row.amountCents,
        currency: row.currency,
      })),
  ]

  return (
    <fieldset
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-invalid={marked}
      aria-describedby={describedBy}
      className="grid min-w-0 gap-3 sm:grid-cols-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.()
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Procedimiento</FieldLabel>
        <Select
          value={value.encounterProcedureId || undefined}
          onValueChange={(next) => onChange({ encounterProcedureId: next ?? "" })}
        >
          <SelectTrigger id={id} aria-label="Procedimiento vinculado" aria-invalid={marked}>
            <SelectValue
              placeholder={
                (procedures?.length ?? 0) === 0
                  ? "Elige una atención con procedimientos"
                  : "Sin procedimiento"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(procedures ?? []).map((procedure) => (
              <SelectItem key={procedure.id} value={procedure.id}>
                {procedure.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${id}-budget`}>Presupuesto</FieldLabel>
        <Select
          value={value.budgetId || undefined}
          onValueChange={(next) => onChange({ budgetId: next ?? "" })}
        >
          <SelectTrigger id={`${id}-budget`} aria-label="Presupuesto vinculado" aria-invalid={marked}>
            <SelectValue placeholder="Sin presupuesto" />
          </SelectTrigger>
          <SelectContent>
            {budgetList.map((budget) => (
              <SelectItem key={budget.id} value={budget.id}>
                Presupuesto N.º {budget.budgetNumber} · {budget.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${id}-follow-up`}>Control</FieldLabel>
        <Select
          value={value.followUpId || undefined}
          onValueChange={(next) => onChange({ followUpId: next ?? "" })}
        >
          <SelectTrigger id={`${id}-follow-up`} aria-label="Control vinculado" aria-invalid={marked}>
            <SelectValue placeholder="Sin control" />
          </SelectTrigger>
          <SelectContent>
            {followUpList.map((followUp) => (
              <SelectItem key={followUp.id} value={followUp.id}>
                {followUp.title} · {formatDate(followUp.dueAt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${id}-prescription`}>Receta</FieldLabel>
        <Select
          value={value.prescriptionId || undefined}
          onValueChange={(next) => onChange({ prescriptionId: next ?? "" })}
        >
          <SelectTrigger id={`${id}-prescription`} aria-label="Receta vinculada" aria-invalid={marked}>
            <SelectValue placeholder="Sin receta" />
          </SelectTrigger>
          <SelectContent>
            {prescriptionList.map((prescription) => (
              <SelectItem key={prescription.id} value={prescription.id}>
                Receta N.º {prescription.prescriptionNumber} · {formatDate(prescription.issuedAt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${id}-payment`}>Pago</FieldLabel>
        <Select
          value={value.paymentId || undefined}
          onValueChange={(next) => onChange({ paymentId: next ?? "" })}
        >
          <SelectTrigger id={`${id}-payment`} aria-label="Pago vinculado" aria-invalid={marked}>
            <SelectValue placeholder="Sin pago" />
          </SelectTrigger>
          <SelectContent>
            {paymentList.map((payment) => (
              <SelectItem key={payment.id} value={payment.id}>
                {formatDate(payment.paidAt)} ·{" "}
                {orgLocale ? formatMoney(payment.amountCents, payment.currency, orgLocale) : "…"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </fieldset>
  )
}
