import { Button } from "@odentia/ui"
import * as React from "react"
import { common } from "../common.js"
import { SurfaceShell } from "../surface.js"
import { SubmitButton } from "./submit-button.js"

/**
 * Otra forma de guardar lo mismo («Guardar borrador» junto a «Confirmar
 * pedido»). Va en el pie entre «Cancelar» y la acción principal, que sigue
 * siendo la de Enter (el envío del formulario): esta es un `type="button"`.
 */
export interface FormSecondaryAction {
  label: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
}

export interface FormSurfaceProps {
  title: string
  description?: string
  /** Contexto visual que permanece fijo mientras se desplaza el formulario. */
  headerContent?: React.ReactNode
  children: React.ReactNode
  onSubmit: (event: React.FormEvent) => void
  /** Cierre ya protegido (ver `useCloseGuard`); lo aporta el contenedor. */
  onCancel: () => void
  /** El contenedor (dialog o región) toma su nombre accesible de estos ids. */
  titleId: string
  descriptionId: string
  isSubmitting?: boolean
  isLoading?: boolean
  error?: string | null
  submitLabel?: string
  cancelLabel?: string
  submitDisabled?: boolean
  hideSubmit?: boolean
  /** Acción secundaria opcional del pie; se desactiva mientras se envía. */
  secondaryAction?: FormSecondaryAction
}

/**
 * Shell del formulario: cabecera fija, cuerpo con scroll interno y acciones
 * persistentes (Cancelar, una secundaria opcional y Guardar). No decide DÓNDE vive (drawer modal o
 * panel lateral): eso lo aportan `FormDrawer` y `FormPanel`, que comparten este
 * shell para que el mismo formulario se vea idéntico en los dos modos. El
 * chrome común con el detalle de lectura vive en `SurfaceShell`.
 */
export function FormSurface({
  title,
  description,
  headerContent,
  children,
  onSubmit,
  onCancel,
  titleId,
  descriptionId,
  isSubmitting = false,
  isLoading = false,
  error,
  submitLabel = common.actions.save,
  cancelLabel = common.actions.cancel,
  submitDisabled = false,
  hideSubmit = false,
  secondaryAction,
}: FormSurfaceProps) {
  return (
    <SurfaceShell
      title={title}
      description={description}
      headerContent={headerContent}
      titleId={titleId}
      descriptionId={descriptionId}
      isLoading={isLoading}
      error={error}
      onSubmit={onSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {cancelLabel}
          </Button>
          {secondaryAction ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={secondaryAction.onClick}
              disabled={isSubmitting || isLoading || secondaryAction.disabled}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
          {!hideSubmit && (
            <SubmitButton
              type="submit"
              variant="default"
              className="min-h-11"
              pending={isSubmitting}
              disabled={isLoading || submitDisabled}
            >
              {submitLabel}
            </SubmitButton>
          )}
        </>
      }
    >
      {children}
    </SurfaceShell>
  )
}
