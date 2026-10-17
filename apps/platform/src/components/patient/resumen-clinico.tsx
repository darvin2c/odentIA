import { diagnosisCodeLabel } from "@odentia/clinical"
import { Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { AgendaAppointment } from "../../lib/agenda"
import { useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { appointmentWhen } from "../../lib/patient-appointments"
import {
  ALLERGY_SEVERITY_LABELS,
  type OpenEncounterBrief,
  type PatientHealth,
  type PatientSummary,
} from "../../lib/patients"
import { SummaryCard } from "./resumen-tab"

/** Lo que le falta a la atención, dicho para quien no necesariamente la lleva. */
const MISSING_LABELS: Record<OpenEncounterBrief["missing"][number], string> = {
  reason: "motivo",
  diagnosis: "diagnóstico",
  evolution: "evolución",
  signature: "colegiatura de quien atiende",
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit" })
  return sameDay
    ? `hoy ${time}`
    : `${date.toLocaleDateString(activeOrgLocale(), { day: "2-digit", month: "short" })} ${time}`
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Atención en curso: lo primero que ve quien abre la ficha. Dice qué lleva,
 * qué le falta para cerrarse y lleva a continuarla (o a leerla si la atiende
 * otro profesional).
 */
export function OpenEncounterCard({
  patientId,
  encounter,
}: {
  patientId: string
  encounter: OpenEncounterBrief
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const myUserId = useMyUserId()
  const memberName = useMemberName()
  const mine = encounter.dentistUserId === myUserId
  const missing = encounter.missing.map((key) => MISSING_LABELS[key])
  return (
    <section
      aria-labelledby="open-encounter-title"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="open-encounter-title" className="font-heading text-base font-medium">
          Atención en curso
          <span className="font-normal text-muted-foreground">
            {" "}
            · {formatClock(encounter.startedAt)}
            {mine ? "" : ` · atiende ${memberName(encounter.dentistUserId)}`}
          </span>
        </h2>
        <p className="text-sm">
          <span className="text-muted-foreground">Motivo:</span>{" "}
          {encounter.reason ?? "sin registrar"}
        </p>
        <p className="text-sm text-muted-foreground">
          {plural(encounter.diagnosisCount, "diagnóstico", "diagnósticos")} ·{" "}
          {plural(encounter.procedureCount, "procedimiento", "procedimientos")}
          {missing.length > 0 ? ` · falta ${missing.join(", ")}` : " · lista para cerrar"}
        </p>
      </div>
      <Link
        to="/patients/$patientId/encounters/$encounterId"
        params={{ patientId, encounterId: encounter.id }}
        className={buttonVariants()}
      >
        {canWrite && mine ? "Continuar" : "Ver atención"}
      </Link>
    </section>
  )
}

function Alert({
  tone,
  title,
  detail,
}: {
  tone: "danger" | "warning" | "muted"
  title: string
  detail?: string | null
}) {
  const toneClass =
    tone === "danger"
      ? "border-destructive/40 bg-destructive/5"
      : tone === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-dashed"
  return (
    <li className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
    </li>
  )
}

/**
 * Alergias y alertas antes de tocar al paciente (Resumen de quien atiende):
 * alergias por gravedad, con la declarada «por confirmar», condiciones
 * activas y medicación vigente. Sin alergias registradas dice lo que consta
 * («no preguntado» o «niega»), nunca «ninguna»: no es lo mismo.
 */
export function ClinicalAlertsCard({
  health,
  onAntecedentes,
}: {
  health: PatientHealth | null
  onAntecedentes: () => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const allergies = (health?.allergies ?? []).filter(
    (allergy) => allergy.isActive && allergy.verification !== "descartada",
  )
  const conditions = (health?.conditions ?? []).filter((condition) => condition.status === "activa")
  // Vigente = sin fecha de fin, igual que la cabecera de la ficha.
  const medications = (health?.medications ?? []).filter((medication) => !medication.endDate)
  const allergyState = health?.reviewStatus.allergies ?? "unknown"
  const severe = (severity: string) => severity === "severa" || severity === "grave"
  return (
    <SummaryCard
      title="Alergias y alertas"
      action={
        <Button type="button" size="sm" variant="outline" onClick={onAntecedentes}>
          Antecedentes
        </Button>
      }
    >
      <ul className="flex flex-col gap-2">
        {allergies.map((allergy) => (
          <Alert
            key={allergy.id}
            tone={severe(allergy.severity) ? "danger" : "warning"}
            title={`${allergy.kind === "intolerancia" ? "Intolerancia" : "Alergia"}${
              severe(allergy.severity)
                ? ` ${(ALLERGY_SEVERITY_LABELS[allergy.severity] ?? allergy.severity).toLowerCase()}`
                : ""
            } · ${allergy.substance}`}
            detail={[
              allergy.reaction ?? "reacción no descrita",
              allergy.verification === "no_confirmada" ? "declarada · por confirmar" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
        {allergies.length === 0 ? (
          <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2">
            <span className="text-sm font-medium">
              {allergyState === "none" ? "Alergias: niega" : "Alergias: no preguntado"}
            </span>
            {allergyState === "unknown" && canWrite ? (
              <Button type="button" size="sm" variant="outline" onClick={onAntecedentes}>
                Registrar antecedentes
              </Button>
            ) : null}
          </li>
        ) : null}
        {conditions.map((condition) => (
          <Alert
            key={condition.id}
            tone="warning"
            title={condition.name}
            detail={condition.diagnosisCode ? diagnosisCodeLabel(condition.diagnosisSystem, condition.diagnosisCode) : "Antecedente activo"}
          />
        ))}
        {medications.length > 0 ? (
          <Alert
            tone="muted"
            title={plural(medications.length, "medicamento vigente", "medicamentos vigentes")}
            detail={medications.map((medication) => medication.name).join(", ")}
          />
        ) : null}
      </ul>
    </SummaryCard>
  )
}

/** «8 oct», en la zona de la clínica. */
function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    timeZone: activeOrgTimeZone(),
  })
}

/**
 * La última atención cerrada: cuándo, por qué, quién y qué encontró (los
 * diagnósticos y las piezas), con «Ver» para abrirla. Sin atenciones, el
 * vacío lleva su acción.
 */
export function LastVisitCard({
  patientId,
  summary,
  attend,
}: {
  patientId: string
  summary: PatientSummary
  /** «Atender», el mismo botón de la cabecera. */
  attend: ReactNode
}): React.JSX.Element {
  const memberName = useMemberName()
  const visit = summary.lastVisit
  const dentist = summary.lastEncounter?.dentistUserId
  return (
    <SummaryCard
      title="Última atención"
      action={
        visit ? (
          <Link
            to="/patients/$patientId/encounters/$encounterId"
            params={{ patientId, encounterId: visit.encounterId }}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Ver
          </Link>
        ) : undefined
      }
    >
      {visit ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {[visit.finalizedAt ? dayOf(visit.finalizedAt) : null, visit.reason || "Atención"]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="text-muted-foreground">
            {[
              dentist ? memberName(dentist) : null,
              visit.diagnoses.length > 0 ? visit.diagnoses.join(", ") : null,
              visit.teeth.length > 0
                ? `${visit.teeth.length === 1 ? "pieza" : "piezas"} ${visit.teeth.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Sin diagnósticos registrados"}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Todavía no tiene atenciones</p>
          {attend}
        </div>
      )}
    </SummaryCard>
  )
}

/**
 * La próxima cita con el teléfono para avisarle: lo mismo que recepción ve en
 * su Resumen. Sin cita por venir, «Reservar cita».
 */
export function UpcomingCard({
  patientId,
  upcoming,
  loading,
  failed,
  phone,
}: {
  patientId: string
  upcoming: AgendaAppointment | null
  loading: boolean
  failed: boolean
  /** «Teléfono +51 987 654 305 · WhatsApp», ya dicho. */
  phone: string
}): React.JSX.Element {
  const canBook = usePermission("appointments.write")
  return (
    <SummaryCard title="Próxima cita">
      <div className="flex flex-col gap-1 text-sm">
        {loading ? (
          <p className="text-muted-foreground">Consultando…</p>
        ) : failed ? (
          <p className="text-muted-foreground">No disponible</p>
        ) : upcoming ? (
          <p className="font-medium">
            {[appointmentWhen(upcoming), upcoming.serviceName ?? upcoming.reason, upcoming.dentistName]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">Sin cita por venir</p>
            {canBook ? (
              <Link
                to="/agenda"
                search={{ patientId }}
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                Reservar cita
              </Link>
            ) : null}
          </div>
        )}
        <p className="text-muted-foreground">{phone}</p>
      </div>
    </SummaryCard>
  )
}
