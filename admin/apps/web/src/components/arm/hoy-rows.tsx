import type { ClinicalProduct } from "@odentia/clinical"
import { Badge } from "@odentia/ui"
import type { ReactNode, Ref } from "react"
import { ProductMark } from "../product"

/**
 * Las piezas de las filas de Hoy (el molde de Inicio de #591): una sección con
 * su título y su número, y filas con nombre, una línea y su botón.
 */

/** Una frase con su parte en rojo: el rojo es solo para lo vencido y lo de hoy. */
export interface Said {
  text: string
  urgent: boolean
}

/** Partes de una línea, separadas por «·», con su rojo donde toca (y la palabra lo dice). */
export function Line({ parts }: { parts: (string | Said | null | undefined)[] }) {
  const shown = parts.filter(
    (part): part is string | Said => part !== null && part !== undefined && part !== "",
  )
  return (
    <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
      {shown.map((part, index) => {
        const said = typeof part === "string" ? { text: part, urgent: false } : part
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: las partes de una frase no cambian de lugar.
          <span key={index}>
            {index > 0 ? " · " : null}
            <span className={said.urgent ? "font-medium text-destructive" : undefined}>
              {said.text}
            </span>
          </span>
        )
      })}
    </p>
  )
}

/** Una fila con nombre: quién, una línea (o dos) y sus botones. */
export function HomeRow({
  name,
  product,
  children,
  action,
  rowRef,
}: {
  name: ReactNode
  product: ClinicalProduct | null
  children: ReactNode
  action: ReactNode
  /** Para `useFocusOnLeave`: la fila que se va al cerrarla deja el foco en su vecina. */
  rowRef?: Ref<HTMLLIElement>
}) {
  return (
    <li ref={rowRef} className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium [overflow-wrap:anywhere]">
          {name}
          {product ? <ProductMark product={product} /> : null}
        </p>
        {children}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </li>
  )
}

export function HomeSection({
  id,
  title,
  count,
  more,
  lead,
  note,
  children,
}: {
  id: string
  title: ReactNode
  count?: number
  more?: ReactNode
  lead?: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
          {title}
        </h2>
        {count !== undefined ? (
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        ) : null}
        {more ? <span className="ml-auto text-sm">{more}</span> : null}
      </div>
      {/* Un div: la entrada puede traer controles (las pestañas Mías | Todas), que no van dentro de un párrafo. */}
      {lead ? <div className="text-sm text-muted-foreground">{lead}</div> : null}
      {children}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </section>
  )
}

export const moreLink =
  "text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"

/** Una lista de filas en su tarjeta. */
export function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y rounded-xl border bg-card">{children}</ul>
}
