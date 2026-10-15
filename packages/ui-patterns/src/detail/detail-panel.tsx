import { cn } from "@odentia/ui"
import * as React from "react"
import { useCloseGuard, useEscapeClose } from "../surface.js"
import { DetailSurface, type DetailSurfaceProps } from "./detail-surface.js"

export interface DetailContainerProps
  extends Omit<DetailSurfaceProps, "onClose" | "titleId" | "descriptionId"> {
  onClose: () => void
  /** Edición inline con cambios sin guardar: el cierre pregunta antes. */
  isDirty?: boolean
  /** Escritura en curso: el cierre se ignora mientras dure. */
  isSubmitting?: boolean
  /** Layout extra de la superficie (p. ej. ancho forzado del drawer). */
  className?: string
}

export type DetailPanelProps = DetailContainerProps

/**
 * Detalle en tarjeta lateral, no modal: vive en el flujo de la página —la
 * columna de `MasterDetail`— así la lista sigue visible mientras se consulta.
 * Mismo shell y mismas acciones que `DetailDrawer`; cambia el contenedor y, con
 * él, la semántica: sin overlay ni focus-trap, el cierre por Esc es propio y el
 * foco no se mueve solo al abrir.
 *
 * El ancho lo decide `MasterDetail` (`panelSize`); este componente solo llena
 * su columna. Se monta únicamente cuando la página decide mostrarlo: no tiene
 * prop `open`, y la página no debe montar `DetailPanel` y `DetailDrawer` a la
 * vez (duplicaría los `id` del contenido).
 */
export function DetailPanel({
  onClose,
  isDirty = false,
  isSubmitting = false,
  className,
  ...surface
}: DetailPanelProps) {
  const { handleClose, confirmDialog } = useCloseGuard({ isSubmitting, isDirty, onClose })
  const titleId = React.useId()
  const descriptionId = React.useId()

  useEscapeClose(handleClose)

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={surface.description ? descriptionId : undefined}
      className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-sm bg-card", className)}
    >
      <DetailSurface {...surface} titleId={titleId} descriptionId={descriptionId} onClose={handleClose} />
      {confirmDialog}
    </section>
  )
}