import { documentText } from "@odentia/clinical"
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SidebarTrigger,
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import {
  ConfirmDialog,
  HeaderCompactProvider,
  MOBILE_NAV_TRIGGER_CLASS,
  PageHeaderMenu,
  PersonAvatar,
  submitErrorMessage,
  useHeaderUtilities,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageCircle, MoreHorizontal } from "lucide-react"
import { useState } from "react"
import { allergyName } from "../../lib/allergies"
import { apiFetch } from "../../lib/api"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { useCan, usePermission } from "../../lib/crm"
import { personHeaderRules } from "../../lib/screen-rules"
import { label } from "../../lib/glossary"
import type { PatientSectionId } from "../../lib/patient-areas"
import { sexLabel } from "../../lib/patient-overview"
import { ageFrom, hcLabel, type PatientFull, type PatientSummary } from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonPage, relationshipText } from "../../lib/people"
import type { BookingSeed } from "../agenda/booking-drawer"
import { openBookingAnywhere } from "../agenda/schedule-host"
import { PersonLink } from "../person-link"
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
    label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"} ${a.severity === "severa" ? "severa" : "de criticidad alta"}: ${allergyName(a)}`,
    tone: "destructive" as const,
  }))
  const other = allergies
    .filter((a) => !critical(a))
    .map((a) => ({
      id: a.id,
      label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"}: ${allergyName(a)}${a.severity === "desconocida" ? "" : ` (${label("alergia", a.severity).toLowerCase()})`}`,
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
          // Una alergia o enfermedad larga corta línea en vez de ensanchar la página en el teléfono.
          className={cn(
            "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
            alert.tone === "warning" && "border-warning/30 bg-warning-soft text-warning",
          )}
        >
          {alert.label}
        </Badge>
      ))}
      {more && onAntecedentes ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-auto min-h-11 max-w-full shrink py-1 text-left whitespace-normal sm:min-h-8"
          onClick={onAntecedentes}
        >
          {moreLabel} · ver antecedentes
        </Button>
      ) : more ? (
        <Badge
          variant="outline"
          className="h-auto min-h-5 max-w-full py-px text-left whitespace-normal"
        >
          {moreLabel}
        </Badge>
      ) : null}
    </div>
  )
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
  // El disparador del menú lateral en el teléfono, como en el encabezado de página.
  const sidebar = useSidebarOptional()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const canRead = usePermission("patients.read")
  const can = useCan()
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
  const canCrm = usePermission("crm.read")
  const patient = person.patient
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
    onError: (mutationError: unknown) => setArchiveError(submitErrorMessage(mutationError)),
  })
  const responsibilities = useQuery({
    queryKey: ["responsibilities", patient?.id ?? "none"],
    queryFn: () => fetchResponsibilities(patient?.id ?? ""),
    enabled: canRead && Boolean(patient),
  })
  const age = ageFrom(person.birthDate)
  // Menor de edad según el servidor (el día de la clínica), no la hora de este equipo.
  const isMinor = person.isMinor
  const representatives = (responsibilities.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const { primary, book: canBook, edit: canEdit } = personHeaderRules(can, Boolean(patient))
  const docLabel = person.docNumber ? documentText(person.docType, person.docNumber) : null
  const facts = [
    patient ? hcLabel(patient.patientNumber) : null,
    docLabel,
    age ? `${age} años` : null,
    person.sex ? sexLabel(person.sex) : null,
  ].filter(Boolean)
  // «Nueva cita» al lado, sin ir a la Agenda. Para quien aún no es paciente crea
  // su ficha mínima unida a la persona.
  const bookSeed: BookingSeed | null = patient
    ? { patient: { id: patient.id, name: person.displayName }, lockedPatient: true }
    : canCrm
      ? { person: { contactId: person.id, name: person.displayName, phone: person.phone } }
      : null
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
        {sidebar ? <SidebarTrigger className={MOBILE_NAV_TRIGGER_CLASS} /> : null}
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
        {/* La miga de pan salta de línea en vez de recortarse: solo el teléfono compacta la fila. */}
        <HeaderCompactProvider value={isMobile}>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
            {utilities?.utilities}
            <PageHeaderMenu />
          </div>
        </HeaderCompactProvider>
      </div>
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            {patient ? (
              <PatientAvatar
                patientId={patient.id}
                name={person.displayName}
                givenNames={person.givenNames}
                familyName={person.familyName}
                storageKey={patient.avatarStorageKey}
              />
            ) : (
              <PersonAvatar
                name={person.displayName}
                givenNames={person.givenNames}
                familyName={person.familyName}
                className="size-20"
                fallbackClassName="text-2xl"
              />
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
            {canBook && bookSeed && !person.archived ? (
              <Button
                type="button"
                variant={primary === "book" ? "default" : "outline"}
                onClick={() => openBookingAnywhere(bookSeed)}
              >
                Reservar cita
              </Button>
            ) : null}
            {primary === "charge" ? (
              <Button onClick={() => onSection("cuenta")}>Cobrar</Button>
            ) : null}
            {patient && !person.archived ? (
              <NewEncounterButton
                patientId={patient.id}
                openEncounterId={summary?.openEncounterId}
                openFromSearch
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
                <PersonLink contactId={other.personId} isPatient={other.isPatient}>
                  {other.displayName}
                </PersonLink>
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
          person.archived
            ? "Vuelve entera: su página, su ficha y sus conversaciones quedan como estaban. Los enlaces de registro que se anularon al archivar no vuelven."
            : "Se archiva entera: su ficha y sus conversaciones se conservan, pero deja de aparecer en las listas y no admite conversaciones, vínculos ni enlaces de registro nuevos. Se recupera desde esta misma página."
        }
        error={archiveError}
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
