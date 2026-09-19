import { Drawer, DrawerContent, useIsMobile } from "@odentia/ui"
import * as React from "react"
import { useCloseGuard } from "../surface.js"
import { FormSurface } from "./form-surface.js"

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
  /** Layout extra del panel (p. ej. ancho mayor para formularios extensos). */
  className?: string
}

/**
 * Drawer de formulario: cabecera fija, scroll interno y acciones persistentes
 * (shell compartido con `FormPanel` vía `FormSurface`). Es el contenedor modal —
 * overlay, focus-trap y Esc los aporta Base UI — y el único correcto donde no
 * hay lista que mantener a la vista.
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
  className,
}: FormDrawerProps) {
  const isMobile = useIsMobile()
  const handleClose = useCloseGuard({ isSubmitting, isDirty, onClose })
  const titleId = React.useId()
  const descriptionId = React.useId()

  return (
    <Drawer
      open={open}
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
        className={className}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
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
        >
          {children}
        </FormSurface>
      </DrawerContent>
    </Drawer>
  )
}
