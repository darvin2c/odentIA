import { Button, buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { apiFetch } from "../../lib/api"
import { useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import type { PatientSectionId } from "../../lib/patient-areas"
import {
  ALLERGY_SEVERITY_LABELS,
  type OpenEncounterBrief,
  type PatientHealth,
  type PatientSummary,
} from "../../lib/patients"
import { categoryLabel, imageTypeLabel, takenAt } from "./document-labels"
import { activeOrgLocale } from "../../lib/locale"

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
  detail: string
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
      <p className="text-sm text-muted-foreground">{detail}</p>
    </li>
  )
}

const REVIEW_LABELS = {
  allergies: "Alergias",
  conditions: "Enfermedades y antecedentes",
  medications: "Medicación",
} as const

/**
 * Alertas clínicas antes de tocar al paciente: alergias por gravedad,
 * condiciones activas, medicación y lo que nunca se preguntó (distinto de
 * «niega»).
 */
export function ClinicalAlertsCard({
  health,
  action,
}: {
  health: PatientHealth | null
  action: ReactNode
}): React.JSX.Element {
  const allergies = (health?.allergies ?? []).filter((a) => a.isActive)
  const conditions = (health?.conditions ?? []).filter((c) => c.status === "activa")
  // Vigente = sin fecha de fin, igual que la cabecera de la ficha.
  const medications = (health?.medications ?? []).filter((m) => !m.endDate)
  const unasked = health
    ? (Object.keys(REVIEW_LABELS) as Array<keyof typeof REVIEW_LABELS>).filter(
        (key) => health.reviewStatus[key] === "unknown",
      )
    : []
  const severe = (severity: string) => severity === "severa" || severity === "grave"
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">Alertas clínicas</h2>
        {action}
      </div>
      {allergies.length === 0 &&
      conditions.length === 0 &&
      medications.length === 0 &&
      unasked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin alergias, condiciones ni medicación registradas.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {allergies.map((allergy) => (
            <Alert
              key={allergy.id}
              tone={severe(allergy.severity) ? "danger" : "warning"}
              title={`Alergia ${(ALLERGY_SEVERITY_LABELS[allergy.severity] ?? allergy.severity).toLowerCase()}`}
              detail={`${allergy.substance} · ${allergy.reaction ?? "reacción no descrita"}`}
            />
          ))}
          {conditions.map((condition) => (
            <Alert
              key={condition.id}
              tone="warning"
              title={condition.name}
              detail={condition.cie10Code ? `CIE-10 ${condition.cie10Code}` : "Antecedente activo"}
            />
          ))}
          {medications.length > 0 ? (
            <Alert
              tone="muted"
              title={plural(medications.length, "medicamento vigente", "medicamentos vigentes")}
              detail={medications.map((m) => m.name).join(", ")}
            />
          ) : null}
          {unasked.length > 0 ? (
            <Alert
              tone="muted"
              title="No preguntado"
              detail={`${unasked.map((key) => REVIEW_LABELS[key]).join(", ")}: no consta si se preguntó.`}
            />
          ) : null}
        </ul>
      )}
    </section>
  )
}

type RecentDoc = PatientSummary["recentDocuments"][number]

function Thumbnail({ patientId, doc }: { patientId: string; doc: RecentDoc }) {
  const signed = useQuery({
    queryKey: ["patient-document-url", patientId, doc.id, "thumb"],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(
        `/api/patients/${patientId}/documents/${doc.id}/url?variant=thumb`,
      ),
    staleTime: 10 * 60 * 1000,
  })
  const url = signed.data?.data.url
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
        {url ? (
          <img src={url} alt={doc.label} loading="lazy" className="size-full object-cover" />
        ) : null}
      </div>
      <span className="truncate text-xs font-medium" title={doc.label}>
        {doc.label}
      </span>
      <span className="text-xs text-muted-foreground">
        {imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)}
        {doc.toothNumbers.length > 0 ? ` · ${doc.toothNumbers.join(", ")}` : ""} ·{" "}
        {new Date(takenAt(doc)).toLocaleDateString(activeOrgLocale(), { day: "2-digit", month: "short" })}
      </span>
    </li>
  )
}

/** Imágenes recientes con miniatura: radiografías y fotos a un clic de la galería. */
export function RecentImagesCard({
  patientId,
  documents,
  onOpen,
}: {
  patientId: string
  documents: RecentDoc[]
  onOpen: (section: PatientSectionId) => void
}): React.JSX.Element | null {
  const images = documents.filter((doc) => doc.contentType?.startsWith("image/")).slice(0, 4)
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">Imágenes recientes</h2>
        <Button size="sm" variant="outline" onClick={() => onOpen("imagenes")}>
          Todas
        </Button>
      </div>
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin radiografías ni fotos clínicas. Se suben desde la atención o la galería.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {images.map((doc) => (
            <Thumbnail key={doc.id} patientId={patientId} doc={doc} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function ClinicalShortcuts({ onOpen }: { onOpen: (section: PatientSectionId) => void }) {
  return (
    <nav aria-label="Accesos clínicos" className="flex flex-wrap gap-2">
      {(
        [
          ["odontograma", "Odontograma"],
          ["historia", "Historia"],
          ["antecedentes", "Antecedentes"],
        ] as const
      ).map(([section, label]) => (
        <Button key={section} size="sm" variant="outline" onClick={() => onOpen(section)}>
          {label}
        </Button>
      ))}
    </nav>
  )
}
