import { cn } from "@odentia/ui"
import * as React from "react"

/**
 * Primitivas de contenido para un detalle de lectura. Existen porque el mismo
 * par etiqueta/valor estaba escrito en seis archivos con cuatro estilos
 * distintos (tamaño de etiqueta, ancho fijo, mayúsculas). Usan `<dl>/<dt>/<dd>`
 * —semántica de lista de descripción, no `div`s— y miden por contenedor
 * (`@sm`/`@lg`), nunca por viewport: el mismo bloque se usa en una tarjeta de
 * 24rem y en un drawer de 40rem.
 *
 * El contenedor de consulta lo aporta `DetailSurface` (su cuerpo es
 * `@container`); sin un ancestro así, `DetailList` cae a una columna.
 */

export interface DetailSectionProps {
  /** Título de la sección; sin él, la sección es solo un bloque de campos. */
  title?: string
  /** Acciones propias de la sección, alineadas a la derecha del título. */
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/** Bloque con título opcional: agrupa campos y listas dentro del detalle. */
export function DetailSection({ title, actions, children, className }: DetailSectionProps) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      {title != null || actions != null ? (
        <div className="flex min-w-0 items-center gap-2">
          {title != null ? (
            <h3 className="font-heading text-sm font-medium text-foreground">{title}</h3>
          ) : null}
          {actions != null ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export interface DetailListProps {
  children: React.ReactNode
  /**
   * `2` (predeterminado) reparte en dos columnas cuando el contenedor pasa
   * 32rem; `1` mantiene una sola columna siempre.
   */
  columns?: 1 | 2
  className?: string
}

/** Lista de campos (`dl`). Usar `DetailField` como hijo directo. */
export function DetailList({ children, columns = 2, className }: DetailListProps) {
  return (
    <dl
      className={cn(
        "grid min-w-0 gap-x-6 gap-y-3",
        columns === 2 && "@lg:grid-cols-2",
        className,
      )}
    >
      {children}
    </dl>
  )
}

export interface DetailFieldProps {
  label: React.ReactNode
  /**
   * Valor. Vacío (`null`, `undefined` o cadena vacía) se muestra como `—` en
   * tono apagado, que es la convención del repo para «sin dato».
   */
  children?: React.ReactNode
  className?: string
}

/** Par etiqueta/valor de lectura. Debe ir dentro de `DetailList` (`dl`). */
export function DetailField({ label, children, className }: DetailFieldProps) {
  const isEmpty = children == null || children === ""

  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">
        {isEmpty ? <span className="text-muted-foreground">—</span> : children}
      </dd>
    </div>
  )
}