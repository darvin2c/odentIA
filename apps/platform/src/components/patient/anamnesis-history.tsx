import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import type { AnamnesisAnswers } from "../../lib/patients"

interface AnamnesisVersion {
  id: string
  version: number
  createdAt: string
  createdBy: string | null
}

function AnswerValue({ value }: { value: unknown }) {
  if (value == null) return null
  if (typeof value === "boolean") return <span>{value ? "Sí" : "No"}</span>
  if (typeof value !== "object") return <span className="whitespace-pre-wrap">{String(value)}</span>
  if (Array.isArray(value)) {
    return (
      <ul className="list-inside list-disc">
        {value.map((item, index) => (
          <li key={index}>
            <AnswerValue value={item} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="flex flex-col">
      {Object.entries(value).map(([key, answer]) => (
        <div key={key} className="grid grid-cols-[180px_1fr] gap-2 border-b py-1.5 last:border-0">
          <dt className="text-sm text-muted-foreground first-letter:uppercase">
            {key.replace(/([a-z])([A-Z])/g, "$1 $2")}
          </dt>
          <dd className="text-sm">
            <AnswerValue value={answer} />
          </dd>
        </div>
      ))}
    </div>
  )
}

function AnswersView({ value }: { value: unknown }) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return <AnswerValue value={value} />
  }
  return (
    <div className="flex flex-col gap-4">
      {Object.entries(value).map(([group, answer]) => (
        <section key={group} className="flex flex-col gap-1">
          <h4 className="text-sm font-medium first-letter:uppercase">
            {group.replace(/([a-z])([A-Z])/g, "$1 $2")}
          </h4>
          <AnswerValue value={answer} />
        </section>
      ))}
    </div>
  )
}

export function AnamnesisVersionDialog({
  patientId,
  versionId,
  onClose,
}: {
  patientId: string
  versionId: string | null
  onClose: () => void
}) {
  const version = useQuery({
    queryKey: ["patient-anamnesis-version", patientId, versionId],
    queryFn: () =>
      apiFetch<{ data: AnamnesisVersion & { answers: AnamnesisAnswers } }>(
        `/api/patients/${patientId}/anamnesis/${versionId}`,
      ),
    enabled: versionId !== null,
  })
  return (
    <Dialog
      open={versionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Anamnesis {version.data ? `v${version.data.data.version}` : ""}</DialogTitle>
          <DialogDescription>
            Registro histórico inmutable de respuestas.{" "}
            {version.data
              ? version.data.data.createdBy
                ? "Registrado por personal clínico."
                : "Declarado por el paciente/responsable."
              : ""}
          </DialogDescription>
        </DialogHeader>
        {version.isLoading ? (
          <LoadingState message="Cargando antecedentes…" />
        ) : version.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {version.error.message}
          </p>
        ) : (
          <AnswersView value={version.data?.data.answers} />
        )}
      </DialogContent>
    </Dialog>
  )
}
