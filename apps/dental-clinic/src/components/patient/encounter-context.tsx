import { diagnosisCodeLabel } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type FormFieldDef,
  type FormResponse,
  fetchFormResponses,
  finalizeFormResponse,
} from "../../lib/clinical-forms"
import { formatDate, formatDateTime } from "../../lib/clinical-journey"
import { useMemberName, usePermission } from "../../lib/crm"
import { allergyTitle } from "../../lib/allergies"
import { type Encounter, fetchPatientHealth, type PatientFull } from "../../lib/patients"
import { AllergyReviewNotice } from "./allergies-card"

/** Respuesta en palabras: «Sí», la lista unida o el texto tal cual. */
function answerText(value: unknown): string {
  if (value === true) return "Sí"
  if (value === false) return "No"
  if (Array.isArray(value)) return value.map(String).join(", ")
  if (value === null || value === undefined || value === "") return "—"
  return String(value)
}

/**
 * Lo que respondió antes de venir sale arriba al abrir la atención: el
 * cuestionario del portal enviado y sin revisar, con «Pasar a Antecedentes».
 * Pasarlo es finalizarlo: lo declarado entra como «declarado», sin pisar lo ya
 * confirmado (`addDeclaredAllergies` en el servidor), y la receta ya avisa.
 */
export function DeclaredQuestionnaireNotice({
  patientId,
  patient,
  disabled,
}: {
  patientId: string
  patient: PatientFull
  disabled: boolean
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const responses = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
  })
  const declared: FormResponse[] = (responses.data?.data ?? []).filter(
    (row) => row.source === "portal" && row.status === "borrador" && row.submittedAt,
  )
  const pass = useMutation({
    mutationFn: (id: string) => finalizeFormResponse(id),
    onSuccess: async () => {
      toast.success("Pasó a Antecedentes como declarado")
      await Promise.all(
        [["form-responses", patientId], ["patient-health", patientId], ["patient", patientId]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      )
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? (e.shape.message ?? "No se pudo pasar a Antecedentes") : "No se pudo pasar a Antecedentes"),
  })
  if (declared.length === 0) return null
  const first = (patient.patient.givenNames ?? patient.patient.displayName).trim().split(/\s+/)[0]
  return (
    <div className="flex flex-col gap-3">
      {declared.map((response) => {
        const fields: FormFieldDef[] = (response.templateSnapshot?.sections ?? []).flatMap((s) => s.fields)
        const shown = fields
          .filter((field) => field.type !== "firma" && field.type !== "adjunto")
          .filter((field) => response.answers[field.id] !== undefined && response.answers[field.id] !== "")
          .slice(0, 6)
        return (
          <section
            key={response.id}
            aria-label="Lo que respondió antes de venir"
            className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {first} respondió «{response.templateTitle ?? "Antes de tu cita"}»
                </span>
                <span className="text-xs text-muted-foreground">
                  {response.submittedAt ? formatDateTime(response.submittedAt) : ""} · desde su enlace
                </span>
              </div>
              {canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || pass.isPending}
                  onClick={() => pass.mutate(response.id)}
                >
                  {pass.isPending ? "Pasando…" : "Pasar a Antecedentes"}
                </Button>
              ) : null}
            </div>
            {shown.length > 0 ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {shown.map((field) => (
                  <div key={field.id} className="contents">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd>{answerText(response.answers[field.id])}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Las alergias que escribió pasan a su lista y avisan al recetar; lo ya registrado no cambia.
            </p>
          </section>
        )
      })}
    </div>
  )
}

/**
 * Sus alergias, al abrir la atención (tablero 7): si nunca se revisaron o pasaron
 * 6 meses, pide preguntarle por alergias nuevas con «Sin cambios» y «Agregar
 * alergia». Solo para quien lleva la atención.
 */
export function EncounterAllergyReview({
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
    <AllergyReviewNotice
      patientId={patientId}
      patientName={patient.patient.displayName}
      health={health.data.data}
      disabled={disabled}
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
}: {
  patientId: string
  encounterId: string
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
  return (
    <div className="flex flex-col gap-5 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Alergias</h3>
        {allergies.length === 0 ? (
          <p className="text-muted-foreground">Sin alergias registradas.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {allergies.map((allergy) => (
              <li key={allergy.id}>
                <strong>{allergyTitle(allergy)}</strong>
                {allergy.reaction ? ` · ${allergy.reaction}` : ""}
                {allergy.source === "paciente" ? " · la declaró el paciente" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Enfermedades</h3>
        {conditions.length === 0 ? (
          <p className="text-muted-foreground">Sin enfermedades registradas.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conditions.map((condition) => (
              <li key={condition.id}>
                {condition.name}
                {condition.diagnosisCode ? ` · ${diagnosisCodeLabel(condition.diagnosisSystem, condition.diagnosisCode)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Medicación</h3>
        {data.medications.length === 0 ? (
          <p className="text-muted-foreground">Sin medicación registrada.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.medications.map((medication) => (
              <li key={medication.id}>
                {medication.name}
                {medication.dose ? ` · ${medication.dose}` : ""}
                {medication.frequency ? ` · ${medication.frequency}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Última atención</h3>
        {last.isPending ? (
          <p className="text-muted-foreground">Cargando…</p>
        ) : !previous ? (
          <p className="text-muted-foreground">Es su primera atención cerrada.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p>
              {formatDate(previous.startedAt)} · {memberName(previous.dentistUserId)}
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
