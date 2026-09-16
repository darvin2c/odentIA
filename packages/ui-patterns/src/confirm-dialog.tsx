import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@odentia/ui"
import { common } from "./common.js"
import { SubmitButton } from "./submit-button.js"

/**
 * Variante del botón de confirmación (mismo vocabulario que Button):
 * `destructive` para lo irreversible (eliminar), `default` para el resto
 * (archivar, desactivar, reimprimir...). El modal es agnóstico al caso.
 */
export type ConfirmVariant = "default" | "destructive"

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  variant?: ConfirmVariant
  pending?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * Confirmación de acciones terminales (archivar/eliminar/...): reemplaza a
 * `window.confirm` en toda la app. El servidor sigue siendo quien
 * rechaza con 409 si hay dependencias (mesas, cuentas, turnos).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = common.actions.cancel,
  variant = "destructive",
  pending = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <SubmitButton
            variant={variant}
            className={
              variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            pending={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
