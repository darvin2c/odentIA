import { cn } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"

/**
 * Pocas opciones, todas a la vista: un grupo de botones en vez de una lista
 * desplegable. Se elige una con un toque o con las flechas del teclado. `tone`
 * «primary» marca con el color de la marca lo elegido cuando la elección
 * cambia lo que sigue; «neutral», cuando solo es un dato. Con `columns` las
 * opciones ocupan celdas iguales (textos largos o muchas opciones) en vez de
 * ir una detrás de otra. Con `onClear`, tocar otra vez lo elegido lo desmarca
 * (el examen por sistemas vuelve a «No examinado»).
 */
export function ChoiceButtons<T extends string>({
  value,
  options,
  onChange,
  onClear,
  label,
  tone = "neutral",
  columns,
  disabled = false,
  className,
}: {
  value: T | null
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  /** Tocar otra vez lo elegido lo desmarca; sin él, lo elegido se queda. */
  onClear?: () => void
  /** Nombre accesible del grupo cuando no lo da una etiqueta visible. */
  label: string
  tone?: "neutral" | "primary"
  columns?: 2 | 3 | 4
  disabled?: boolean
  className?: string
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={value ? [value] : []}
      onValueChange={(next: unknown[]) => {
        const picked = next[0]
        if (typeof picked === "string") onChange(picked as T)
        else onClear?.()
      }}
      disabled={disabled}
      spacing={1}
      className={cn(
        "max-w-full rounded-3xl bg-muted p-1",
        columns ? "grid w-full" : "flex-wrap",
        columns === 2 && "grid-cols-2",
        columns === 3 && "grid-cols-3",
        columns === 4 && "grid-cols-4",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={itemClass(Boolean(columns), tone)}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Lo mismo, pero se pueden marcar varias (por ejemplo, los hábitos). */
export function MultiChoiceButtons<T extends string>({
  value,
  options,
  onChange,
  label,
  columns,
  disabled = false,
  className,
}: {
  value: readonly T[]
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T[]) => void
  label: string
  columns?: 2 | 3 | 4
  disabled?: boolean
  className?: string
}) {
  return (
    <ToggleGroup
      aria-label={label}
      multiple
      value={[...value]}
      onValueChange={(next: unknown[]) =>
        onChange(next.filter((item): item is T => typeof item === "string"))
      }
      disabled={disabled}
      spacing={1}
      className={cn(
        "max-w-full rounded-3xl bg-muted p-1",
        columns ? "grid w-full" : "flex-wrap",
        columns === 2 && "grid-cols-2",
        columns === 3 && "grid-cols-3",
        columns === 4 && "grid-cols-4",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={itemClass(Boolean(columns), "neutral")}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function itemClass(columns: boolean, tone: "neutral" | "primary"): string {
  return cn(
    "h-auto min-h-9 rounded-3xl px-3.5 py-1.5 text-muted-foreground hover:bg-background/60 aria-pressed:shadow-xs",
    columns ? "w-full whitespace-normal px-1.5 text-center leading-tight" : "",
    tone === "primary"
      ? "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary"
      : "aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:hover:bg-background",
  )
}
