import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@odentia/ui"
import { DetailField, DetailList, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { shortDay } from "../../lib/declared-health"

export interface AnamnesisVersion {
  id: string
  version: number
  createdAt: string
  createdBy: string | null
}

/**
 * «Ver historial» de la entrevista (revisión final del 15 nov, K2): cada versión, no solo la última,
 * y en palabras, las mismas de la copia de la historia («Biberón o pecho para dormir: ya no toma
 * biberón»), sin claves ni códigos. Se pasa de una a otra sin cerrar.
 */
export function AnamnesisVersionDialog({
  patientId,
  versionId,
  versions = [],
  onSelect = () => {},
  onClose,
}: {
  patientId: string
  versionId: string | null
  /** Todas las versiones, de la más nueva a la más antigua; sin ellas, solo la abierta. */
  versions?: readonly AnamnesisVersion[]
  onSelect?: (id: string) => void
  onClose: () => void
}) {
  const version = useQuery({
    queryKey: ["patient-anamnesis-version", patientId, versionId],
    queryFn: () =>
      apiFetch<{ data: AnamnesisVersion & { entries: Array<{ key: string; label: string; value: string }> } }>(
        `/api/patients/${patientId}/anamnesis/${versionId}`,
      ),
    enabled: versionId !== null,
  })
  const index = versions.findIndex((item) => item.id === versionId)
  const newer = index > 0 ? versions[index - 1] : undefined
  const older = index >= 0 ? versions[index + 1] : undefined
  const entries = version.data?.data.entries ?? []
  return (
    <Dialog
      open={versionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent scrollable className="max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {version.data
              ? `Entrevista v${version.data.data.version} · ${shortDay(version.data.data.createdAt)}`
              : "Entrevista"}
          </DialogTitle>
          <DialogDescription>
            Cómo quedó ese día; no se cambia.{" "}
            {version.data
              ? version.data.data.createdBy
                ? "La guardó el equipo."
                : "La declaró el paciente o quien habla por él."
              : ""}
          </DialogDescription>
        </DialogHeader>
        {versions.length > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!older} onClick={() => older && onSelect(older.id)}>
              Anterior{older ? ` (v${older.version})` : ""}
            </Button>
            <span className="text-sm text-muted-foreground">
              {index + 1} de {versions.length}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={!newer} onClick={() => newer && onSelect(newer.id)}>
              Siguiente{newer ? ` (v${newer.version})` : ""}
            </Button>
          </div>
        ) : null}
        {version.isLoading ? (
          <LoadingState message="Cargando antecedentes…" />
        ) : version.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {version.error.message}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Esta versión no tiene nada respondido.</p>
        ) : (
          <DetailList>
            {entries.map((entry) => (
              <DetailField key={entry.key} label={entry.label}>
                {entry.value}
              </DetailField>
            ))}
          </DetailList>
        )}
      </DialogContent>
    </Dialog>
  )
}
