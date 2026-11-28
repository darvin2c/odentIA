import { cn } from "@odentia/ui"
import type * as React from "react"

export interface DetailSplitProps {
  /**
   * Lo que toca hacer (la acción, con su imagen y sus botones): a la derecha
   * con dos columnas, y primero cuando se apilan, porque es a lo que se vino.
   */
  aside: React.ReactNode
  /** Nombre accesible de `aside` («Lo que toca»): es una región aparte del resto. */
  asideLabel: string
  /** El resto del detalle (los pasos, lo que lleva, el saldo): a la izquierda. */
  children: React.ReactNode
  className?: string
}

/**
 * El cuerpo de un detalle en dos columnas (`DetailDrawer size="split"`): a la
 * izquierda el registro, a la derecha lo que toca, que se queda a la vista al
 * desplazar. Mide por contenedor (`@3xl`, 48rem), no por ventana: en el cajón
 * de 68rem se ve en dos columnas; en la columna lateral angosta y en el
 * teléfono se apila, con lo que toca arriba. El orden del documento es el de
 * la lectura apilada (lo que toca primero), así el teclado y el lector lo
 * encuentran antes en los dos casos.
 *
 * Necesita un ancestro `@container`: lo pone el cuerpo de `DetailSurface`.
 */
export function DetailSplit({ aside, asideLabel, children, className }: DetailSplitProps) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] @3xl:items-start",
        className,
      )}
    >
      <section
        aria-label={asideLabel}
        data-detail-aside=""
        className="flex min-w-0 flex-col gap-4 @3xl:sticky @3xl:top-0 @3xl:order-2 @3xl:rounded-xl @3xl:border @3xl:bg-card @3xl:p-4"
      >
        {aside}
      </section>
      <div className="flex min-w-0 flex-col gap-5 @3xl:order-1">{children}</div>
    </div>
  )
}
