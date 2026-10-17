import { Badge, Button, buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { timeAgo } from "../../lib/crm"
import { documentCategoryLabel } from "../../lib/patient-overview"
import { type EncounterDetail, encounterStatusLabel, type TimelineItem } from "../../lib/patients"
import { SignedOdontogramFact } from "../odontogram-assessments"
import { DocumentOpenButton } from "./document-open-button"
import { EncounterDetailView } from "./encounter-detail-view"

/**
 * Atención finalizada como unidad clínica: motivo, evolución, procedimientos
 * con diagnósticos, tratamientos vinculados, documentos relacionados e
 * indicaciones. Detalle expandible con carga perezosa
 * (GET /api/patients/:id/encounters/:encId).
 */
export function EncounterHistoryCard({
  patientId,
  item,
}: {
  patientId: string
  item: TimelineItem
}) {
  const [expanded, setExpanded] = useState(false)
  const detail = useQuery({
    queryKey: ["encounter", patientId, item.refId],
    queryFn: () =>
      apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${item.refId}`),
    enabled: expanded,
  })
  const regionId = `encounter-detail-${item.refId}`
  const procedures = item.procedures ?? []
  const teeth = item.toothNumbers ?? []
  const diagnoses = item.diagnoses ?? (item.diagnosisCode ? [item.diagnosisCode] : [])
  const planned = item.plannedItems ?? []
  const documents = item.documents ?? []
  const planBudgetId = planned.find((link) => link.budgetId)?.budgetId

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="font-heading text-base font-medium">{item.title}</div>
          {item.status && <Badge variant="outline">{encounterStatusLabel(item.status)}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          <time dateTime={item.createdAt}>{timeAgo(item.createdAt)}</time>
          {diagnoses.length > 0 ? ` · ${diagnoses.join(", ")}` : ""}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        {teeth.length > 0 ? (
          <div className="flex flex-wrap gap-1" aria-label="Piezas tratadas">
            {teeth.map((tooth) => (
              <Badge variant="secondary" key={tooth}>
                Pieza {tooth}
              </Badge>
            ))}
          </div>
        ) : null}
        {procedures.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Procedimientos">
            {procedures.map((procedure, index) => (
              <li key={`${procedure}-${index}`}>{procedure}</li>
            ))}
          </ul>
        ) : null}
        {planned.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">
              Tratamientos vinculados del presupuesto
            </p>
            <ul className="flex flex-col gap-1 text-sm" aria-label="Tratamientos vinculados">
              {planned.map((link) => (
                <li key={link.id}>
                  {link.title}
                  {link.toothNumber != null ? (
                    <span className="text-muted-foreground"> · P{link.toothNumber}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <Link
                to="/patients/$patientId"
                params={{ patientId }}
                search={
                  { tab: "plan", ...(planBudgetId ? { budgetId: planBudgetId } : {}) } as {
                    tab: "plan"
                  }
                }
                className={buttonVariants({ variant: "link", size: "sm" })}
              >
                Ver presupuesto
              </Link>
            </div>
          </div>
        ) : null}
        {documents.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">
              Documentos relacionados ({documents.length})
            </p>
            <ul className="flex flex-col gap-1 text-sm" aria-label="Documentos relacionados">
              {documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {doc.label}{" "}
                    <span className="text-muted-foreground">
                      · {documentCategoryLabel(doc.category)}
                    </span>
                  </span>
                  <DocumentOpenButton patientId={patientId} documentId={doc.id} label={doc.label} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <SignedOdontogramFact patientId={patientId} encounterId={item.refId} />
        {item.indications ? (
          <p className="text-sm">
            <span className="font-medium">Indicaciones: </span>
            {item.indications}
          </p>
        ) : null}
        {typeof item.documentsCount === "number" && item.documentsCount > 0 && documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {item.documentsCount} documento{item.documentsCount === 1 ? "" : "s"}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Link
            to="/patients/$patientId/encounters/$encounterId"
            params={{ patientId, encounterId: item.refId }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Abrir atención
          </Link>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Contraer" : "Expandir"}
          </Button>
        </div>
        {expanded ? (
          <div id={regionId} className="border-t pt-3">
            {detail.isPending && <p className="text-sm text-muted-foreground">Cargando detalle…</p>}
            {detail.isError && (
              <p role="alert" className="text-sm text-destructive">
                {detail.error.message}
              </p>
            )}
            {detail.data ? (
              <EncounterDetailView patientId={patientId} detail={detail.data.data} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
