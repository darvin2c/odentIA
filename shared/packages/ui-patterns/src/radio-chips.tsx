import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"
import * as React from "react"
import { common } from "./common.js"

export interface RadioChipsProps<T extends string> {
  /** Va en la raíz del grupo. */
  id?: string
  /** Lo elegido; `null`, nada todavía. */
  value: T | null
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  /**
   * Una pregunta que se puede dejar sin responder: con algo elegido aparece
   * «Quitar respuesta», porque la opción elegida de un radio no se desmarca.
   */
  onClear?: () => void
  /** Id del texto visible que nombra al grupo. */
  "aria-labelledby"?: string
  /** Nombre accesible cuando no hay un texto visible que lo nombre. */
  "aria-label"?: string
  "aria-describedby"?: string
  invalid?: boolean
  /** Al salir del grupo. */
  onBlur?: () => void
  /**
   * Las opciones son una escala (0 a 10): las flechas se detienen en los extremos, e Inicio y Fin
   * van al primero y al último, como en un control deslizante (patrón «slider» de WAI-ARIA). Sin
   * ella el grupo da la vuelta, como pide el patrón de radio: en Sí/No no hay un orden que perder.
   */
  ordered?: boolean
  disabled?: boolean
  className?: string
}

/** El anillo de foco de `Button` (`ring-3`), algo más fuerte porque rodea una pastilla clara. */
const FOCUS_RING =
  "has-[[role=radio]:focus-visible]:border-ring has-[[role=radio]:focus-visible]:ring-3 has-[[role=radio]:focus-visible]:ring-ring/50"

const BACK = new Set(["ArrowLeft", "ArrowUp"])
const FORWARD = new Set(["ArrowRight", "ArrowDown"])

/**
 * En una escala, desde 0 la flecha ← marcaba 10, el peor dolor: el grupo daba la vuelta. Aquí se
 * detiene en los extremos, e Inicio y Fin eligen el primero y el último. Va antes de que el grupo
 * mueva el foco (en captura), y solo cuando hay algo que cambiar de su comportamiento.
 */
function keepInScale<T extends string>(
  event: React.KeyboardEvent<HTMLDivElement>,
  options: ReadonlyArray<{ value: T }>,
  onChange: (value: T) => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
  const at = radios.findIndex((radio) => radio === event.target || radio.contains(event.target as Node))
  if (at < 0) return
  const last = radios.length - 1
  const to =
    event.key === "Home" ? 0 : event.key === "End" ? last : null
  const stuck = (BACK.has(event.key) && at === 0) || (FORWARD.has(event.key) && at === last)
  if (to === null && !stuck) return
  event.preventDefault()
  event.stopPropagation()
  if (to === null || to === at) return
  const option = options[to]
  if (!option) return
  onChange(option.value)
  radios[to]?.focus()
}

/**
 * Opciones excluyentes como pastillas: el grupo de radio del sistema
 * (`RadioGroup` de `@odentia/ui`, patrón de WAI-ARIA), para elegir entre pocas
 * alternativas que conviene ver todas a la vez. Una sola parada de Tab, en la
 * opción elegida (o la primera si no hay ninguna); las flechas mueven y
 * eligen, Espacio elige y Enter no marca nada. No pinta etiqueta: el grupo se
 * nombra desde fuera (`aria-labelledby` o `aria-label`).
 */
export function RadioChips<T extends string>({
  id,
  value,
  options,
  onChange,
  onClear,
  invalid = false,
  onBlur,
  ordered = false,
  disabled,
  className,
  ...aria
}: RadioChipsProps<T>): React.JSX.Element {
  const root = React.useRef<HTMLDivElement | null>(null)
  const leave = onBlur
    ? (event: React.FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
      }
    : undefined
  const group = (
    <RadioGroup
      id={id}
      aria-labelledby={aria["aria-labelledby"]}
      aria-label={aria["aria-label"]}
      aria-describedby={aria["aria-describedby"]}
      aria-invalid={invalid || undefined}
      onBlur={onClear ? undefined : leave}
      className={cn("flex flex-wrap gap-2", className)}
      disabled={disabled}
      value={value ?? ""}
      onValueChange={(next) => onChange(next as T)}
      onKeyDownCapture={ordered && !disabled ? (event) => keepInScale(event, options, onChange) : undefined}
    >
      {options.map((option) => (
        <FieldLabel
          key={option.value}
          className={cn(
            "flex min-h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal transition-shadow",
            value === option.value && "border-primary bg-primary-soft",
            // El foco del teclado se ve en toda la pastilla, como el anillo de un botón, y se
            // distingue de «elegida» (borde y fondo): con foco, el anillo; sin foco, nada más.
            FOCUS_RING,
          )}
        >
          {/* El anillo lo lleva la pastilla: el del círculo de 16 px casi no se veía. */}
          <RadioGroupItem
            value={option.value}
            aria-invalid={invalid || undefined}
            className="focus-visible:ring-0 aria-invalid:ring-0"
          />
          {option.label}
        </FieldLabel>
      ))}
    </RadioGroup>
  )
  if (!onClear) return group
  return (
    // «Quitar respuesta» va fuera del grupo de radios y dentro de lo que cuenta como «el grupo» al salir.
    <div ref={root} onBlur={leave} className="flex min-w-0 flex-col items-start gap-1">
      {group}
      {value !== null && !disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // Enter pasa de pregunta en pregunta (`advanceOnEnter`): no se detiene en un botón que borra.
          data-enter-skip=""
          aria-describedby={aria["aria-labelledby"]}
          className="h-auto min-h-8 px-2 text-muted-foreground max-sm:min-h-11 pointer-coarse:min-h-11"
          onClick={() => {
            onClear()
            // El botón desaparece con la respuesta: el foco vuelve al grupo, a su primera opción.
            root.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()
          }}
        >
          {common.actions.clearAnswer}
        </Button>
      ) : null}
    </div>
  )
}
