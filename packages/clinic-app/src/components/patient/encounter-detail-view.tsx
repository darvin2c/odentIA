import { label } from "../../lib/glossary"
import { diagnosisCodeLabel, formatVitals, isRetiredPlanStatus, planItemStateText } from "@odentia/clinical"
import { Badge } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { fetchPrescriptions } from "../../lib/clinical-journey"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  DIAGNOSIS_TYPE_LABELS,
  type EncounterDetail,
  type PatientDocument,
  planStatusLabel,
} from "../../lib/patients"
import { formatTakenAt, takenAt } from "./document-labels"
import { EncounterAddendumDrawer } from "./encounter-addendum-drawer"
import { diagnosisSiteSuffix } from "./encounter-diagnoses"
import { EncounterMaterialsBlock } from "./encounter-materials"
import { FormRecordView } from "./form-record"
import { activeOrgLocale } from "../../lib/locale"
import { productUi } from "../../product/product-ui"
import { partNames } from "../../product/site-fields"

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
          {/* Con fecha propia (la de toma), solo su día, como en Documentos; si no, cuándo se subió. */}
          <time dateTime={takenAt(doc)}>
            {doc.capturedAt ? formatTakenAt(doc) : formatDateTime(doc.createdAt)}
          </time>
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

/** «a, b ni c»: lo que no se registró. */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ni ${items.at(-1)}`
}

/**
 * Lo que la atención no registró, para decirlo en una sola línea: así nadie cree
 * que está escondido. Una receta emitida en ella es una indicación y un documento
 * registrados (E9); un formulario finalizado también es un documento suyo (QA de
 * formularios del 13 nov: decía «Sin registrar: … documentos» teniendo uno).
 */
export function unrecordedParts(input: {
  diagnoses: number
  procedures: number
  evolution: boolean
  indications: boolean
  issuedPrescription: boolean
  /** La página de la atención lista sus documentos aparte: ahí no se dice que faltan. */
  showDocuments: boolean
  documents: number
  forms: number
}): string[] {
  return [
    input.diagnoses === 0 ? "diagnóstico" : "",
    input.procedures === 0 ? "procedimientos" : "",
    input.evolution ? "" : "evolución",
    input.indications || input.issuedPrescription ? "" : "indicaciones",
    input.showDocuments && input.documents === 0 && !input.issuedPrescription && input.forms === 0 ? "documentos" : "",
  ].filter(Boolean)
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
  showDocuments = true,
}: {
  patientId: string
  detail: EncounterDetail
  showAddendum?: boolean
  /** La página de la atención los lista en su propio bloque «Documentos»: aquí no se repiten. */
  showDocuments?: boolean
}) {
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const memberName = useMemberName()
  const { encounter, teeth, procedures, notes, documents, addenda } = detail
  // Los formularios finalizados en ella son algo que se anotó: van con sus respuestas.
  const forms = detail.forms ?? []
  // La misma consulta (y caché) que el bloque «Documentos» de la atención: sus recetas.
  const prescriptions = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
    enabled: canRead,
  })
  const issuedPrescription = (prescriptions.data?.data ?? []).some(
    (row) => row.encounterId === encounter.id && row.status !== "anulada",
  )
  const planTitle = (planItemId: string | null | undefined): string | null =>
    [...detail.plannedItems, ...detail.indicatedItems].find((item) => item.id === planItemId)
      ?.title ?? null
  const canAddendum = showAddendum && encounter.status === "finalizada" && canWrite
  const diagnoses = detail.diagnoses ?? []
  const activeDiagnoses = diagnoses.filter((dx) => !dx.voidedAt)
  const voidedDiagnoses = diagnoses.filter((dx) => dx.voidedAt)
  // Lo del producto en la atención (odentIA: el odontograma vinculado y el periodontograma).
  const ProductDetail = productUi().encounter.Detail
  // El examen como lo cuenta el producto (latidIA: por sistemas, con lo no examinado).
  const exam = productUi().encounter.examination
  const examLines = exam.readLines(encounter.examination)
  // Solo lo que se anuló con ella: un presupuesto anulado antes, por su cuenta, no.
  const voidedBudgets = (detail.budgets ?? []).filter((budget) => budget.voidedWith)
  // Lo que se indicó aquí y no se hizo hoy (la corona, la opción B): la firmada lo nombra con su presupuesto.
  const doneHere = new Set(detail.plannedItems.map((item) => item.id))
  // Con la misma etiqueta que la tarjeta plegada de la Historia, y lo quitado aparte en
  // «Ya no vigente», como ella: no «Cancelado» plegada y «Por decidir» abierta (tercer repaso del 9 nov, E9).
  const indicatedOnly = detail.indicatedItems.filter((item) => !doneHere.has(item.id) && !isRetiredPlanStatus(item.status))
  const indicatedRetired = detail.indicatedItems.filter((item) => !doneHere.has(item.id) && isRetiredPlanStatus(item.status))
  const liveBudgets = (detail.budgets ?? []).filter((budget) => budget.status !== "cancelado")
  const unrecorded = unrecordedParts({
    diagnoses: diagnoses.length,
    procedures: procedures.length,
    evolution: Boolean(encounter.evolution),
    indications: Boolean(encounter.indications),
    issuedPrescription,
    showDocuments,
    documents: documents.length,
    forms: forms.length,
  })

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
          {/* Lo que se anuló con ella, dicho: «traza» e «historia activa» no los dice nadie (QA del 9 nov). */}
          {voidedBudgets.length > 0 ? (
            <p className="text-muted-foreground">
              Se anuló con ella {voidedBudgets.length === 1 ? "el presupuesto" : "los presupuestos"}{" "}
              {voidedBudgets.map((budget) => `N.º ${budget.budgetNumber}`).join(", ")}.
            </p>
          ) : null}
          <p className="text-muted-foreground">Queda guardada; no cuenta en su historia ni genera cargos.</p>
        </section>
      ) : null}
      {/* Solo lo que tiene datos, en el orden de la historia: lo vacío se dice en una línea al final. */}
      <section aria-label="Datos de la atención" className="flex flex-col gap-3 rounded-lg border p-4">
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Motivo de consulta</dt>
            <dd className="whitespace-pre-wrap text-sm">{encounter.reason ?? "Sin motivo"}</dd>
          </div>
          {encounter.illnessDuration ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Tiempo de enfermedad</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.illnessDuration}</dd>
            </div>
          ) : null}
          {encounter.presentIllness ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Relato de la enfermedad</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.presentIllness}</dd>
            </div>
          ) : null}
          {encounter.vitals && Object.keys(encounter.vitals).length > 0 ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Signos vitales</dt>
              <dd className="text-sm">{formatVitals(encounter.vitals)}</dd>
            </div>
          ) : null}
          {examLines.length > 0 ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">{exam.title}</dt>
              <dd className="text-sm">
                <ul className="flex flex-col gap-0.5">
                  {examLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {encounter.prognosis ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Pronóstico</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.prognosis}</dd>
            </div>
          ) : null}
          {encounter.evolution ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Evolución</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.evolution}</dd>
            </div>
          ) : null}
          {encounter.indications ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Indicaciones</dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.indications}</dd>
            </div>
          ) : null}
          {encounter.consentSkipReason ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Se cerró sin un consentimiento firmado
              </dt>
              <dd className="whitespace-pre-wrap text-sm">{encounter.consentSkipReason}</dd>
            </div>
          ) : null}
          {productUi().site && teeth.length > 0 ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Piezas tratadas</dt>
              <dd className="text-sm">{teeth.map((t) => `Pieza ${t}`).join(", ")}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {diagnoses.length > 0 ? (
      <section aria-label="Diagnóstico">
        <h4 className="mb-2 text-sm font-medium">Diagnóstico</h4>
        {activeDiagnoses.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {activeDiagnoses.map((dx) => (
              <li key={dx.id} className="border-b pb-2 text-sm last:border-0">
                <p>
                  <span className="font-semibold">{dx.diagnosisTitle ?? diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  {dx.diagnosisTitle ? (
                    <span className="text-muted-foreground"> · {diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  ) : null}
                  {dx.note ? <span className="text-muted-foreground"> · {dx.note}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dx.diagnosisType
                    ? (DIAGNOSIS_TYPE_LABELS[dx.diagnosisType] ?? dx.diagnosisType)
                    : "Sin tipo (histórico)"}
                  {diagnosisSiteSuffix(dx)}
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
                  <span className="line-through">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  {diagnosisSiteSuffix(dx)} ·
                  Motivo: {dx.voidReason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      ) : null}

      {procedures.length > 0 ? (
      <section aria-label="Procedimientos">
        <h4 className="mb-2 text-sm font-medium">Lo que se hizo</h4>
        {(
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
                  {/* Las caras van con la pieza; un producto sin «dónde» no manda ninguna. */}
                  {proc.toothNumber != null && proc.surfaces.length > 0
                    ? `${partNames(proc.surfaces)} · `
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
      ) : null}

      {detail.plannedItems.length > 0 ? (
      <section aria-label="Tratamientos vinculados">
        <h4 className="mb-2 text-sm font-medium">Tratamientos del plan</h4>
        {(
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
      ) : null}
      {encounter.status === "finalizada" && (indicatedOnly.length > 0 || liveBudgets.length > 0) ? (
      <section aria-label="Se indicó">
        <h4 className="mb-2 text-sm font-medium">Se indicó</h4>
        <ul className="flex flex-col gap-1 text-sm">
          {indicatedOnly.map((item) => (
            <li key={item.id}>
              <span className="font-medium">{item.title}</span>
              <span className="text-muted-foreground">
                {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""} · {planItemStateText(item.status, item.decisionStatus)}
              </span>
            </li>
          ))}
          {liveBudgets.map((budget) => (
            <li key={budget.id} className="text-muted-foreground">
              Presupuesto N.º {budget.budgetNumber} · {budget.stateText}
            </li>
          ))}
        </ul>
      </section>
      ) : null}
      {encounter.status === "finalizada" && indicatedRetired.length > 0 ? (
      <section aria-label="Ya no vigente">
        <h4 className="mb-2 text-sm font-medium text-muted-foreground">Ya no vigente</h4>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {indicatedRetired.map((item) => (
            <li key={item.id}>
              {item.title}
              {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""} · {planItemStateText(item.status, item.decisionStatus)}
            </li>
          ))}
        </ul>
      </section>
      ) : null}
      {notes.length > 0 ? (
      <section aria-label="Notas de evolución">
        <h4 className="mb-2 text-sm font-medium">Notas de evolución</h4>
        {(
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
      ) : null}

      <ProductDetail patientId={patientId} detail={detail} slot="recorded" />

      {forms.length > 0 ? (
        <section aria-label="Formularios">
          <h4 className="mb-2 text-sm font-medium">Formularios</h4>
          <div className="flex flex-col gap-3">
            {forms.map((form) => (
              <FormRecordView key={form.id} form={form} />
            ))}
          </div>
        </section>
      ) : null}

      {showDocuments && documents.length > 0 ? (
      <section aria-label="Documentos vinculados">
        <h4 className="mb-2 text-sm font-medium">Documentos</h4>
        {(
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
      ) : null}

      <ProductDetail patientId={patientId} detail={detail} slot="end" />

      {unrecorded.length > 0 ? (
        <p className="text-sm text-muted-foreground">Sin registrar: {listWords(unrecorded)}.</p>
      ) : null}

      {encounter.signerName ? (
        <p className="border-t pt-3 text-sm">
          <span className="font-medium">
            Firmó <span>{encounter.signerName}</span>
          </span>
          <span className="text-muted-foreground">
            {encounter.signerTitle ? ` · ${encounter.signerTitle}` : ""}
            {encounter.signerRegistration ? ` · colegiatura ${encounter.signerRegistration}` : ""}
            {/* Cuándo firmó, no cuándo terminó la visita: la de una cita pasada se firma después. */}
            {(encounter.finalizedAt ?? encounter.endedAt) ? ` · ${formatDateTime((encounter.finalizedAt ?? encounter.endedAt)!)}` : ""}
          </span>
        </p>
      ) : null}

      {encounter.status === "finalizada" ? (
        <EncounterMaterialsBlock patientId={patientId} encounterId={encounter.id} />
      ) : null}

      {addenda.length > 0 || canAddendum ? (
      <section aria-label="Adendas">
        {addenda.length > 0 ? <h4 className="mb-2 text-sm font-medium">Correcciones después del cierre</h4> : null}
        {addenda.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {addenda.map((adenda) => (
              <li key={adenda.id} className="border-b pb-2 text-sm last:border-0">
                <p className="whitespace-pre-wrap">{adenda.note}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {adenda.authorName ? `${adenda.authorName} · ` : ""}
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
      ) : null}
    </div>
  )
}
