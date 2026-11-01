import { Button } from "@odentia/ui"
import * as React from "react"
import { SurfaceShell } from "../surface.js"

export interface DetailSurfaceProps {
  title: string
  description?: string
  /** Contexto visual que permanece fijo mientras se desplaza el detalle. */
  headerContent?: React.ReactNode
  children: React.ReactNode
  /**
   * Acciones propias del detalle (Editar, Anular, Ver ficha completa…). Van a
   * la derecha del pie; sin acciones no hay pie.
   */
  actions?: React.ReactNode
  /**
   * Pie propio en lugar de la fila de acciones: lo que debe quedar siempre a
   * mano bajo el cuerpo que se desplaza (la caja de pregunta de Argos).
   */
  footer?: React.ReactNode
  /** Cierre ya protegido (ver `useCloseGuard`); lo aporta el contenedor. */
  onClose: () => void
  /**
   * El cierre como paso con nombre propio («Listo», «Volver a la
   * conversación»): además de la «×», va en el pie antes de las acciones.
   */
  closeLabel?: string
  /** `false` omite la «×» y deja el cierre a Esc o al gesto del drawer. */
  showClose?: boolean
  /** En carga, el esqueleto del shell reemplaza a `children`. */
  isLoading?: boolean
  error?: string | null
  /** Al abrir, el foco pasa al título (ver `SurfaceShell`). */
  focusTitle?: boolean
  /** El contenedor (región o dialog) toma su nombre accesible de estos ids. */
  titleId: string
  descriptionId: string
}

/**
 * Shell del detalle de lectura: cabecera fija, cuerpo con scroll interno y pie
 * con acciones. Es la versión sin formulario de `FormSurface` — mismo chrome
 * vía `SurfaceShell`, pero el root no es un `<form>` y el pie no tiene
 * Guardar/Cancelar, sino las acciones que la página decida (puede no tener
 * ninguna).
 *
 * El cuerpo es un contenedor de consulta (`@container`): las primitivas de
 * campos (`DetailList`) reparten en dos columnas según el ancho REAL de la
 * tarjeta o del drawer, no según el viewport. Eso es lo que permite que el
 * mismo contenido funcione en un panel de 24rem y en un drawer de 40rem.
 */
export function DetailSurface({
  title,
  description,
  headerContent,
  children,
  actions,
  footer,
  onClose,
  closeLabel,
  showClose = true,
  isLoading = false,
  error,
  focusTitle,
  titleId,
  descriptionId,
}: DetailSurfaceProps) {
  const namedClose = showClose && closeLabel != null
  const hasActions = namedClose || actions != null

  return (
    <SurfaceShell
      title={title}
      description={description}
      headerContent={headerContent}
      titleId={titleId}
      descriptionId={descriptionId}
      isLoading={isLoading}
      error={error}
      focusTitle={focusTitle}
      bodyClassName="@container"
      onClose={showClose ? onClose : undefined}
      footer={
        footer ??
        (hasActions ? (
          <>
            {namedClose ? (
              <Button type="button" variant="secondary" onClick={onClose}>
                {closeLabel}
              </Button>
            ) : null}
            {actions}
          </>
        ) : null)
      }
    >
      {children}
    </SurfaceShell>
  )
}