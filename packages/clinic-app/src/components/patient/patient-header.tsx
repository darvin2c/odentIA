import { documentText, formatMoney } from "@odentia/clinical"
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
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import {
  ConfirmDialog,
  HeaderCompactProvider,
  MobileNavTrigger,
  PageHeaderMenu,
  PersonAvatar,
  submitErrorMessage,
  useHeaderUtilities,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageCircle, MoreHorizontal } from "lucide-react"
import { useId, useState } from "react"
import { allergyName } from "../../lib/allergies"
import { apiFetch } from "../../lib/api"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { declaredMarkWords, pregnancyChip } from "../../lib/declared-health"
import { useCan, usePermission } from "../../lib/crm"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { label } from "../../lib/glossary"
import { clinicToday } from "../../lib/inventory"
import { useOrgLocale } from "../../lib/locale"
import { sexLabel, speaksForWords } from "../../lib/patient-overview"
import {
  ageFrom,
  type DeclaredHealthGroup,
  fetchPatientHealth,
  hcLabel,
  isCurrentMedication,
  type PatientFull,
  type PatientHealth,
  type PatientSummary,
} from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonPage, relationshipText } from "../../lib/people"
import { personHeaderRules } from "../../lib/screen-rules"
import type { BookingSeed } from "../agenda/booking-drawer"
import { openBookingAnywhere } from "../agenda/schedule-host"
import { useOpenRecordPanel } from "../person/record-panel"
import { PersonLink } from "../person-link"
import { WriteToPersonDialog } from "../write-to-person"
import { CollectButton } from "./collect-flow"
import { FiliacionSectionDrawer } from "./filiacion-section-drawer"
import { NewEncounterButton } from "./new-encounter-button"
import { StaleEncounterNotice } from "./stale-encounter"
import { UpcomingLine, usePersonUpcoming } from "./next-up"
import { PatientAvatar } from "./patient-avatar"
import { useOpenWide } from "./wide-section"

/** Alertas prioritarias: primero alergias severas, luego el resto. Siempre visibles, nunca tras un desplegable. */
export function clinicalAlerts(
  detail: Pick<PatientFull, "activeAllergies" | "activeConditions" | "currentMedications">,
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
      // Toda alergia alerta al menos como una enfermedad (QA de la ficha del 10 nov, B1).
      tone: "warning" as const,
    }))
  const conditions = detail.activeConditions.map((c) => ({
    id: c.id,
    label: c.name,
    tone: "warning" as const,
  }))
  // Lo que toma, con su nombre: un anticoagulante cambia la anestesia y la hemostasia
  // (mesa del 9 nov). Antes solo se contaba («2 medicamentos vigentes»).
  const medications = detail.currentMedications.map((m) => ({
    id: m.id,
    label: `Toma ${[m.name, m.dose].filter(Boolean).join(" ")}`,
    tone: "secondary" as const,
  }))
  return [...severe, ...other, ...conditions, ...medications]
}

/**
 * Franja clínica reutilizable (cabecera y editor de atención): alergias,
 * enfermedades, lo que toma y el embarazo, sin botones. Sin alergias
 * registradas dice si niega o si no se le preguntó (`allergyReview`): no es lo
 * mismo. Lo que se dijo y nadie revisó va en una caja cerrada por
 * declaración, con su marca adentro («Lo dijo ella el 13 nov, sin revisar»),
 * alergias incluidas; lo confirmado queda fuera de toda caja. Lo grave va
 * primero, sea de quien sea, y el límite solo corta por la cola (QA del 14
 * nov). Quién lo dijo, cuándo y qué entra ahí lo dice el servidor
 * (`health.declared`, un grupo por declaración): con dos fechas o dos personas
 * salen dos cajas, y nada se le atribuye a quien no lo dijo.
 */
export function PatientClinicalStrip({
  detail,
  onAntecedentes,
  medicationReview,
  health,
  sex,
}: {
  detail: Pick<
    PatientFull,
    "activeAllergies" | "activeConditions" | "currentMedications" | "allergyReview" | "allergySaidNo"
  >
  onAntecedentes?: () => void
  /** Para quien lee la historia: si se le preguntó qué toma (sin medicación registrada). */
  medicationReview?: string | null
  /** La salud de quien lee la historia: de aquí salen las marcas de lo declarado y el embarazo. */
  health?: PatientHealth | null
  /** El sexo registrado del paciente, para decir «ella» o «él»; sin él no se supone. */
  sex?: string | null
}) {
  const stripId = useId()
  const noAllergies = !detail.activeAllergies.some((a) => a.verification !== "descartada")
  // Quien solo ve las alergias (recepción) recibe una sola cosa de lo declarado: su «No», con quién lo dijo.
  const groups: DeclaredHealthGroup[] =
    health?.declared ??
    (detail.allergySaidNo
      ? [
          {
            ...detail.allergySaidNo,
            allergies: [],
            conditions: [],
            medications: [],
            pregnancy: false,
            saidNo: { allergies: true, conditions: false, medications: false },
          },
        ]
      : [])
  const groupIndex = (find: (group: DeclaredHealthGroup) => boolean): number | null => {
    const index = groups.findIndex(find)
    return index === -1 ? null : index
  }
  const pregnancy = health?.pregnancy ?? null
  // El «No» que marcó la persona (o quien habla por ella) no es «Niega alergias»: nadie se lo preguntó.
  const saidNoAllergies = noAllergies ? groupIndex((group) => group.saidNo.allergies) : null
  const alerts = [
    ...(pregnancy
      ? [
          {
            id: "embarazo",
            label: pregnancyChip(pregnancy),
            // Pasado el término ya no es una alerta: se pide confirmarlo.
            tone: pregnancy.state === "vigente" ? ("warning" as const) : ("secondary" as const),
            group: groupIndex((group) => group.pregnancy),
          },
        ]
      : []),
    ...(saidNoAllergies !== null
      ? [{ id: "alergias-no", label: "Alergias: dijo que no", tone: "warning" as const, group: saidNoAllergies }]
      : []),
    ...clinicalAlerts(detail).map((alert) => ({
      ...alert,
      group: groupIndex(
        (group) =>
          group.allergies.includes(alert.id) || group.conditions.includes(alert.id) || group.medications.includes(alert.id),
      ),
    })),
  ]
  // Lo grave primero, sea de quien sea (QA del 14 nov, H1): las alergias severas que confirmó el
  // equipo; después cada declaración sin revisar, con su severa delante; después lo demás.
  const severe = (alert: (typeof alerts)[number]) => alert.tone === "destructive"
  const confirmed = alerts.filter((alert) => alert.group === null)
  const ordered = [
    ...confirmed.filter(severe),
    ...groups.flatMap((_group, index) =>
      alerts.filter((alert) => alert.group === index).sort((a, b) => Number(severe(b)) - Number(severe(a))),
    ),
    ...confirmed.filter((alert) => !severe(alert)),
  ]
  // El límite corta solo por la cola: una alergia severa nunca se va a «+N».
  const shownIds = new Set(
    ordered.filter((alert, index) => index < STRIP_LIMIT || severe(alert)).map((alert) => alert.id),
  )
  const isShown = (alert: (typeof alerts)[number]) => shownIds.has(alert.id)
  const hidden = ordered.length - shownIds.size
  const allergyWord =
    saidNoAllergies !== null
      ? null
      : noAllergies && detail.allergyReview === "none"
        ? "Niega alergias"
        : noAllergies && detail.allergyReview === "unknown"
          ? "Alergias: no preguntado"
          : null
  // Antes de recetar importa saber si se le preguntó qué toma (segunda mesa, latidIA).
  const medicationWord =
    detail.currentMedications.length === 0 && medicationReview === "unknown" ? "Medicación: no preguntado" : null
  if (alerts.length === 0 && !allergyWord && !medicationWord) return null
  const moreLabel = `+${hidden} ${hidden === 1 ? "alerta" : "alertas"}`
  const chip = (alert: (typeof alerts)[number]) => (
    <Badge
      key={alert.id}
      variant={alert.tone === "destructive" ? "destructive" : alert.tone === "warning" ? "outline" : "secondary"}
      // Una alergia o enfermedad larga corta línea en vez de ensanchar la página en el teléfono.
      className={cn(
        "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
        alert.tone === "warning" && "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      {alert.label}
    </Badge>
  )
  const more = onAntecedentes ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-auto min-h-11 max-w-full shrink py-1 text-left whitespace-normal sm:min-h-8"
      onClick={onAntecedentes}
    >
      {moreLabel} · ver antecedentes
    </Button>
  ) : (
    <Badge variant="outline" className="h-auto min-h-5 max-w-full py-px text-left whitespace-normal">
      {moreLabel}
    </Badge>
  )
  const item = (alert: (typeof alerts)[number]) => (
    <li key={alert.id} className="flex min-w-0 max-w-full">
      {chip(alert)}
    </li>
  )
  return (
    // Una lista y no un texto suelto: el lector de pantalla dice cuántas alertas hay y qué cae dentro
    // de cada declaración, y lo que viene después de una caja queda fuera de ella.
    <section aria-label="Alertas clínicas" className="min-w-0">
      <ul className="flex flex-wrap items-center gap-2">
        {confirmed.filter((alert) => severe(alert) && isShown(alert)).map(item)}
        {groups.map((group, index) => {
          const said = ordered.filter((alert) => alert.group === index && isShown(alert))
          if (said.length === 0) return null
          const markId = `${stripId}-${index}`
          return (
            // Cada declaración en su caja cerrada, con su marca adentro: lo de otra persona o lo ya
            // revisado nunca queda «detrás» de ella. A lo ancho del teléfono la caja ocupa la línea.
            <li
              key={`${group.by.kind}-${group.by.name ?? ""}-${group.at ?? index}`}
              className="flex w-full min-w-0 max-w-full flex-col gap-1.5 rounded-md border border-dashed border-warning/40 bg-warning-soft/40 px-2 py-1 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center"
            >
              <span id={markId} className="text-xs font-medium">
                {declaredMarkWords(group.by, group.at, sex)}
              </span>
              <ul aria-labelledby={markId} className="flex min-w-0 flex-wrap items-center gap-2">
                {said.map(item)}
              </ul>
            </li>
          )
        })}
        {confirmed.filter((alert) => !severe(alert) && isShown(alert)).map(item)}
        {allergyWord ? (
          <li className="flex min-w-0 max-w-full">
            {/* «No preguntado» es el estado peligroso: se distingue de «niega» (mesa del 9 nov). */}
            <Badge
              variant="outline"
              className={cn(
                "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
                detail.allergyReview === "unknown" && "border-warning/30 bg-warning-soft text-warning",
              )}
            >
              {allergyWord}
            </Badge>
          </li>
        ) : null}
        {medicationWord ? (
          <li className="flex min-w-0 max-w-full">
            <Badge variant="outline" className="h-auto min-h-5 max-w-full border-warning/30 bg-warning-soft py-px text-left whitespace-normal text-warning">
              {medicationWord}
            </Badge>
          </li>
        ) : null}
        {hidden > 0 ? <li className="flex min-w-0 max-w-full">{more}</li> : null}
      </ul>
    </section>
  )
}

/** Cuántas alertas caben en la franja antes de «+N»; las severas no cuentan para el corte. */
const STRIP_LIMIT = 6

/** La ficha con lo clínico de la salud: enfermedades activas y lo que toma hoy (la regla del Resumen). */
function withHealth(detail: PatientFull, health: PatientHealth): PatientFull {
  const today = clinicToday()
  return {
    ...detail,
    activeConditions: health.conditions.filter((condition) => condition.status === "activa"),
    currentMedications: health.medications.filter((medication) => isCurrentMedication(medication, today)),
    allergyReview: health.reviewStatus.allergies,
  }
}

/**
 * Lo que la persona tiene por delante, según quien mira (mesa del 9 nov): su
 * próxima cita a quien ve la agenda y lo que debe o tiene a favor a quien ve la
 * caja, en la cabecera de todas las pestañas. Cada moneda por separado, sin
 * sumarlas (ADR 0135), con el saldo que se cobra (lo que debe menos lo que
 * tiene a favor), el mismo de Cobros.
 */
function HeaderStatus({
  personId,
  patientId,
  onAccount,
}: {
  personId: string
  patientId: string | null
  onAccount: boolean
}) {
  const canAppointments = usePermission("appointments.read")
  const canFinance = usePermission("finance.read")
  const upcoming = usePersonUpcoming(patientId, canAppointments)
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId ?? ""),
    enabled: canFinance && Boolean(patientId),
  })
  const locale = useOrgLocale() ?? "es"
  const balances = (account.data?.data.byCurrency ?? []).filter((row) => row.saldo !== 0)
  const showMoney = canFinance && Boolean(patientId)
  if (!upcoming && !showMoney) return null
  return (
    <section aria-label="Lo que viene" className="flex flex-col gap-1">
      {upcoming ? <UpcomingLine {...upcoming} /> : null}
      {showMoney ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Cuenta: </span>
          {account.isPending
            ? "consultando…"
            : account.isError
              ? "no se pudo consultar"
              : balances.length === 0
                ? "no debe nada"
                : balances
                    .map((row) =>
                      row.saldo > 0
                        ? `debe ${formatMoney(row.saldo, row.currency, locale)}`
                        : `tiene ${formatMoney(-row.saldo, row.currency, locale)} a favor`,
                    )
                    .join(" y ")}
          {!onAccount && !account.isPending && !account.isError ? (
            <>
              {" · "}
              <Link
                to="/people/$personId"
                params={{ personId }}
                search={{ tab: "cuenta" }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Ver Cobros
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
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
  onAccount,
}: {
  person: PersonPage
  /** Ficha administrativa del paciente, si lo es (alergias, foto, edad). */
  detail?: PatientFull
  /** Resumen clínico ya cargado por la pestaña Clínica (no se pide aquí). */
  summary?: PatientSummary
  /** Ya está en Cobros: el botón de cobrar es el de esa pantalla, no se repite. */
  onAccount: boolean
}) {
  // La página no usa PageHeader; las utilidades globales (avisos) van aquí.
  const utilities = useHeaderUtilities()
  // El disparador del menú lateral en el teléfono, como en el encabezado de página.
  const sidebar = useSidebarOptional()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const canRead = usePermission("patients.read")
  const can = useCan()
  // «Habla por ella» no incluye a quien solo es su contacto de emergencia.
  const speaksFor = person.spokenForBy.filter((other) => !other.emergencyOnly)
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
  const canCrm = usePermission("crm.read")
  const canRegisterResponsible = usePermission("patients.write")
  // El portal lo dan recepción y quien ve la historia, todos igual (ADR 0156).
  const canPortal = usePermission("clinical.read") || canRegisterResponsible
  const openWide = useOpenWide()
  const openPanel = useOpenRecordPanel()
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
  // Quien lee la historia ve también sus enfermedades y lo que toma, en todas las
  // pestañas (mesa del 9 nov): es la misma lectura que el Resumen, en la misma caché.
  const canClinical = can("clinical.read")
  const health = useQuery({
    queryKey: ["patient-health", patient?.id ?? null],
    queryFn: () => fetchPatientHealth(patient?.id ?? ""),
    enabled: canClinical && Boolean(patient),
  })
  const clinicalHealth = health.data?.data ?? null
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
    age ? `${age} ${Number(age) === 1 ? "año" : "años"}` : null,
    person.sex ? sexLabel(person.sex) : null,
  ].filter(Boolean)
  // «Nueva cita» al lado, sin ir a la Agenda. Para quien aún no es paciente crea
  // su ficha mínima unida a la persona.
  const bookSeed: BookingSeed | null = patient
    ? { patient: { id: patient.id, name: person.displayName }, lockedPatient: true }
    : canCrm
      ? { person: { contactId: person.id, name: person.displayName, givenNames: person.givenNames, familyName: person.familyName, phone: person.phone } }
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
        {sidebar ? <MobileNavTrigger /> : null}
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
            {primary === "charge" && patient && !onAccount ? (
              <CollectButton patientId={patient.id} patientName={person.displayName} />
            ) : null}
            {patient && !person.archived ? (
              <NewEncounterButton
                patientId={patient.id}
                openEncounterId={summary?.openEncounterId}
                openFromSearch
              />
            ) : null}
            {canEdit || (canPortal && patient && !person.archived && openWide) ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon" aria-label="Más acciones" />}
                >
                  <MoreHorizontal aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit ? (
                  <DropdownMenuItem
                    // Sin la ficha cargada el cajón no tendría qué mostrar.
                    disabled={Boolean(patient) && !detail}
                    onClick={() => {
                      setMenuOpen(false)
                      setEditing(true)
                    }}
                  >
                    Editar datos personales
                  </DropdownMenuItem>
                  ) : null}
                  {canPortal && patient && !person.archived && openWide ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setMenuOpen(false)
                        // La misma sección de Datos, con su estado primero (ADR 0156).
                        openWide({ id: "portal" })
                      }}
                    >
                      Portal del paciente
                    </DropdownMenuItem>
                  ) : null}
                  {canEdit ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setMenuOpen(false)
                        setArchiveError(null)
                        setArchiveOpen(true)
                      }}
                    >
                      {person.archived ? "Recuperar" : "Archivar"}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {patient && speaksFor.length > 0 ? (
          <p className="text-sm">
            <span className="font-medium">{speaksForWords(person.sex)}: </span>
            {speaksFor.map((other, index) => (
              <span key={other.personId}>
                {index > 0 ? ", " : ""}
                <PersonLink contactId={other.personId} isPatient={other.isPatient} inText>
                  {other.displayName}
                </PersonLink>
                <span className="text-muted-foreground">
                  {" "}
                  · {relationshipText(other.relationship, other.relationshipDetail)}
                </span>
                {canReadChats && other.conversationId ? (
                  <>
                    {" · "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => {
                        if (other.conversationId) openPanel?.({ conversationId: other.conversationId, name: other.displayName })
                      }}
                    >
                      Ver su conversación
                    </Button>
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
                {canRegisterResponsible && !person.archived ? (
                  <button
                    type="button"
                    className="font-medium underline underline-offset-4"
                    onClick={() => openWide?.({ id: "responsables", grant: true })}
                  >
                    Registrar responsable
                  </button>
                ) : null}
              </>
            ) : responsibilities.isError ? (
              "No se pudo consultar quién representa al paciente."
            ) : (
              "Consultando responsables…"
            )}
          </p>
        ) : null}
        <HeaderStatus personId={person.id} patientId={patient?.id ?? null} onAccount={onAccount} />
        {detail ? (
          <PatientClinicalStrip
            detail={clinicalHealth ? withHealth(detail, clinicalHealth) : detail}
            medicationReview={clinicalHealth?.reviewStatus.medications ?? null}
            health={clinicalHealth}
            sex={person.sex}
            onAntecedentes={canClinical && openWide ? () => openWide({ id: "antecedentes" }) : undefined}
          />
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
        onOpened={(conversationId, target) => openPanel?.({ conversationId, name: target.displayName })}
      />
      {/* La atención que quedó abierta de otro día: qué hacer con ella, sin frenar (10 nov). */}
      {patient && !person.archived ? <StaleEncounterNotice patientId={patient.id} /> : null}
    </header>
  )
}
