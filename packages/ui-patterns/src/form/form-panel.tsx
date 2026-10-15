import { cn } from "@odentia/ui"
import * as React from "react"
import { useCloseGuard, useEscapeClose } from "../surface.js"
import { FormSurface } from "./form-surface.js"

export interface FormPanelProps {
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
  submitLabel?: string
  cancelLabel?: string
  submitDisabled?: boolean
  hideSubmit?: boolean
  /** Layout extra de la tarjeta (p. ej. ancho forzado). */
  className?: string
}

/**
 * Formulario en tarjeta lateral, no modal: vive en el flujo de la página (ver
 * `MasterDetail`) en vez de flotar sobre ella, así la tabla sigue visible
 * mientras se edita. Mismo shell y mismas acciones que `FormDrawer`; cambia el
 * contenedor y, con él, la semántica: sin overlay ni focus-trap, el cierre por
 * Esc es propio y el foco no se mueve solo al abrir.
 *
 * Se monta solo cuando la página decide mostrarlo: no tiene prop `open`, y la
 * página no debe montar `FormPanel` y `FormDrawer` a la vez (duplicaría los
 * `id`/`htmlFor` de los campos).
 */
export function FormPanel({
  onClose,
  isDirty = false,
  isSubmitting = false,
  className,
  title,
  description,
  headerContent,
  children,
  onSubmit,
  isLoading = false,
  error,
  submitLabel,
  cancelLabel,
  submitDisabled = false,
  hideSubmit = false,
}: FormPanelProps) {
  const { handleClose, confirmDialog } = useCloseGuard({ isSubmitting, isDirty, onClose })
  const titleId = React.useId()
  const descriptionId = React.useId()

  useEscapeClose(handleClose)

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-sm bg-card", className)}
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
      {confirmDialog}
    </section>
  )
}
