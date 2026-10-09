import { label } from "../../lib/glossary"
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MoreHorizontal } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchPatientAccount, fetchResponsibilities } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  appointmentWhen,
  nextAppointment,
  usePatientAppointments,
} from "../../lib/patient-appointments"
import type { PatientSectionId } from "../../lib/patient-areas"
import { ageFrom, hcLabel, type PatientFull, type PatientSummary } from "../../lib/patients"
import { formatMoney } from "../../lib/services"
import { FiliacionSectionDrawer } from "./filiacion-section-drawer"
import { NewEncounterButton } from "./new-encounter-button"
import { PatientAvatar } from "./patient-avatar"

const dateLabel = (value: string) =>
  new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" })

function pendingLine(summary: PatientSummary): string {
  const accepted = summary.planPending.count
  const proposed = summary.proposedBudgets.length
  const parts = [`${accepted} tratamiento(s) aceptado(s) por ejecutar`]
  if (proposed > 0) parts.push("Presupuestos por revisar")
  const totals = summary.planPending.totals
    .map((total) => `${formatMoney(total.totalCents, total.currency)}`)
    .join(" · ")
  // Lo acordado por ejecutar no es deuda: el saldo real vive en la pestaña Cuenta.
  if (totals) parts.push(`acordado por ejecutar: ${totals} (no es saldo pendiente)`)
  if (summary.planPending.unpricedCount)
    parts.push(`${summary.planPending.unpricedCount} sin tarifa (no incluidos)`)
  return parts.join(" · ")
}

/** Alertas prioritarias: primero alergias severas, luego el resto. Siempre visibles, nunca tras un desplegable. */
export function clinicalAlerts(
  detail: PatientFull,
): Array<{ id: string; label: string; tone: "destructive" | "warning" | "secondary" }> {
  // Criticidad alta (riesgo de reacción grave) o gravedad severa encabezan;
  // una alergia descartada ya no alerta.
  const allergies = detail.activeAllergies.filter((a) => a.verification !== "descartada")
  const critical = (a: (typeof allergies)[number]) =>
    a.severity === "severa" || a.criticality === "alta"
  const severe = allergies.filter(critical).map((a) => ({
    id: a.id,
    label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"} ${a.severity === "severa" ? "severa" : "de criticidad alta"}: ${a.substance}`,
    tone: "destructive" as const,
  }))
  const other = allergies
    .filter((a) => !critical(a))
    .map((a) => ({
      id: a.id,
      label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"}: ${a.substance} (${label("alergia", a.severity).toLowerCase()})`,
      tone: "secondary" as const,
    }))
  const conditions = detail.activeConditions.map((c) => ({
    id: c.id,
    label: c.name,
    tone: "warning" as const,
  }))
  return [...severe, ...other, ...conditions]
}

/** Franja clínica reutilizable (cabecera y editor de atención): alertas + medicación, sin botones. */
export function PatientClinicalStrip({
  detail,
  onAntecedentes,
}: {
  detail: PatientFull
  onAntecedentes?: () => void
}) {
  const alerts = clinicalAlerts(detail)
  const shown = alerts.slice(0, 4)
  const hidden = alerts.length - shown.length
  const meds = detail.currentMedications
  if (alerts.length === 0 && meds.length === 0) return null
  const more = hidden > 0 || meds.length > 0
  const moreLabel =
    hidden > 0 && meds.length > 0
      ? `+${hidden} alertas · ${meds.length} medicamentos vigentes`
      : hidden > 0
        ? `+${hidden} alertas`
        : `${meds.length} medicamento${meds.length === 1 ? "" : "s"} vigente${meds.length === 1 ? "" : "s"}`
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Alertas clínicas">
      {shown.map((alert) => (
        <Badge
          key={alert.id}
          variant={
            alert.tone === "destructive"
              ? "destructive"
              : alert.tone === "warning"
                ? "outline"
                : "secondary"
          }
          className={
            alert.tone === "warning" ? "border-warning/30 bg-warning-soft text-warning" : undefined
          }
        >
          {alert.label}
        </Badge>
      ))}
      {more && onAntecedentes ? (
        <Button type="button" size="sm" variant="outline" onClick={onAntecedentes}>
          {moreLabel} · ver antecedentes
        </Button>
      ) : more ? (
        <Badge variant="outline">{moreLabel}</Badge>
      ) : null}
    </div>
  )
}

/**
 * Cabecera persistente de la ficha: identidad, quién decide por el paciente,
 * alertas de seguridad, estado operativo y la acción principal del rol.
 */
export function PatientHeader({
  detail,
  summary,
  onAntecedentes,
  onSection,
}: {
  detail: PatientFull
  summary?: PatientSummary
  onAntecedentes?: () => void
  onSection: (section: PatientSectionId) => void
}) {
  const canWrite = usePermission("patients.write")
  const canRead = usePermission("patients.read")
  const canEncounter = usePermission("clinical.write")
  const canAppointments = usePermission("appointments.read")
  const canBook = usePermission("appointments.write")
  const canFinance = usePermission("finance.read")
  const canCharge = usePermission("finance.write")
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const patient = detail.patient
  const archiveMutation = useMutation({
    mutationFn: (nextActive: boolean) =>
      apiFetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: nextActive }),
      }),
    onSuccess: () => {
      setArchiveError(null)
      setArchiveOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["patient", patient.id] })
      void queryClient.invalidateQueries({ queryKey: ["patients"] })
    },
    onError: (mutationError: unknown) => {
      setArchiveError(
        mutationError instanceof ApiError
          ? (mutationError.shape.message ?? "No se pudo actualizar el estado.")
          : "No se pudo actualizar el estado.",
      )
    },
  })
  const responsibilities = useQuery({
    queryKey: ["responsibilities", patient.id],
    queryFn: () => fetchResponsibilities(patient.id),
    enabled: canRead,
  })
  const appointments = usePatientAppointments(patient.id, canAppointments)
  const account = useQuery({
    queryKey: ["patient-account", patient.id],
    queryFn: () => fetchPatientAccount(patient.id),
    enabled: canFinance,
  })
  const age = ageFrom(patient.birthDate)
  const isMinor = age !== "" && Number(age) < 18
  const representatives = (responsibilities.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const upcoming = appointments.data ? nextAppointment(appointments.data.data) : null
  const outstanding = (account.data?.data.byCurrency ?? []).filter(
    (balance) => balance.outstandingCents > 0,
  )
  // Una acción principal: la del trabajo propio del rol. Las demás, secundarias.
  const primary = canEncounter ? "encounter" : canBook ? "book" : canCharge ? "charge" : null
  const docLabel =
    patient.docType && patient.docNumber
      ? `${patient.docType} ${patient.docNumber}`
      : (patient.docNumber ?? null)
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/patients" />}>Pacientes</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.patient.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <PatientAvatar
              patientId={patient.id}
              name={detail.patient.displayName}
              storageKey={patient.avatarStorageKey}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">
                  {detail.patient.displayName}
                </h1>
                <Badge>{hcLabel(patient.patientNumber)}</Badge>
                {isMinor ? <Badge variant="warning">Menor de edad</Badge> : null}
                {!patient.isActive ? <Badge variant="outline">Archivado</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {[
                  docLabel,
                  age ? `${age} años` : null,
                  patient.sex === "M" ? "Masculino" : patient.sex === "F" ? "Femenino" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Sin filiación registrada"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canBook ? (
              <Button
                variant={primary === "book" ? "default" : "outline"}
                nativeButton={false}
                render={<Link to="/agenda" search={{ patientId: patient.id }} />}
              >
                Agendar cita
              </Button>
            ) : null}
            {primary === "charge" ? (
              <Button onClick={() => onSection("cuenta")}>Registrar pago</Button>
            ) : null}
            <NewEncounterButton
              patientId={patient.id}
              detail={detail}
              openEncounterId={summary?.openEncounterId}
            />
            {canWrite ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon" aria-label="Más acciones" />}
                >
                  <MoreHorizontal aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      setEditing(true)
                    }}
                  >
                    Editar datos personales
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      setArchiveError(null)
                      setArchiveOpen(true)
                    }}
                  >
                    {patient.isActive ? "Archivar paciente" : "Reactivar paciente"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {isMinor || representatives.length > 0 ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm">
            {representatives.length > 0 ? (
              <>
                <span className="font-medium">Representante legal:</span>{" "}
                {representatives.map((row) => row.contact.displayName).join(", ")}. Decide
                presupuestos y firma consentimientos por el paciente.
              </>
            ) : responsibilities.isSuccess ? (
              <>
                <span className="font-medium">Sin representante legal registrado.</span> Un menor no
                decide presupuestos ni firma consentimientos por sí mismo.{" "}
                <button
                  type="button"
                  className="font-medium underline underline-offset-4"
                  onClick={() => onSection("responsables")}
                >
                  Registrar responsable
                </button>
              </>
            ) : responsibilities.isError ? (
              "No se pudo consultar quién representa al paciente."
            ) : (
              "Consultando responsables…"
            )}
          </p>
        ) : null}
        <PatientClinicalStrip detail={detail} onAntecedentes={onAntecedentes} />
        <dl className="flex flex-wrap gap-x-8 gap-y-2 border-t pt-4 text-sm">
          {canAppointments ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Próxima cita</dt>
              <dd className="font-medium">
                {appointments.isPending
                  ? "Consultando…"
                  : appointments.isError
                    ? "No disponible"
                    : upcoming
                      ? `${appointmentWhen(upcoming)} · ${upcoming.dentistName}`
                      : "Sin cita reservada"}
              </dd>
            </div>
          ) : null}
          {summary ? (
            <>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Última atención</dt>
                <dd className="font-medium">
                  {summary.lastEncounter
                    ? dateLabel(
                        summary.lastEncounter.finalizedAt ?? summary.lastEncounter.createdAt,
                      )
                    : "Sin atenciones"}
                </dd>
              </div>
              {summary.nextAppointmentAt ? (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Revisión sugerida en la última atención</dt>
                  <dd className="font-medium">{dateLabel(summary.nextAppointmentAt)}</dd>
                </div>
              ) : null}
            </>
          ) : null}
          {canFinance && account.isSuccess ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Saldo por cobrar</dt>
              <dd className="font-medium tabular-nums">
                {outstanding.length === 0
                  ? "Sin saldo"
                  : outstanding
                      .map((balance) => formatMoney(balance.outstandingCents, balance.currency))
                      .join(" · ")}
              </dd>
            </div>
          ) : null}
        </dl>
        {summary ? (
          <p className="text-sm text-muted-foreground">Trabajo pendiente: {pendingLine(summary)}</p>
        ) : null}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => {
          if (!archiveMutation.isPending) {
            setArchiveOpen(false)
            setArchiveError(null)
          }
        }}
        title={patient.isActive ? "Archivar paciente" : "Reactivar paciente"}
        description={
          archiveError ??
          (patient.isActive
            ? "La ficha se archiva pero conserva su historia clínica y relaciones. No se borra."
            : "La ficha vuelve a estar activa en el padrón.")
        }
        confirmLabel={patient.isActive ? "Archivar" : "Reactivar"}
        pending={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate(!patient.isActive)}
      />
      {editing ? (
        <FiliacionSectionDrawer
          patient={patient}
          section="identidad"
          open
          onClose={() => setEditing(false)}
        />
      ) : null}
    </header>
  )
}
