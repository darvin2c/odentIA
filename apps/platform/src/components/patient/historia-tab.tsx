import { QuickNoteDrawer } from "./quick-note-drawer"
import { Timeline } from "./timeline"

export interface HistoriaTabProps {
  patientId: string
  initialTooth?: number
  onOdontogramSelect: (tooth: number) => void
}

/**
 * Historia clínica: visor cronológico de solo lectura (atenciones
 * finalizadas, notas, anamnesis, documentos y odontograma).
 * La atención se inicia desde la cabecera de la ficha; aquí no hay acción de
 * "nueva atención" para evitar duplicar vías de apertura.
 */
export function HistoriaTab({ patientId, initialTooth, onOdontogramSelect }: HistoriaTabProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <QuickNoteDrawer patientId={patientId} />
      </div>
      <Timeline
        patientId={patientId}
        initialTooth={initialTooth}
        onOdontogramSelect={onOdontogramSelect}
      />
    </div>
  )
}
