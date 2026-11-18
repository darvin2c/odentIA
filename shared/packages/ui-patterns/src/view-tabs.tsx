import { cn, Tabs, TabsTrigger } from "@odentia/ui"
import type * as React from "react"
import { ScrollingTabsList } from "./scrolling-tabs-list.js"

/**
 * Una sola vista a la vez de la misma lista («Mías y de mi área», «Vencidas»,
 * «Hechas»…): el mismo control que Pacientes. Un botón suelto con «pulsado»
 * para elegir vista no se usa; tampoco un filtro que se combina con otros, que
 * va en `FilterBar`.
 *
 * `count` dice cuánto hay en esa vista y va después del nombre con «·»; sin
 * número no se dibuja. El texto de cada pestaña es su nombre accesible.
 */
export interface ViewTabOption<T extends string> {
  value: T
  label: string
  count?: number
  icon?: React.ReactNode
  disabled?: boolean
}

export interface ViewTabsProps<T extends string> {
  /** Nombre accesible del grupo, por ejemplo «Qué tareas ver». */
  label: string
  value: T
  options: ReadonlyArray<ViewTabOption<T>>
  onValueChange: (value: T) => void
  className?: string
}

export function ViewTabs<T extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
}: ViewTabsProps<T>): React.JSX.Element {
  return (
    <Tabs className={cn("min-w-0 max-w-full", className)} value={value} onValueChange={(next) => onValueChange(next as T)}>
      <ScrollingTabsList aria-label={label}>
        {options.map((option) => (
          <TabsTrigger
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className={cn("shrink-0 min-h-11 sm:min-h-9", option.icon && "max-md:px-3")}
          >
            {option.icon}
            {/* Con icono, el nombre se ve desde tableta; en el teléfono queda solo el icono, con su nombre accesible. */}
            {option.icon ? <span className="max-md:sr-only">{option.label}</span> : option.label}
            {option.count !== undefined ? <span className="tabular-nums"> · {option.count}</span> : null}
          </TabsTrigger>
        ))}
      </ScrollingTabsList>
    </Tabs>
  )
}
