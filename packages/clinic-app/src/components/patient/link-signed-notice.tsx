import { Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import {
  fetchConsents,
  fetchLinkSignedToConfirm,
  type LinkSignedToConfirm,
} from "../../lib/clinical-forms"
import { formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { ConsentPaper } from "./document-papers"

/**
 * «Rosa Ruiz (representante legal) · DNI ••••1111 · 8 nov 9:40 · Exodoncia de la pieza 38»: lo que
 * el profesional mira antes de confirmar, en la lista y en la hoja. El documento llega abreviado
 * del servidor (`listLinkSignedToConfirm`): aquí no se enmascara nada.
 */
export function linkSignedSummary(
  row: Pick<LinkSignedToConfirm, "signerName" | "signerKind" | "representativeRelation" | "signerDocument" | "personSignedAt" | "procedureRef">,
): string {
  return [
    `${row.signerName} (${row.signerKind === "representante" ? (row.representativeRelation ?? "representante").toLowerCase() : "paciente"})`,
    row.signerDocument,
    formatDateTime(row.personSignedAt),
    row.procedureRef,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Lo que la persona firmó en su enlace sale arriba al abrir la atención en curso,
 * también lo enviado desde Documentos: se confirma aquí, delante de la persona, y
 * queda anotado en esta atención. No frena nada: la atención sigue igual sin tocarlo.
 * Al tocar se abre la hoja firmada con el resumen y «Confirmar consentimiento».
 */
export function LinkSignedNotice({
  patientId,
  encounterId,
  disabled,
  onChanged,
}: {
  patientId: string
  encounterId: string
  disabled: boolean
  onChanged: () => void | Promise<void>
}): React.JSX.Element | null {
  const canWrite = usePermission("clinical.write")
  const pending = useQuery({
    queryKey: ["consents-to-confirm", patientId],
    queryFn: () => fetchLinkSignedToConfirm(patientId),
    enabled: canWrite,
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: openId !== null,
  })
  const rows = pending.data?.data ?? []
  const open = openId ? consents.data?.data.find((doc) => doc.id === openId) : undefined
  // El resumen sale de la fila por confirmar, que ya trae el documento abreviado.
  const openRow = openId ? rows.find((row) => row.id === openId) : undefined
  // Abierta la hoja, sigue a la vista aunque ya no quede nada por confirmar: ahí se ve que quedó firmado.
  if (!canWrite || (rows.length === 0 && !open)) return null
  const paper = open ? (
    <ConsentPaper
      document={open}
      confirmIn={encounterId}
      signedSummary={openRow ? linkSignedSummary(openRow) : null}
      onClose={() => setOpenId(null)}
      onChanged={async () => {
        await pending.refetch()
        await onChanged()
      }}
    />
  ) : null
  if (rows.length === 0) return paper
  return (
    <section
      aria-label="Firmado en su enlace, por confirmar"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4"
    >
      <p className="text-sm font-medium">
        {rows.length === 1
          ? "Firmó un consentimiento en su enlace"
          : `Firmó ${rows.length} consentimientos en su enlace`}
        : revísalo con la persona y confírmalo antes de empezar.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm">{row.title}</span>
              <span className="text-xs text-muted-foreground">{linkSignedSummary(row)}</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setOpenId(row.id)}
            >
              Revisar y confirmar
            </Button>
          </li>
        ))}
      </ul>
      {paper}
    </section>
  )
}
