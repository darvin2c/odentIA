import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useCanWrite } from "../../lib/crm"
import { ageFrom, hcLabel, type PatientFull, type PatientSummary } from "../../lib/patients"
import { formatMoney } from "../../lib/services"
import { FiliacionDrawer } from "./filiacion-drawer"
import { NewEncounterButton } from "./new-encounter-button"
import { PatientAvatar } from "./patient-avatar"

const dateLabel = (value: string) =>
  new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" })

function pendingLine(summary: PatientSummary): string {
  const accepted = summary.planPending.count
  const proposed = summary.proposedBudgets.length
  const parts = [`${accepted} aceptado(s) pendiente(s)`]
  if (proposed > 0) parts.push("Presupuestos por revisar")
  const totals = summary.planPending.totals
    .map((total) => `${formatMoney(total.totalCents, total.currency)}`)
    .join(" · ")
  if (totals) parts.push(`montos pendientes: ${totals}`)
  if (summary.planPending.unpricedCount)
    parts.push(`${summary.planPending.unpricedCount} sin tarifa (no incluidos)`)
  return parts.join(" · ")
}

/** Alertas prioritarias: primero alergias severas, luego el resto. Siempre visibles, nunca tras un desplegable. */
export function clinicalAlerts(
  detail: PatientFull,
): Array<{ id: string; label: string; tone: "destructive" | "warning" | "secondary" }> {
  const severe = detail.activeAllergies
    .filter((a) => a.severity === "severa")
    .map((a) => ({
      id: a.id,
      label: `Alergia severa: ${a.substance}`,
      tone: "destructive" as const,
    }))
  const other = detail.activeAllergies
    .filter((a) => a.severity !== "severa")
    .map((a) => ({
      id: a.id,
      label: `Alergia: ${a.substance} (${a.severity})`,
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
                ? "warning"
                : "secondary"
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

export function PatientHeader({
  detail,
  summary,
  onAntecedentes,
}: {
  detail: PatientFull
  summary?: PatientSummary
  onAntecedentes?: () => void
}) {
  const canWrite = useCanWrite()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const patient = detail.patient
  const age = ageFrom(patient.birthDate)
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
            <BreadcrumbPage>{detail.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Card>
        <CardContent className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <PatientAvatar
              patientId={patient.id}
              name={detail.displayName}
              storageKey={patient.avatarStorageKey}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">
                  {detail.displayName}
                </h1>
                <Badge>{hcLabel(patient.patientNumber)}</Badge>
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
            {canWrite ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  Datos personales
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      setMenuOpen(false)
                      setEditing(true)
                    }}
                  >
                    Editar datos personales
                  </DropdownMenuItem>
                  {onAntecedentes ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        onAntecedentes()
                      }}
                    >
                      Revisar antecedentes
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <NewEncounterButton patientId={patient.id} openEncounterId={summary?.openEncounterId} />
          </div>
        </CardContent>
      </Card>
      <PatientClinicalStrip detail={detail} onAntecedentes={onAntecedentes} />
      <p className="text-sm text-muted-foreground">
        Última atención:{" "}
        {summary
          ? summary.lastEncounter
            ? dateLabel(summary.lastEncounter.finalizedAt ?? summary.lastEncounter.createdAt)
            : "Sin atenciones"
          : "Cargando…"}
        {" · "}
        Próxima revisión sugerida:{" "}
        {summary
          ? summary.nextAppointmentAt
            ? dateLabel(summary.nextAppointmentAt)
            : "No indicada"
          : "Cargando…"}
        {summary ? ` · Trabajo pendiente: ${pendingLine(summary)}` : ""}
      </p>
      <FiliacionDrawer
        patientId={patient.id}
        detail={detail}
        open={editing}
        onOpenChange={setEditing}
      />
    </header>
  )
}
