import { Button } from "@odentia/ui"
import * as React from "react"
import { common } from "../common.js"
import { SurfaceShell } from "../surface.js"

export interface DetailSurfaceProps {
  title: string
  description?: string
  /** Contexto visual que permanece fijo mientras se desplaza el detalle. */
  headerContent?: React.ReactNode
  children: React.ReactNode
  /**
   * Acciones propias del detalle (Editar, Anular, Ver ficha completa…). Van a
   * la derecha del pie, después del botón de cierre.
   */
  actions?: React.ReactNode
  /** Cierre ya protegido (ver `useCloseGuard`); lo aporta el contenedor. */
  onClose: () => void
  closeLabel?: string
  /** `false` omite el botón Cerrar y deja el cierre a Esc o al gesto del drawer. */
  showClose?: boolean
  /** En carga, el esqueleto del shell reemplaza a `children`. */
  isLoading?: boolean
  error?: string | null
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
  onClose,
  closeLabel = common.actions.close,
  showClose = true,
  isLoading = false,
  error,
  titleId,
  descriptionId,
}: DetailSurfaceProps) {
  const hasFooter = showClose || actions != null

  return (
    <SurfaceShell
      title={title}
      description={description}
      headerContent={headerContent}
      titleId={titleId}
      descriptionId={descriptionId}
      isLoading={isLoading}
      error={error}
      bodyClassName="@container"
      footer={
        hasFooter ? (
          <>
            {showClose ? (
              <Button type="button" variant="secondary" onClick={onClose}>
                {closeLabel}
              </Button>
            ) : null}
            {actions}
          </>
        ) : null
      }
    >
      {children}
    </SurfaceShell>
  )
}