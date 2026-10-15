import { documentText } from "@odentia/clinical"
import {
  Avatar,
  AvatarFallback,
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { ConfirmDialog, useHeaderUtilities } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageCircle, MoreHorizontal } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { label } from "../../lib/glossary"
import type { PatientSectionId } from "../../lib/patient-areas"
import { sexLabel } from "../../lib/patient-overview"
import { ageFrom, hcLabel, type PatientFull, type PatientSummary } from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonPage, RELATIONSHIP_WORDS } from "../../lib/people"
import { WriteToPersonDialog } from "../write-to-person"
import { FiliacionSectionDrawer } from "./filiacion-section-drawer"
import { NewEncounterButton } from "./new-encounter-button"
import { PatientAvatar } from "./patient-avatar"

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

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
}

function relationshipText(relationship: string, detail: string | null): string {
  return detail?.trim() || RELATIONSHIP_WORDS[relationship] || relationship
}

/**
 * Cabecera de la página de la persona (ADR 0029): quién es, qué es para la
 * clínica, quién habla por ella o de quién es responsable, las alergias que
 * alertan y la acción principal del rol. Es la misma antes y después de
 * registrarla: el número de historia aparece al registrarla.
 */
export function PersonHeader({
  person,
  detail,
  summary,
  onSection,
}: {
  person: PersonPage
  /** Ficha administrativa del paciente, si lo es (alergias, foto, edad). */
  detail?: PatientFull
  /** Resumen clínico ya cargado por la pestaña Clínica (no se pide aquí). */
  summary?: PatientSummary
  onSection: (section: PatientSectionId) => void
}) {
  // La página no usa PageHeader; las utilidades globales (avisos, agente) van aquí.
  const utilities = useHeaderUtilities()
  const queryClient = useQueryClient()
  const canRead = usePermission("patients.read")
  const canEditPatient = usePermission("patients.write")
  const canEditPerson = usePermission("crm.write")
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
  const canBook = usePermission("appointments.write")
  const canCrm = usePermission("crm.read")
  const canCharge = usePermission("finance.write")
  const canEncounter = usePermission("clinical.write")
  const patient = person.patient
  // Cambiar a la persona: con ficha, quien edita la filiación; sin ella, también quien lleva el CRM.
  const canEdit = patient ? canEditPatient : canEditPatient || canEditPerson
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [writeOpen, setWriteOpen] = useState(false)
  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) =>
      apiFetch(`/api/people/${person.id}/archived`, {
        method: "PUT",
        body: JSON.stringify({ archived }),
      }),
    onSuccess: () => {
      setArchiveError(null)
      setArchiveOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["person", person.id] })
      void queryClient.invalidateQueries({ queryKey: ["people"] })
      if (patient) void queryClient.invalidateQueries({ queryKey: ["patient", patient.id] })
    },
    onError: (mutationError: unknown) => {
      setArchiveError(
        mutationError instanceof ApiError
          ? (mutationError.shape.message ?? "No se pudo actualizar.")
          : "No se pudo actualizar.",
      )
    },
  })
  const responsibilities = useQuery({
    queryKey: ["responsibilities", patient?.id ?? "none"],
    queryFn: () => fetchResponsibilities(patient?.id ?? ""),
    enabled: canRead && Boolean(patient),
  })
  const age = ageFrom(person.birthDate)
  const isMinor = age !== "" && Number(age) < 18
  const representatives = (responsibilities.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const primary = patient
    ? canEncounter
      ? "encounter"
      : canBook
        ? "book"
        : canCharge
          ? "charge"
          : null
    : canMessage
      ? "write"
      : null
  const docLabel = person.docNumber ? documentText(person.docType, person.docNumber) : null
  const facts = [
    patient ? hcLabel(patient.patientNumber) : null,
    docLabel,
    age ? `${age} años` : null,
    person.sex ? sexLabel(person.sex) : null,
  ].filter(Boolean)
  // Reservar para quien aún no es paciente crea su ficha mínima unida a la persona:
  // la Agenda la lee en el CRM.
  const bookSearch = patient ? { patientId: patient.id } : canCrm ? { contactId: person.id } : null
  const writeTargets = [
    {
      contactId: person.id,
      displayName: person.displayName,
      detail: person.spokenForBy.length > 0 ? "La propia persona" : undefined,
    },
    ...person.spokenForBy.map((other) => ({
      contactId: other.personId,
      displayName: other.displayName,
      detail: relationshipText(other.relationship, other.relationshipDetail),
      isPreferred: other.isPreferred,
    })),
  ]
  const archivedWord = person.archived ? "Archivada" : null
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/people" />}>Pacientes</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{person.displayName}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {utilities ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">{utilities}</div>
        ) : null}
      </div>
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            {patient ? (
              <PatientAvatar
                patientId={patient.id}
                name={person.displayName}
                storageKey={patient.avatarStorageKey}
              />
            ) : (
              <Avatar style={{ width: 80, height: 80 }}>
                <AvatarFallback>{initials(person.displayName)}</AvatarFallback>
              </Avatar>
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">
                  {person.displayName}
                </h1>
                <Badge variant={person.kind === "por_registrar" ? "warning" : "secondary"}>
                  {PERSON_KIND_LABELS[person.kind]}
                </Badge>
                {patient && isMinor ? <Badge variant="warning">Menor de edad</Badge> : null}
                {archivedWord ? <Badge variant="outline">{archivedWord}</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {[
                  ...facts,
                  !patient && person.responsibleFor.length > 0
                    ? `Responsable de ${person.responsibleFor.length === 1 ? "1 paciente" : `${person.responsibleFor.length} pacientes`}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Sin datos personales todavía"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canMessage && !person.archived ? (
              <Button
                type="button"
                variant={primary === "write" ? "default" : "outline"}
                onClick={() => setWriteOpen(true)}
              >
                <MessageCircle aria-hidden className="size-4" />
                Escribirle
              </Button>
            ) : null}
            {canBook && bookSearch && !person.archived ? (
              <Link
                to="/agenda"
                search={bookSearch}
                className={buttonVariants({ variant: primary === "book" ? "default" : "outline" })}
              >
                Reservar cita
              </Link>
            ) : null}
            {primary === "charge" ? (
              <Button onClick={() => onSection("cuenta")}>Cobrar</Button>
            ) : null}
            {patient && !person.archived ? (
              <NewEncounterButton
                patientId={patient.id}
                openEncounterId={summary?.openEncounterId}
              />
            ) : null}
            {canEdit ? (
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
                    {person.archived ? "Recuperar" : "Archivar"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {patient && person.spokenForBy.length > 0 ? (
          <p className="text-sm">
            <span className="font-medium">Habla por ella: </span>
            {person.spokenForBy.map((other, index) => (
              <span key={other.personId}>
                {index > 0 ? ", " : ""}
                <Link
                  to="/people/$personId"
                  params={{ personId: other.personId }}
                  className="font-medium text-primary hover:underline"
                >
                  {other.displayName}
                </Link>
                <span className="text-muted-foreground">
                  {" "}
                  · {relationshipText(other.relationship, other.relationshipDetail)}
                </span>
                {canReadChats && other.conversationId ? (
                  <>
                    {" · "}
                    <Link
                      to="/inbox"
                      search={{ conversation: other.conversationId }}
                      className="text-primary hover:underline"
                    >
                      Ver su conversación
                    </Link>
                  </>
                ) : null}
              </span>
            ))}
          </p>
        ) : null}
        {patient && (isMinor || representatives.length > 0) ? (
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
        {detail ? <PatientClinicalStrip detail={detail} /> : null}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => {
          if (!archiveMutation.isPending) {
            setArchiveOpen(false)
            setArchiveError(null)
          }
        }}
        title={
          person.archived ? `Recuperar a ${person.displayName}` : `Archivar a ${person.displayName}`
        }
        description={
          archiveError ??
          (person.archived
            ? "Vuelve entera: su página, su ficha y sus conversaciones quedan como estaban. Los enlaces de registro que se anularon al archivar no vuelven."
            : "Se archiva entera: su ficha y sus conversaciones se conservan, pero deja de aparecer en las listas y no admite conversaciones, vínculos ni enlaces de registro nuevos. Se recupera desde esta misma página.")
        }
        confirmLabel={person.archived ? "Recuperar" : "Archivar"}
        variant={person.archived ? "default" : "destructive"}
        pending={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate(!person.archived)}
      />
      {editing ? (
        detail ? (
          <FiliacionSectionDrawer
            patient={detail.patient}
            section="identidad"
            open
            onClose={() => setEditing(false)}
          />
        ) : !patient ? (
          <FiliacionSectionDrawer
            person={person}
            section="identidad"
            open
            onClose={() => setEditing(false)}
          />
        ) : null
      ) : null}
      <WriteToPersonDialog
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        people={writeTargets}
      />
    </header>
  )
}
