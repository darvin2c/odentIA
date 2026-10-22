import { label } from "../../lib/glossary"
import { diagnosisCodeLabel, formatVitals } from "@odentia/clinical"
import { conditionLabel, surfaceLabel } from "@odentia/dental"
import { Badge, buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { periodontalBlockSummary, useEncounterPeriodontal } from "../dental/periodontal/encounter-periodontal"
import { apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  DIAGNOSIS_TYPE_LABELS,
  type EncounterDetail,
  encounterStatusLabel,
  type PatientDocument,
  planStatusLabel,
  statusLabel,
} from "../../lib/patients"
import { EncounterAddendumDrawer } from "./encounter-addendum-drawer"
import { diagnosisSiteLabel } from "./encounter-diagnoses"
import { EncounterMaterialsBlock } from "./encounter-materials"
import { activeOrgLocale } from "../../lib/locale"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(activeOrgLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function isImageDoc(doc: PatientDocument): boolean {
  return doc.contentType.startsWith("image/")
}

function DocumentAttachment({
  patientId,
  doc,
  planTitle,
}: {
  patientId: string
  doc: PatientDocument
  /** Tratamiento del plan al que se vinculó; null si no pertenece a esta atención. */
  planTitle: string | null
}) {
  const canRead = usePermission("clinical.read")
  const signed = useQuery({
    queryKey: ["patient-document-url", patientId, doc.id],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${doc.id}/url`),
    enabled: canRead,
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  })
  const url = signed.data?.data.url
  return (
    <li className="flex items-center gap-3">
      {isImageDoc(doc) && url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt={doc.label}
            loading="lazy"
            className="h-16 w-16 rounded object-cover"
          />
        </a>
      ) : null}
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{doc.label}</span>
        <span className="text-xs text-muted-foreground">
          {label("documento", doc.category)}
          {doc.toothNumbers.length > 0
            ? ` · ${doc.toothNumbers.map((t) => `Pieza ${t}`).join(", ")}`
            : ""}
          {doc.planItemId ? ` · ${planTitle ?? "Vinculado a un tratamiento del plan"}` : ""}
          {" · "}
          <time dateTime={doc.createdAt}>{formatDateTime(doc.createdAt)}</time>
        </span>
        {doc.tags.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {doc.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </span>
        )}
        {signed.isLoading && (
          <span className="text-xs text-muted-foreground">Cargando enlace…</span>
        )}
        {signed.isError && (
          <span role="alert" className="text-xs text-destructive">
            {signed.error.message}
          </span>
        )}
        {url && !isImageDoc(doc) ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            Abrir documento
          </a>
        ) : null}
        {url && isImageDoc(doc) ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            Abrir imagen completa
          </a>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Vista de lectura del detalle de una atención: encuentro, procedimientos,
 * tratamientos vinculados, notas, odontograma, documentos y adendas.
 * Reutilizable desde la atención y la historia del paciente.
 */
export function EncounterDetailView({
  patientId,
  detail,
  showAddendum = true,
}: {
  patientId: string
  detail: EncounterDetail
  showAddendum?: boolean
}) {
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const { encounter, teeth, procedures, notes, odontogramEntries, documents, addenda } = detail
  const planTitle = (planItemId: string | null | undefined): string | null =>
    [...detail.plannedItems, ...detail.indicatedItems].find((item) => item.id === planItemId)
      ?.title ?? null
  const canAddendum = showAddendum && encounter.status === "finalizada" && canWrite
  const diagnoses = detail.diagnoses ?? []
  const activeDiagnoses = diagnoses.filter((dx) => !dx.voidedAt)
  const voidedDiagnoses = diagnoses.filter((dx) => dx.voidedAt)
  const activeProcedures = procedures.filter((proc) => !proc.voidedAt)
  const periodontal = useEncounterPeriodontal(patientId, encounter.id)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {encounter.status === "anulada" ? (
        <section
          role="status"
          aria-label="Atención anulada"
          className="rounded-lg border border-destructive/40 p-4 text-sm"
        >
          <p className="font-medium">Atención anulada</p>
          <p className="text-muted-foreground">
            {encounter.voidedBy ? memberName(encounter.voidedBy) : "—"} ·{" "}
            <time dateTime={encounter.voidedAt ?? undefined}>
              {formatDateTime(encounter.voidedAt ?? null)}
            </time>
            {encounter.voidReason ? ` · Motivo: ${encounter.voidReason}` : ""}
          </p>
          <p className="text-muted-foreground">
            Se conserva como traza: no generó cargos ni cuenta en la historia activa.
          </p>
        </section>
      ) : null}
      <section
        aria-label="Datos de la atención"
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Motivo</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.reason ?? "—"}</dd>
          </div>
          {encounter.presentIllness || encounter.illnessDuration ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Enfermedad actual</dt>
              <dd className="whitespace-pre-wrap text-sm">
                {encounter.illnessDuration ? `Tiempo: ${encounter.illnessDuration}. ` : ""}
                {encounter.presentIllness ?? ""}
              </dd>
            </div>
          ) : null}
          {encounter.vitals && Object.keys(encounter.vitals).length > 0 ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Signos vitales</dt>
              <dd className="text-sm">{formatVitals(encounter.vitals)}</dd>
            </div>
          ) : null}
          {encounter.prognosis ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Pronóstico</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.prognosis}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Evolución</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.evolution ?? "—"}</dd>
          </div>
          {encounter.consentSkipReason ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Se cerró sin un consentimiento firmado
              </dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.consentSkipReason}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Indicaciones</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.indications ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Odontólogo</dt>
            <dd className="text-sm">{memberName(encounter.professionalUserId)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Inicio y fin</dt>
            <dd className="text-sm">
              {formatDateTime(encounter.startedAt ?? encounter.createdAt)}
              {encounter.endedAt ? ` – ${formatDateTime(encounter.endedAt)}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Estado</dt>
            <dd className="text-sm">
              <Badge variant="outline">{encounterStatusLabel(encounter.status)}</Badge>
            </dd>
          </div>
          {encounter.signerName ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Firmado por</dt>
              <dd className="text-sm">
                {encounter.signerName}
                {encounter.signerTitle ? ` · ${encounter.signerTitle}` : ""}
                {encounter.signerRegistration ? ` · ${encounter.signerRegistration}` : ""}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Piezas tratadas</dt>
            <dd className="text-sm">
              {teeth.length === 0 ? "—" : teeth.map((t) => `Pieza ${t}`).join(", ")}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-label="Diagnóstico">
        <h4 className="mb-2 text-sm font-medium">Diagnóstico ({activeDiagnoses.length})</h4>
        {activeDiagnoses.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin diagnósticos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {activeDiagnoses.map((dx) => (
              <li key={dx.id} className="border-b pb-2 text-sm last:border-0">
                <p>
                  <span className="font-semibold">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  {dx.note ? <span className="text-muted-foreground"> · {dx.note}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dx.diagnosisType
                    ? (DIAGNOSIS_TYPE_LABELS[dx.diagnosisType] ?? dx.diagnosisType)
                    : "Sin tipo (histórico)"}{" "}
                  · {diagnosisSiteLabel(dx)}
                  {dx.status === "resuelto" ? " · Resuelto" : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {voidedDiagnoses.length > 0 ? (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Anulados ({voidedDiagnoses.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
              {voidedDiagnoses.map((dx) => (
                <li key={dx.id}>
                  <span className="line-through">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span> · {diagnosisSiteLabel(dx)} ·
                  Motivo: {dx.voidReason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-label="Procedimientos">
        <h4 className="mb-2 text-sm font-medium">Procedimientos ({activeProcedures.length})</h4>
        {procedures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin procedimientos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {procedures.map((proc) => (
              <li key={proc.id} className="border-b pb-2 text-sm last:border-0">
                <p className={proc.voidedAt ? "text-muted-foreground line-through" : undefined}>
                  {proc.description}
                </p>
                {proc.voidedAt ? (
                  <p className="text-xs text-muted-foreground">Anulado: {proc.voidReason}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {(proc.quantity ?? 1) > 1 ? `× ${proc.quantity} · ` : ""}
                  {proc.toothNumber != null ? `Pieza ${proc.toothNumber} · ` : ""}
                  {proc.surfaces.length > 0
                    ? `${proc.surfaces.map(surfaceLabel).join(", ")} · `
                    : ""}
                  {proc.planItemId
                    ? `Tratamiento del plan: ${planTitle(proc.planItemId) ?? "vinculado"} · `
                    : ""}
                  <time dateTime={proc.createdAt}>{formatDateTime(proc.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Tratamientos vinculados">
        <h4 className="mb-2 text-sm font-medium">
          Tratamientos vinculados ({detail.plannedItems.length})
        </h4>
        {detail.plannedItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin tratamientos del presupuesto vinculados.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.plannedItems.map((item) => (
              <li key={item.id} className="border-b pb-2 text-sm last:border-0">
                <p>
                  <span className="font-medium">{item.title}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.toothNumber != null ? `Pieza ${item.toothNumber} · ` : ""}
                  {planStatusLabel(item.status)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Notas de evolución">
        <h4 className="mb-2 text-sm font-medium">Notas de evolución ({notes.length})</h4>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin notas de evolución.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="border-b pb-2 text-sm last:border-0">
                <p className="whitespace-pre-wrap">{note.note}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {note.diagnosisCode ? `${diagnosisCodeLabel(note.diagnosisSystem, note.diagnosisCode)} · ` : ""}
                  <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Odontograma vinculado">
        <h4 className="mb-2 text-sm font-medium">
          Odontograma vinculado ({odontogramEntries.length})
        </h4>
        {odontogramEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin hallazgos de odontograma.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {odontogramEntries.map((entry) => (
              <li key={entry.id} className="border-b pb-2 text-sm last:border-0">
                <p>
                  Pieza {entry.toothNumber} · {conditionLabel(entry.condition)}
                  {entry.surface ? ` · ${surfaceLabel(entry.surface)}` : ""} ·{" "}
                  {statusLabel(entry.status)}
                  {entry.diagnosisCode ? ` · ${diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode)}` : ""}
                </p>
                {entry.note ? (
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">{entry.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Documentos vinculados">
        <h4 className="mb-2 text-sm font-medium">Documentos vinculados ({documents.length})</h4>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin documentos vinculados.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {documents.map((doc) => (
              <DocumentAttachment
                key={doc.id}
                patientId={patientId}
                doc={doc}
                planTitle={planTitle(doc.planItemId)}
              />
            ))}
          </ul>
        )}
      </section>

      {periodontal.item ? (
        <section aria-label="Periodontograma" className="flex flex-col gap-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h4 className="text-sm font-medium">Periodontograma</h4>
              <p className="text-sm text-muted-foreground">
                {periodontalBlockSummary(periodontal.item)}
                {encounter.status === "finalizada" ? " · cerrado con la atención" : ""}
              </p>
            </div>
            <Link
              to="/patients/$patientId"
              params={{ patientId }}
              search={{ tab: "periodontograma", periodontograma: periodontal.item.id } as { tab: "periodontograma" }}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Ver
            </Link>
          </div>
          {encounter.status === "finalizada" ? (
            <p className="text-xs text-muted-foreground">
              Quedó fijo al firmar. Si hubo un error, explícalo en una adenda: el próximo periodontograma lo reemplaza.
            </p>
          ) : null}
        </section>
      ) : null}

      {encounter.status === "finalizada" ? (
        <EncounterMaterialsBlock patientId={patientId} encounterId={encounter.id} />
      ) : null}

      <section aria-label="Adendas">
        <h4 className="mb-2 text-sm font-medium">Adendas ({addenda.length})</h4>
        {addenda.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin correcciones posteriores al cierre.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {addenda.map((adenda) => (
              <li key={adenda.id} className="border-b pb-2 text-sm last:border-0">
                <p className="whitespace-pre-wrap">{adenda.note}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <time dateTime={adenda.createdAt}>{formatDateTime(adenda.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
        {canAddendum ? (
          <div className="mt-3">
            <EncounterAddendumDrawer patientId={patientId} encounterId={encounter.id} />
          </div>
        ) : null}
      </section>
    </div>
  )
}
