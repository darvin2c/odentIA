import { diagnosisCodeLabel } from "@odentia/clinical"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { type FormResponse, fetchFormResponses } from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"
import { useMemberName, usePermission } from "../../lib/crm"
import { allergyTitle } from "../../lib/allergies"
import { askWhom, pregnancyWords, saidByWords, saidNoWords } from "../../lib/declared-health"
import { clinicToday } from "../../lib/inventory"
import { asaLabel, type Encounter, fetchPatientHealth, isCurrentMedication, type PatientFull } from "../../lib/patients"
import { productUi } from "../../product/product-ui"
import { DeclaredResponse, isDeclaredUnreviewed } from "./declared-response"
import { HealthReviewNotice } from "./health-review-notice"

/**
 * Lo que respondió antes de venir sale arriba al abrir la atención: el
 * cuestionario que envió el paciente, para leer, con «Agregar una corrección»
 * y «Marcar como revisado» (`DeclaredResponse`). Revisado aquí, no desaparece:
 * queda ligado a esta atención y sigue a la vista con quién lo revisó y cuándo.
 * Solo las alergias que escribió en una pregunta de alergias pasan a
 * Antecedentes, y el aviso dice lo que pasó de verdad.
 */
export function DeclaredQuestionnaireNotice({
  patientId,
  patient,
  encounterId,
  disabled,
}: {
  patientId: string
  patient: PatientFull
  encounterId: string
  disabled: boolean
}): React.JSX.Element | null {
  const canWrite = usePermission("clinical.write")
  const responses = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
  })
  const shown: FormResponse[] = (responses.data?.data ?? []).filter(
    (row) =>
      row.source === "portal" &&
      (isDeclaredUnreviewed(row) || (row.status === "finalizado" && row.encounterId === encounterId)),
  )
  if (shown.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {shown.map((response) => (
        <section
          key={response.id}
          aria-label="Lo que respondió antes de venir"
          className={
            isDeclaredUnreviewed(response)
              ? "rounded-lg border border-warning/40 bg-warning-soft p-4"
              : "rounded-lg border bg-card p-4"
          }
        >
          <DeclaredResponse
            response={response}
            canWrite={canWrite}
            sex={patient.patient.sex}
            encounterId={encounterId}
            disabled={disabled}
            limit={6}
          />
        </section>
      ))}
    </div>
  )
}

/**
 * Su salud, al abrir la atención: alergias sin revisar (o de hace 6 meses) y
 * enfermedades o medicación que nunca se le preguntaron, con su respuesta a un
 * toque (`HealthReviewNotice`). Solo para quien lleva la atención.
 */
export function EncounterHealthReview({
  patientId,
  patient,
  disabled,
}: {
  patientId: string
  patient: PatientFull
  disabled: boolean
}): React.JSX.Element | null {
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
  })
  if (!health.data) return null
  return (
    <HealthReviewNotice
      patientId={patientId}
      patientName={patient.patient.displayName}
      health={health.data.data}
      disabled={disabled}
      askTo={askWhom(patient.contacts)}
      saidBy={{ sex: patient.patient.sex, contacts: patient.contacts }}
    />
  )
}

/**
 * Antecedentes y última atención, al lado y sin salir: lo que el profesional
 * necesita tener a mano mientras atiende. Solo lee; se edita en Clínica.
 */
export function EncounterContextBody({
  patientId,
  encounterId,
  patient,
}: {
  patientId: string
  encounterId: string
  /** La ficha, para decir quién dijo lo declarado (su sexo y quien decide por ella). */
  patient?: PatientFull
}): React.JSX.Element {
  const memberName = useMemberName()
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
  })
  const last = useQuery({
    queryKey: ["encounters", patientId, "ultima"],
    queryFn: () =>
      apiFetch<{ data: Array<Encounter & { diagnosisCodes?: string[]; procedureCount?: number }> }>(
        `/api/patients/${patientId}/encounters?status=finalizada&limit=2`,
      ),
  })
  const previous = (last.data?.data ?? []).find((row) => row.id !== encounterId) ?? null
  if (health.isPending) return <LoadingState message="Cargando antecedentes…" />
  if (health.isError)
    return <ErrorState message="No se pudieron cargar los antecedentes" onRetry={() => void health.refetch()} />
  const data = health.data.data
  const allergies = data.allergies.filter((allergy) => allergy.isActive)
  const conditions = data.conditions.filter((condition) => condition.isActive !== false && condition.status !== "resuelta")
  // La que toma: sin fin o con fin desde hoy, como en la receta; la ya terminada no se dice como actual.
  const today = clinicToday()
  const medications = data.medications.filter((medication) => isCurrentMedication(medication, today))
  const asa = asaLabel(data.asaClass)
  const showsAsa = productUi().health.showsAsa || asa !== null
  // Lo que dijo la persona y nadie revisó se dice igual que en la franja: su «No» no es un «niega».
  const mark = data.declared
  const saidBy = { sex: patient?.patient.sex, contacts: patient?.contacts ?? [] }
  const saidNo = `${saidNoWords(saidBy)} · sin revisar.`
  const unreviewed = (ids: readonly string[] | undefined, id: string) =>
    ids?.includes(id) ? ` · ${saidByWords(saidBy)}, sin revisar` : ""
  const pregnancy = data.pregnancy ? pregnancyWords(data.pregnancy) : null
  return (
    <div className="flex flex-col gap-5 text-sm">
      {pregnancy ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">Embarazo</h3>
          <p>
            {pregnancy.confirm
              ? `Por confirmar: ${pregnancy.detail}. Pregúntale si sigue embarazada.`
              : data.pregnancy?.weeksToday === null
                ? `${pregnancy.detail.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}.`
                : `${pregnancy.title.replace("Embarazo · ", "")} (${pregnancy.detail}).`}
            {mark?.pregnancy ? ` ${saidByWords(saidBy).replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}, sin revisar.` : ""}
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Alergias</h3>
        {allergies.length === 0 ? (
          // «No tiene» solo si se le preguntó; si nunca se preguntó, se dice así (ADR 0035).
          <p className="text-muted-foreground">
            {mark?.saidNo.allergies
              ? saidNo
              : data.reviewStatus.allergies === "none"
                ? "No tiene alergias."
                : "Aún no se le preguntó por alergias."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {allergies.map((allergy) => (
              <li key={allergy.id}>
                <strong>{allergyTitle(allergy)}</strong>
                {allergy.reaction ? ` · ${allergy.reaction}` : ""}
                {mark?.allergies.includes(allergy.id)
                  ? unreviewed(mark.allergies, allergy.id)
                  : allergy.source === "paciente"
                    ? " · la dijo el paciente"
                    : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Enfermedades</h3>
        {conditions.length === 0 ? (
          // Como las alergias: «niega» solo si se le preguntó; si no, se dice que no se preguntó.
          <p className="text-muted-foreground">
            {mark?.saidNo.conditions
              ? saidNo
              : data.reviewStatus.conditions === "none"
              ? "Niega enfermedades."
              : data.reviewStatus.conditions === "recorded"
                ? "Sin enfermedades activas."
                : "Aún no se le preguntó por sus enfermedades."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conditions.map((condition) => (
              <li key={condition.id}>
                {condition.name}
                {condition.diagnosisCode ? ` · ${diagnosisCodeLabel(condition.diagnosisSystem, condition.diagnosisCode)}` : ""}
                {unreviewed(mark?.conditions, condition.id)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Medicación</h3>
        {medications.length === 0 ? (
          <p className="text-muted-foreground">
            {mark?.saidNo.medications
              ? saidNo
              : data.reviewStatus.medications === "none"
              ? "No toma medicación."
              : data.reviewStatus.medications === "recorded"
                ? "Sin medicación vigente."
                : "Aún no se le preguntó por su medicación."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {medications.map((medication) => (
              <li key={medication.id}>
                {medication.name}
                {medication.dose ? ` · ${medication.dose}` : ""}
                {medication.frequency ? ` · ${medication.frequency}` : ""}
                {unreviewed(mark?.medications, medication.id)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {showsAsa ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">Riesgo anestésico</h3>
          <p className={asa ? undefined : "text-muted-foreground"}>{asa ?? "ASA sin clasificar."}</p>
        </section>
      ) : null}
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Última atención</h3>
        {last.isPending ? (
          <p className="text-muted-foreground">Cargando…</p>
        ) : !previous ? (
          <p className="text-muted-foreground">Es su primera atención cerrada.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p>
              {formatDate(previous.startedAt)} · {memberName(previous.professionalUserId)}
            </p>
            {previous.reason ? <p>Motivo: {previous.reason}</p> : null}
            {previous.diagnosisCodes && previous.diagnosisCodes.length > 0 ? (
              <p>Diagnóstico: {previous.diagnosisCodes.join(", ")}</p>
            ) : null}
            {previous.evolution ? <p className="text-muted-foreground">{previous.evolution}</p> : null}
          </div>
        )}
      </section>
    </div>
  )
}
