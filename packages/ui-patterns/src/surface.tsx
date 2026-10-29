import { Button, cn, ScrollArea, Skeleton } from "@odentia/ui"
import * as React from "react"
import { common } from "./common.js"
import { ConfirmDialog } from "./confirm-dialog.js"

/**
 * Chrome compartido por las dos familias de superficies laterales: el
 * formulario (`FormSurface`) y el detalle de lectura (`DetailSurface`). Fija
 * lo que debe verse igual en panel y en drawer —cabecera, cuerpo con scroll y
 * acciones persistentes— y también el cierre protegido de los contenedores
 * (`useCloseGuard`, `useEscapeClose`), que es la otra mitad del mismo
 * comportamiento.
 *
 * No decide DÓNDE vive la superficie (tarjeta en el flujo o popup modal): eso
 * lo aportan los contenedores (`FormPanel`/`FormDrawer`, `DetailPanel`/
 * `DetailDrawer`).
 */

/** El root es una columna que llena su contenedor y recorta el cuerpo. */
const SURFACE_ROOT_CLASS = "flex h-full min-h-0 flex-1 flex-col overflow-hidden"

export interface SurfaceShellProps {
  title: string
  description?: string
  /** Contexto visual que permanece fijo mientras se desplaza el cuerpo. */
  headerContent?: React.ReactNode
  children: React.ReactNode
  /** El contenedor (dialog, panel o región) toma su nombre accesible de estos ids. */
  titleId: string
  descriptionId: string
  isLoading?: boolean
  error?: string | null
  /**
   * Acciones del pie. `null` (predeterminado) omite la barra por completo: un
   * detalle sin acciones ni cierre visible no necesita pie.
   */
  footer?: React.ReactNode
  /** Clases del envoltorio del cuerpo (p. ej. `@container` para el detalle). */
  bodyClassName?: string
  /**
   * Con `onSubmit` el root es un `<form>` y el pie lleva acciones de envío; sin
   * él es un `<div>` y el pie solo contiene botones `type="button"`. La forma
   * del root es una consecuencia de la superficie, no una prop aparte. El envío
   * nativo se cancela siempre aquí: quien la usa no tiene que acordarse.
   */
  onSubmit?: (event: React.FormEvent) => void
  /**
   * Cierre de la cabecera: la «×» arriba a la derecha, la misma en panel,
   * cajón y hoja del teléfono. Sin él no hay «×» (la superficie que obliga a
   * decidir antes de seguir).
   */
  onClose?: () => void
  /** La «×» no responde mientras se guarda. */
  closeDisabled?: boolean
}

/**
 * Cabecera fija con la «×», cuerpo con scroll interno y pie opcional. El
 * contenido de `children` no se monta mientras `isLoading` (el esqueleto lo
 * reemplaza) y el error va en un banner `role="alert"` por encima del contenido.
 */
export function SurfaceShell({
  title,
  description,
  headerContent,
  children,
  titleId,
  descriptionId,
  isLoading = false,
  error,
  footer,
  bodyClassName,
  onSubmit,
  onClose,
  closeDisabled = false,
}: SurfaceShellProps) {
  const blocks = (
    <>
      <div className="flex shrink-0 flex-col gap-1 border-b border-border py-4 pr-3 pl-6 text-left">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <h2 id={titleId} className="font-heading text-base font-medium text-foreground">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-balance text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="-mt-0.5 shrink-0"
              aria-label={common.actions.close}
              disabled={closeDisabled}
              onClick={onClose}
            >
              <span aria-hidden className="text-lg leading-none">
                ×
              </span>
            </Button>
          ) : null}
        </div>
        {headerContent ? <div className="pr-3">{headerContent}</div> : null}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-hidden", bodyClassName)}>
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

      {/* Si las acciones no caben en una fila (tres en el teléfono), bajan a
          la siguiente en vez de cortarse; la última, la principal, queda al
          final y a la derecha. */}
      {footer != null ? (
        <div className="mt-auto flex shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {footer}
        </div>
      ) : null}
    </>
  )

  if (onSubmit) {
    return (
      <form
        onSubmit={(event) => {
          // Sin esto el navegador envía el formulario y recarga la página: el
          // guardado queda a medias y su error no llega a verse.
          event.preventDefault()
          onSubmit(event)
        }}
        className={SURFACE_ROOT_CLASS}
      >
        {blocks}
      </form>
    )
  }

  return <div className={SURFACE_ROOT_CLASS}>{blocks}</div>
}

export interface CloseGuardOptions {
  isSubmitting?: boolean
  isDirty?: boolean
  onClose: () => void
}

export interface CloseGuard {
  /** Cierre protegido: el botón Cerrar/Cancelar, el Esc y el clic fuera pasan por aquí. */
  handleClose: () => void
  /**
   * La pregunta «¿Salir sin guardar?». El contenedor la monta DENTRO de su
   * superficie (en el cajón, dentro del popup): así Base UI la trata como un
   * diálogo anidado y ni el foco atrapado ni el clic fuera del cajón chocan
   * con ella.
   */
  confirmDialog: React.ReactNode
}

/**
 * Cierre protegido compartido: no interrumpe un envío en curso y pregunta antes
 * de descartar cambios sin guardar. Lo usan el drawer (onOpenChange y Esc de
 * Base UI) y el panel (Esc propio) para comportarse igual en los dos modos.
 *
 * La pregunta es la confirmación propia de la interfaz (`ConfirmDialog`), no
 * la del navegador: lleva el foco al diálogo y, al seguir editando, Base UI lo
 * devuelve a donde estaba (el campo o el botón que pidió cerrar).
 */
export function useCloseGuard({
  isSubmitting = false,
  isDirty = false,
  onClose,
}: CloseGuardOptions): CloseGuard {
  const [asking, setAsking] = React.useState(false)
  const handleClose = React.useCallback(() => {
    if (isSubmitting) return
    if (isDirty) {
      setAsking(true)
      return
    }
    onClose()
  }, [isSubmitting, isDirty, onClose])

  const confirmDialog = (
    <ConfirmDialog
      open={asking}
      title={common.confirm.unsaved.title}
      description={common.confirm.unsaved.description}
      cancelLabel={common.confirm.unsaved.keepEditing}
      confirmLabel={common.confirm.unsaved.discard}
      onClose={() => setAsking(false)}
      onConfirm={() => {
        setAsking(false)
        onClose()
      }}
    />
  )

  return { handleClose, confirmDialog }
}

// Base UI monta el popup de dialog/drawer/alert-dialog mientras está abierto;
// con uno encima, el Esc le pertenece a ese popup y no al panel.
export const OPEN_POPUP_SELECTOR = "[role='dialog'],[role='alertdialog'],[data-slot='drawer-popup']"

/**
 * Esc propio de una superficie no modal (el panel). El drawer no lo usa: ahí
 * el Esc lo aporta Base UI sobre el popup, que ya tiene el foco.
 */
export function useEscapeClose(handleClose: () => void) {
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector(OPEN_POPUP_SELECTOR)) return
      handleClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [handleClose])
}
