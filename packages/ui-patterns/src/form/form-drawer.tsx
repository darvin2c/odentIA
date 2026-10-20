import { cn, Drawer, DrawerContent, useIsMobile } from "@odentia/ui"
import * as React from "react"
import { SideDockScopeProvider } from "../side-dock.js"
import { DockedSurface, useDockDecision } from "../docked-surface.js"
import { useCloseGuard } from "../surface.js"
import { FormPanel } from "./form-panel.js"
import { type FormSecondaryAction, FormSurface } from "./form-surface.js"

export interface FormDrawerProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** Contexto visual que permanece fijo mientras se desplaza el formulario. */
  headerContent?: React.ReactNode
  children: React.ReactNode
  onSubmit: (event: React.FormEvent) => void
  isDirty?: boolean
  isSubmitting?: boolean
  isLoading?: boolean
  error?: string | null
  fieldErrors?: Record<string, string>
  submitLabel?: string
  cancelLabel?: string
  submitDisabled?: boolean
  hideSubmit?: boolean
  /**
   * Acción secundaria opcional del pie, entre «Cancelar» y la principal
   * («Guardar borrador»). Enter sigue haciendo la principal.
   */
  secondaryAction?: FormSecondaryAction
  /** Layout extra del panel (p. ej. ancho mayor para formularios extensos). */
  className?: string
  /**
   * `false`: siempre cajón modal, aunque haya columna lateral. Para lo que
   * exige decidir antes de seguir —anular, eliminar, revocar, reasignar—: no
   * debe quedarse abierto al lado mientras la página cambia por debajo.
   */
  dock?: boolean
}

/**
 * Quién abrió la superficie, anotado al renderizar la apertura: antes de que un
 * campo con `autoFocus` dentro del formulario tome el foco. Base UI lo mira
 * después y creería que lo abrió ese campo; al cerrar, el foco se perdería.
 */
function useOpener(open: boolean): React.RefObject<HTMLElement | null> {
  const opener = React.useRef<HTMLElement | null>(null)
  const wasOpen = React.useRef(false)
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  wasOpen.current = open
  return opener
}

/**
 * Drawer de formulario: cabecera fija, scroll interno y acciones persistentes
 * (shell compartido con `FormPanel` vía `FormSurface`). Es el contenedor modal —
 * overlay, focus-trap y Esc los aporta Base UI — y el único correcto donde no
 * hay lista que mantener a la vista.
 *
 * Con columna lateral en el layout y ventana ancha, el mismo formulario se abre
 * en esa columna (no modal, a todo el alto) en vez de en el cajón: lo decide
 * `useDockDecision` al abrir, con las reglas de `side-dock`. La pantalla no
 * cambia nada: sigue montando `FormDrawer`.
 */
export function FormDrawer({
  open,
  onClose,
  title,
  description,
  headerContent,
  children,
  onSubmit,
  isDirty = false,
  isSubmitting = false,
  isLoading = false,
  error,
  submitLabel,
  cancelLabel,
  submitDisabled = false,
  hideSubmit = false,
  secondaryAction,
  className,
  dock = true,
}: FormDrawerProps) {
  const isMobile = useIsMobile()
  const { handleClose, confirmDialog } = useCloseGuard({ isSubmitting, isDirty, onClose })
  const titleId = React.useId()
  const descriptionId = React.useId()
  const dockBounds = useDockDecision(open, { className, disabled: !dock })
  const opener = useOpener(open)

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
        className={cn(
          "data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem-env(safe-area-inset-top))] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]",
          className,
        )}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        finalFocus={() => (opener.current?.isConnected ? opener.current : true)}
      >
        <SideDockScopeProvider value="overlay">
          <FormSurface
            title={title}
            description={description}
            headerContent={headerContent}
            titleId={titleId}
            descriptionId={descriptionId}
            onCancel={handleClose}
            onSubmit={onSubmit}
            isSubmitting={isSubmitting}
            isLoading={isLoading}
            error={error}
            submitLabel={submitLabel}
            cancelLabel={cancelLabel}
            submitDisabled={submitDisabled}
            hideSubmit={hideSubmit}
            secondaryAction={secondaryAction}
          >
            {children}
          </FormSurface>
          {confirmDialog}
        </SideDockScopeProvider>
      </DrawerContent>
    </Drawer>
  )

  if (open && dockBounds) {
    return (
      <DockedSurface
        bounds={dockBounds}
        dirty={isDirty && !isSubmitting}
        fallback={drawer(true)}
      >
        <FormPanel
          title={title}
          description={description}
          headerContent={headerContent}
          onClose={onClose}
          onSubmit={onSubmit}
          isDirty={isDirty}
          isSubmitting={isSubmitting}
          isLoading={isLoading}
          error={error}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          submitDisabled={submitDisabled}
          hideSubmit={hideSubmit}
          secondaryAction={secondaryAction}
        >
          {children}
        </FormPanel>
      </DockedSurface>
    )
  }
  return drawer(open)
}
