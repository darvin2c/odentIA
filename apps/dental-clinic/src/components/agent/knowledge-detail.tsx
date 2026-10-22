import { Button } from "@odentia/ui"
import { DetailDrawer, DetailField, DetailList, DetailSection, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { QueryErrorState } from "../../lib/query-error"
import { KnowledgeStateBadge } from "./knowledge-answers"
import { branchLabel, dayLabel, entrySubtitle, type KnowledgeEntry, type KnowledgeRevision, TOUCH } from "./knowledge-model"

const KIND_LABEL: Record<string, string> = { faq: "Pregunta frecuente", info_sede: "Información de sede", politica: "Política" }

function validityLabel(entry: Pick<KnowledgeEntry, "validFrom" | "validUntil">): string {
  if (entry.validFrom && entry.validUntil) return `Del ${dayLabel(entry.validFrom)} al ${dayLabel(entry.validUntil)}`
  if (entry.validFrom) return `Desde el ${dayLabel(entry.validFrom)}`
  if (entry.validUntil) return `Hasta el ${dayLabel(entry.validUntil)}`
  return "Sin vencimiento"
}

function Revisions({ entry }: { entry: KnowledgeEntry }) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ["agent-knowledge-revisions", entry.id, entry.version],
    queryFn: () => apiFetch<{ data: KnowledgeRevision[] }>(`/api/agent/knowledge/${entry.id}/revisions`),
    enabled: open,
    retry: false,
  })
  return (
    <DetailSection>
      <Button
        type="button"
        variant="link"
        size="sm"
        className={`h-auto self-start p-0 ${TOUCH}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Ocultar versiones" : `Ver versiones · v${entry.version}`}
      </Button>
      {!open ? null : query.isPending ? (
        <LoadingState message="Cargando versiones…" />
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ul aria-label="Versiones" className="flex flex-col gap-4">
          {query.data.data.map((revision) => (
            <li key={revision.version} className="flex flex-col gap-1 text-sm">
              <p>
                <span className="font-semibold">Versión {revision.version}</span>{" "}
                <span className="text-muted-foreground">· {new Date(revision.createdAt).toLocaleString("es")}</span>
              </p>
              <p className="font-medium">{revision.title}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{revision.body}</p>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  )
}

/**
 * Una respuesta oficial abierta desde su fila: lo que dice, dónde y hasta
 * cuándo vale, y sus acciones (editar, publicar o despublicar, ver versiones).
 * Si una corrección propone cambiarla, lleva a esa lección.
 */
export function KnowledgeDetail({
  entry,
  canWrite,
  statusPending,
  statusBlocked,
  statusError,
  onCheckStatus,
  onClose,
  onEdit,
  onToggleStatus,
  onOpenLesson,
}: {
  entry: KnowledgeEntry | null
  canWrite: boolean
  statusPending: boolean
  /** El último cambio de estado quedó sin confirmar: se consulta antes de pedir otro. */
  statusBlocked: boolean
  statusError: string | null
  onCheckStatus: () => void
  onClose: () => void
  onEdit: (entry: KnowledgeEntry) => void
  onToggleStatus: (entry: KnowledgeEntry) => void
  onOpenLesson: (lessonId: string) => void
}) {
  const subtitle = entry ? entrySubtitle(entry) : null
  return (
    <DetailDrawer
      open={entry !== null}
      title="Respuesta oficial"
      description={entry?.title}
      onClose={onClose}
      isSubmitting={statusPending}
      actions={
        entry && canWrite ? (
          <>
            <Button type="button" variant="outline" disabled={statusPending || statusBlocked} onClick={() => onToggleStatus(entry)}>
              {entry.status === "publicada" ? "Despublicar" : "Publicar"}
            </Button>
            <Button type="button" disabled={statusPending} onClick={() => onEdit(entry)}>
              Editar
            </Button>
          </>
        ) : null
      }
    >
      {entry ? (
        <div className="flex flex-col gap-5">
          {statusError ? (
            <ErrorState
              title="No pudimos confirmar el cambio de estado"
              message={statusError}
              onRetry={onCheckStatus}
              retryLabel="Consultar estado actual"
            />
          ) : null}
          {entry.pendingLessonId ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
              <p>
                <span className="font-semibold">Hay un cambio por aprobar.</span> Una corrección propone otro texto para esta respuesta; no
                cambia nada hasta que alguien lo apruebe.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH}
                onClick={() => entry.pendingLessonId && onOpenLesson(entry.pendingLessonId)}
              >
                Ver el cambio
              </Button>
            </div>
          ) : null}
          <DetailList>
            <DetailField label="Estado">
              <KnowledgeStateBadge entry={entry} />
            </DetailField>
            <DetailField label="Sede">{branchLabel(entry)}</DetailField>
            <DetailField label="Vigencia">{validityLabel(entry)}</DetailField>
            <DetailField label="Tipo">{KIND_LABEL[entry.kind] ?? entry.kind}</DetailField>
          </DetailList>
          {/* Las formas de preguntar van completas más abajo. */}
          {subtitle && !subtitle.startsWith("También") ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          <DetailSection title="La respuesta">
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{entry.body}</p>
          </DetailSection>
          {entry.askForms.length > 0 ? (
            <DetailSection title="También la piden como">
              <ul className="flex flex-col gap-1 text-sm">
                {entry.askForms.map((form) => (
                  <li key={form} className="[overflow-wrap:anywhere]">
                    «{form}»
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
          <Revisions key={entry.id} entry={entry} />
        </div>
      ) : null}
    </DetailDrawer>
  )
}
