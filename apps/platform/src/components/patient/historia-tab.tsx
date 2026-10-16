import { QuickNoteDrawer } from "./quick-note-drawer"
import { Timeline } from "./timeline"

export interface HistoriaTabProps {
  patientId: string
  initialTooth?: number
  onOdontogramSelect: (tooth: number) => void
}

/**
 * Historia, «qué pasó y cuándo» (ADR 0035): visor cronológico de solo lectura
 * con las atenciones (también las anuladas, con su motivo), las notas
 * clínicas, la anamnesis, el odontograma, el plan y los papeles como hechos.
 * La atención se inicia desde la cabecera de la página; aquí solo la ofrece el
 * vacío.
 */
export function HistoriaTab({ patientId, initialTooth, onOdontogramSelect }: HistoriaTabProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Qué pasó y cuándo</p>
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
