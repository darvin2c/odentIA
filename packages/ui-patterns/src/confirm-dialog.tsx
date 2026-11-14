import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@odentia/ui"
import { type ReactNode, useRef } from "react"
import { common } from "./common.js"
import { SubmitButton } from "./form/submit-button.js"

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
  /** Contenido entre la descripción y las acciones (p. ej. el motivo obligatorio). */
  children?: ReactNode
  /** Bloquea la confirmación hasta completar lo que el contrato exige. */
  confirmDisabled?: boolean
  /** Por qué no se pudo: aparte de la descripción, para que no se lea como parte de ella. */
  error?: string | null
  onConfirm: () => void
  onClose: () => void
}

/**
 * Confirmación de acciones terminales (archivar/eliminar/...): reemplaza a
 * `window.confirm` en toda la app. El servidor sigue siendo quien
 * rechaza con 409 si hay dependencias (mesas, cuentas, turnos). También es la
 * pregunta de cerrar un formulario o detalle con cambios (`useCloseGuard`).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = common.actions.cancel,
  variant = "destructive",
  pending = false,
  children,
  confirmDisabled = false,
  error = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  // En el ancho chico los dos botones van en columnas iguales: un texto largo
  // («Anotar que acepta todo») se cortaba. Con texto largo, el ancho normal.
  const size = confirmLabel.length > 16 || cancelLabel.length > 16 ? "default" : "sm"
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <AlertDialogContent size={size}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children ? <div className="flex flex-col gap-3">{children}</div> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <SubmitButton
            variant={variant}
            className={
              variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90"
                : undefined
            }
            pending={pending}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface UnsavedDialogProps {
  open: boolean
  /**
   * Qué se pierde de verdad, en palabras de quien decide («No se guardó «15» en
   * «Intensidad del dolor (0–10)». Lo demás ya está guardado.»). Sin él, el texto común.
   */
  lost?: string | null
  /** «Seguir aquí», Escape o el clic fuera: no se sale y no se pierde nada. */
  onStay: () => void
  /** «Descartar y salir». */
  onDiscard: () => void
  /** A dónde vuelve el foco al quedarse (el campo que se estaba editando); `false`, a quien la abrió. */
  finalFocus?: () => HTMLElement | boolean | null
}

/**
 * La pregunta de «salir sin guardar», la misma para cerrar un formulario o un
 * detalle (×, Escape, «Cancelar») y para salir a otra pantalla con algo sin
 * guardar en la página o en el panel lateral. Dice lo que se pierde y su
 * acción principal es quedarse: es la que no pierde nada, y la que recibe el
 * foco. «Descartar y salir» va aparte, en rojo.
 */
export function UnsavedDialog({ open, lost, onStay, onDiscard, finalFocus }: UnsavedDialogProps) {
  const stay = useRef<HTMLButtonElement>(null)
  const words = common.confirm.unsaved
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay()
      }}
    >
      <AlertDialogContent size="sm" initialFocus={stay} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{words.title}</AlertDialogTitle>
          <AlertDialogDescription>{lost || words.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="destructive" onClick={onDiscard}>
            {words.discard}
          </Button>
          <AlertDialogCancel ref={stay} variant="default">
            {words.keepEditing}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
