import { Drawer, DrawerContent, cn, useIsMobile } from "@odentia/ui"
import * as React from "react"
import { SideDockScopeProvider } from "../side-dock.js"
import { DockedSurface, useDockDecision } from "../docked-surface.js"
import { DOCK_SIZES, type DetailPanelSize } from "../master-detail.js"
import { useCloseGuard } from "../surface.js"
import { DetailSurface } from "./detail-surface.js"
import { type DetailContainerProps, DetailPanel } from "./detail-panel.js"

/**
 * Ancho del drawer por tamaño. `md` no fija nada: el drawer ya mide 24rem desde
 * `sm` (y 75% del viewport por debajo), el mismo ancho que el panel `md`. Los
 * demás replican los default de `MasterDetail` para que el detalle no cambie de
 * ancho al cruzar el corte de 1280px. Van literales porque Tailwind lee texto.
 */
const DRAWER_WIDTH: Record<DetailPanelSize, string> = {
  md: "",
  lg: "data-[swipe-axis=x]:sm:[--drawer-content-width:min(32rem,calc(100vw-2rem))]",
  xl: "data-[swipe-axis=x]:sm:[--drawer-content-width:min(40rem,calc(100vw-2rem))]",
}

export interface DetailDrawerProps extends DetailContainerProps {
  open: boolean
  /** Ancho del panel de referencia: mantiene el tamaño al cruzar el corte. */
  size?: DetailPanelSize
}

/**
 * Detalle en drawer modal: overlay, focus-trap, Esc y swipe los aporta Base UI
 * (en móvil baja desde abajo con asa). Es el contenedor correcto cuando no hay
 * lista que mantener a la vista —o cuando el ancho no da para la columna
 * lateral—, y el fallback natural de `Detail`.
 */
export function DetailDrawer({
  open,
  onClose,
  isDirty = false,
  isSubmitting = false,
  size = "md",
  className,
  ...surface
}: DetailDrawerProps) {
  const isMobile = useIsMobile()
  const handleClose = useCloseGuard({ isSubmitting, isDirty, onClose })
  const titleId = React.useId()
  const descriptionId = React.useId()
  const dockBounds = useDockDecision(open, { bounds: DOCK_SIZES[size] })

  const drawer = (drawerOpen: boolean) => (
    <Drawer
      open={drawerOpen}
      swipeDirection={isMobile ? "down" : "right"}
      showSwipeHandle={isMobile}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose()
      }}
    >
      {/* Sin `DrawerTitle` dentro (el `h2` lo pone el shell compartido), el
          nombre accesible del diálogo se cablea a mano: las props propias
          ganan sobre las que Base UI deriva del Title. */}
      <DrawerContent
        className={cn(DRAWER_WIDTH[size], className)}
        aria-labelledby={titleId}
        aria-describedby={surface.description ? descriptionId : undefined}
      >
        <SideDockScopeProvider value="overlay">
          <DetailSurface {...surface} titleId={titleId} descriptionId={descriptionId} onClose={handleClose} />
        </SideDockScopeProvider>
      </DrawerContent>
    </Drawer>
  )

  // Con columna lateral y ventana ancha, el detalle va ahí (ver `FormDrawer`).
  if (open && dockBounds) {
    return (
      <DockedSurface bounds={dockBounds} dirty={isDirty && !isSubmitting} fallback={drawer(true)}>
        <DetailPanel {...surface} onClose={onClose} isDirty={isDirty} isSubmitting={isSubmitting} />
      </DockedSurface>
    )
  }
  return drawer(open)
}