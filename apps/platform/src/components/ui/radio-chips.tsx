import { cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"

export interface RadioChipsProps<T extends string> {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  /** Id del texto visible que nombra al grupo. */
  labelledBy?: string
  /** Nombre accesible cuando no hay un texto visible que lo nombre. */
  "aria-label"?: string
  disabled?: boolean
  className?: string
}

/**
 * Opciones excluyentes como pastillas: el grupo de radio del sistema
 * (`RadioGroup` de `@odentia/ui`) con teclado y foco, para elegir entre pocas
 * alternativas que conviene ver todas a la vez.
 */
export function RadioChips<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  disabled,
  className,
  ...aria
}: RadioChipsProps<T>): React.JSX.Element {
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      aria-label={aria["aria-label"]}
      className={cn("flex flex-wrap gap-2", className)}
      disabled={disabled}
      value={value}
      onValueChange={(next) => onChange(next as T)}
    >
      {options.map((option) => (
        <FieldLabel
          key={option.value}
          className={cn(
            "flex min-h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
            value === option.value && "border-primary bg-primary-soft",
          )}
        >
          <RadioGroupItem value={option.value} />
          {option.label}
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
