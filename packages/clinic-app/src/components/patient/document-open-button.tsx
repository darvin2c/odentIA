import { Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

export function useDocumentUrl(patientId: string, documentId: string) {
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  })
}

/** Prefetcha la URL firmada para abrirla en el gesto del usuario sin bloqueos de ventanas. */
export function DocumentOpenButton({
  patientId,
  documentId,
  label,
}: {
  patientId: string
  documentId: string
  label: string
}) {
  const signed = useDocumentUrl(patientId, documentId)
  const url = signed.data?.data.url ?? null
  if (signed.isError) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="alert" className="text-xs text-destructive">
          No se pudo obtener el documento.
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void signed.refetch()}>
          Reintentar
        </Button>
      </span>
    )
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="max-w-full"
      disabled={!url}
      onClick={() => {
        if (url) window.open(url, "_blank", "noopener")
      }}
    >
      <span className="truncate">{signed.isPending ? "Obteniendo documento…" : `Abrir ${label}`}</span>
    </Button>
  )
}
