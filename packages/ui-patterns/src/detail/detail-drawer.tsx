import { Drawer, DrawerContent, cn, useIsMobile } from "@odentia/ui"
import * as React from "react"
import { SideDockScopeProvider, useSideDockDraftGuard } from "../side-dock.js"
import { DockedSurface, DraftSavedProvider, useDockDecision, useDraftSavedScope } from "../docked-surface.js"
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
  /**
   * `false`: siempre cajón modal, aunque haya columna lateral (como en
   * `FormDrawer`). Para abrirlo encima de un diálogo: la columna lateral queda
   * detrás del diálogo y no se podría usar.
   */
  dock?: boolean
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
  lost: given,
  onDiscard: discardGiven,
  size = "md",
  dock = true,
  className,
  ...surface
}: DetailDrawerProps) {
  const isMobile = useIsMobile()
  // Lo que el contenido guarda solo (`useDraftSaved`): ×, Escape y el menú preguntan igual.
  const draft = useDraftSavedScope()
  const dirty = isDirty || draft.unsaved
  const lost = given ?? (draft.unsaved && !isDirty ? draft.lost : null)
  const onDiscard = () => {
    draft.discard()
    discardGiven?.()
  }
  const { handleClose, confirmDialog } = useCloseGuard({ isSubmitting, isDirty: dirty, lost, onDiscard, onClose })
  const DraftGuard = useSideDockDraftGuard()
  const titleId = React.useId()
  const descriptionId = React.useId()
  const dockBounds = useDockDecision(open, { bounds: DOCK_SIZES[size], disabled: !dock })

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
      {/* En el teléfono baja desde abajo con un alto fijo, como `FormDrawer`: sin él, el cuerpo
          no tiene contra qué medirse y lo de abajo (Reprogramar, Anular) queda fuera sin desplazarse. */}
      <DrawerContent
        className={cn(
          "data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-6rem)]",
          DRAWER_WIDTH[size],
          className,
        )}
        aria-labelledby={titleId}
        aria-describedby={surface.description ? descriptionId : undefined}
      >
        <SideDockScopeProvider value="overlay">
          <DraftSavedProvider scope={draft}>
            <DetailSurface {...surface} titleId={titleId} descriptionId={descriptionId} onClose={handleClose} />
          </DraftSavedProvider>
          {confirmDialog}
          {/* En el cajón (el teléfono), «Atrás» del navegador también pregunta por lo que no se guardó. */}
          {DraftGuard && draft.unsaved ? <DraftGuard dirty lost={lost} onDiscard={onDiscard} /> : null}
        </SideDockScopeProvider>
      </DrawerContent>
    </Drawer>
  )

  // Con columna lateral y ventana ancha, el detalle va ahí (ver `FormDrawer`).
  if (open && dockBounds) {
    return (
      <DockedSurface bounds={dockBounds} dirty={isDirty && !isSubmitting} fallback={drawer(true)} draft={draft}>
        <DetailPanel
          {...surface}
          onClose={onClose}
          isDirty={dirty}
          lost={lost}
          onDiscard={onDiscard}
          isSubmitting={isSubmitting}
        />
      </DockedSurface>
    )
  }
  return drawer(open)
}