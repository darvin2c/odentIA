import { cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"

export interface RadioChipsProps<T extends string> {
  /** Va en la raíz del grupo. */
  id?: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  /** Id del texto visible que nombra al grupo. */
  "aria-labelledby"?: string
  /** Nombre accesible cuando no hay un texto visible que lo nombre. */
  "aria-label"?: string
  "aria-describedby"?: string
  invalid?: boolean
  /** Al salir del grupo. */
  onBlur?: () => void
  disabled?: boolean
  className?: string
}

/**
 * Opciones excluyentes como pastillas: el grupo de radio del sistema
 * (`RadioGroup` de `@odentia/ui`) con teclado y foco, para elegir entre pocas
 * alternativas que conviene ver todas a la vez. No pinta etiqueta: el grupo se
 * nombra desde fuera (`aria-labelledby` o `aria-label`).
 */
export function RadioChips<T extends string>({
  id,
  value,
  options,
  onChange,
  invalid = false,
  onBlur,
  disabled,
  className,
  ...aria
}: RadioChipsProps<T>): React.JSX.Element {
  return (
    <RadioGroup
      id={id}
      aria-labelledby={aria["aria-labelledby"]}
      aria-label={aria["aria-label"]}
      aria-describedby={aria["aria-describedby"]}
      aria-invalid={invalid || undefined}
      onBlur={
        onBlur
          ? (event: React.FocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
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
          <RadioGroupItem value={option.value} aria-invalid={invalid || undefined} />
          {option.label}
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
