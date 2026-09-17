import { Button, ScrollArea, Skeleton } from "@odentia/ui"
import * as React from "react"
import { common } from "../common.js"
import { SubmitButton } from "./submit-button.js"

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
}

/**
 * Shell visual del formulario: cabecera fija, cuerpo con scroll interno y
 * acciones persistentes. No decide DÓNDE vive (drawer modal o panel lateral):
 * eso lo aportan `FormDrawer` y `FormPanel`, que comparten este shell para que
 * el mismo formulario se vea idéntico en los dos modos.
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
}: FormSurfaceProps) {
  return (
    <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-6 py-4 text-left">
        <h2 id={titleId} className="font-heading text-base font-medium text-foreground">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="text-sm text-balance text-muted-foreground">
            {description}
          </p>
        ) : null}
        {headerContent}
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="px-6 py-4">
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <>
                {error ? (
                  <div
                    className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
                    role="alert"
                  >
                    {error}
                  </div>
                ) : null}
                {children}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="mt-auto flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border bg-surface px-6 py-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
          {cancelLabel}
        </Button>
        {!hideSubmit && (
          <SubmitButton
            type="submit"
            variant="default"
            pending={isSubmitting}
            disabled={isLoading || submitDisabled}
          >
            {submitLabel}
          </SubmitButton>
        )}
      </div>
    </form>
  )
}

export interface CloseGuardOptions {
  isSubmitting?: boolean
  isDirty?: boolean
  onClose: () => void
}

/**
 * Cierre protegido compartido: no interrumpe un envío en curso y pregunta antes
 * de descartar cambios sin guardar. Lo usan el drawer (onOpenChange y Esc de
 * Base UI) y el panel (Esc propio) para comportarse igual en los dos modos.
 */
export function useCloseGuard({
  isSubmitting = false,
  isDirty = false,
  onClose,
}: CloseGuardOptions) {
  return React.useCallback(() => {
    if (isSubmitting) return
    if (isDirty && !window.confirm(common.confirm.unsavedMessage)) return
    onClose()
  }, [isSubmitting, isDirty, onClose])
}
