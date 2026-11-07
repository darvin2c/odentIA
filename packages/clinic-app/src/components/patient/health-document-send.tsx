import type { HealthDocumentType } from "../../lib/encounter-documents"
import { DocumentSendDrawer } from "../finance-documents/SendFinancialDocument"

/**
 * «Enviar» de un papel de salud (receta, orden, descanso, hoja de atención,
 * consentimiento firmado): el mismo cajón que el comprobante (ADR 0152). Va solo
 * a la propia persona o a su representante legal, por WhatsApp o por correo;
 * le llega el PDF, también pasadas las 24 horas con el mensaje aprobado para
 * documentos. Si nada sirve, se imprime. Lo enviado queda encolado en su
 * conversación: no se dice entregado.
 */
export function HealthDocumentSendDrawer({
  open,
  patientId,
  documentType,
  documentId,
  onClose,
}: {
  open: boolean
  patientId: string
  documentType: HealthDocumentType
  documentId: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <DocumentSendDrawer
      open={open}
      patientId={patientId}
      source={{ kind: "health", documentType }}
      documentId={documentId}
      onClose={onClose}
    />
  )
}
