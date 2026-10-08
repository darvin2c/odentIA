import { conditionLabel, surfaceLabel } from "@odentia/clinical"
import { Badge } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  type EncounterDetail,
  encounterStatusLabel,
  type PatientDocument,
  planStatusLabel,
  statusLabel,
} from "../../lib/patients"
import { EncounterAddendumDrawer } from "./encounter-addendum-drawer"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", {
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
          {doc.category}
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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section
        aria-label="Datos de la atención"
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Motivo</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.reason ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Evolución</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.evolution ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Indicaciones</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.indications ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Paso siguiente</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.nextStep ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              Próxima revisión sugerida (sin reserva)
            </dt>
            <dd className="text-sm">
              {encounter.nextAppointmentAt ? (
                <time dateTime={encounter.nextAppointmentAt}>
                  {formatDateTime(encounter.nextAppointmentAt)}
                </time>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Odontólogo</dt>
            <dd className="text-sm">{memberName(encounter.dentistUserId)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Estado</dt>
            <dd className="text-sm">
              <Badge variant="outline">{encounterStatusLabel(encounter.status)}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Piezas tratadas</dt>
            <dd className="text-sm">
              {teeth.length === 0 ? "—" : teeth.map((t) => `Pieza ${t}`).join(", ")}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-label="Procedimientos">
        <h4 className="mb-2 text-sm font-medium">Procedimientos ({procedures.length})</h4>
        {procedures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin procedimientos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {procedures.map((proc) => (
              <li key={proc.id} className="border-b pb-2 text-sm last:border-0">
                <p>{proc.description}</p>
                <p className="text-xs text-muted-foreground">
                  {proc.toothNumber != null ? `Pieza ${proc.toothNumber} · ` : ""}
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
                  {note.diagnosisCode ? `CIE-10 ${note.diagnosisCode} · ` : ""}
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
                  {entry.diagnosisCode ? ` · CIE-10 ${entry.diagnosisCode}` : ""}
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
