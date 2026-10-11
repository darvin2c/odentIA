/**
 * Vínculos contextuales de un documento: presupuesto, control, receta y pago.
 *
 * La atención y el tratamiento tienen sus propios selectores en cada superficie;
 * estos cuatro completan la cadena clínico-económica para que un archivo se lea
 * desde el hecho que lo originó. Sin vínculo, el documento sigue siendo válido.
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
  patientId,
  value,
  onChange,
  idPrefix,
  procedures,
}: {
  patientId: string
  value: DocumentLinkValue
  onChange: (patch: Partial<DocumentLinkValue>) => void
  idPrefix: string
  /** Procedimientos de la atención elegida: sin atención no hay ninguno que vincular. */
  procedures?: Array<{ id: string; description: string }>
}): React.JSX.Element {
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
    <div className="grid gap-3 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-procedure`}>Procedimiento</FieldLabel>
        <Select
          value={value.encounterProcedureId || undefined}
          onValueChange={(next) => onChange({ encounterProcedureId: next ?? "" })}
        >
          <SelectTrigger id={`${idPrefix}-procedure`} aria-label="Procedimiento vinculado">
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
        <FieldLabel htmlFor={`${idPrefix}-budget`}>Presupuesto</FieldLabel>
        <Select
          value={value.budgetId || undefined}
          onValueChange={(next) => onChange({ budgetId: next ?? "" })}
        >
          <SelectTrigger id={`${idPrefix}-budget`} aria-label="Presupuesto vinculado">
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
        <FieldLabel htmlFor={`${idPrefix}-follow-up`}>Control</FieldLabel>
        <Select
          value={value.followUpId || undefined}
          onValueChange={(next) => onChange({ followUpId: next ?? "" })}
        >
          <SelectTrigger id={`${idPrefix}-follow-up`} aria-label="Control vinculado">
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
        <FieldLabel htmlFor={`${idPrefix}-prescription`}>Receta</FieldLabel>
        <Select
          value={value.prescriptionId || undefined}
          onValueChange={(next) => onChange({ prescriptionId: next ?? "" })}
        >
          <SelectTrigger id={`${idPrefix}-prescription`} aria-label="Receta vinculada">
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
        <FieldLabel htmlFor={`${idPrefix}-payment`}>Pago</FieldLabel>
        <Select
          value={value.paymentId || undefined}
          onValueChange={(next) => onChange({ paymentId: next ?? "" })}
        >
          <SelectTrigger id={`${idPrefix}-payment`} aria-label="Pago vinculado">
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
    </div>
  )
}
