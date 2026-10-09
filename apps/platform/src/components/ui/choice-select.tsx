import { cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { Children, isValidElement, type ReactNode } from "react"

interface OptionProps {
  value?: string | number
  children?: ReactNode
  disabled?: boolean
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ""
}

/** Opciones declaradas como `<option>` (también dentro de fragmentos o mapas). */
function collectOptions(children: ReactNode): Array<{ value: string; label: string; disabled: boolean }> {
  const out: Array<{ value: string; label: string; disabled: boolean }> = []
  for (const child of Children.toArray(children)) {
    if (!isValidElement<OptionProps & { children?: ReactNode }>(child)) continue
    if (child.type === "option") {
      const label = textOf(child.props.children)
      out.push({
        value: child.props.value === undefined ? label : String(child.props.value),
        label,
        disabled: Boolean(child.props.disabled),
      })
    } else {
      out.push(...collectOptions(child.props.children))
    }
  }
  return out
}

export interface ChoiceSelectProps {
  id?: string
  value: string
  /** Mismo contrato que el `<select>` nativo para migrar sin reescribir handlers. */
  onChange: (event: { target: { value: string }; currentTarget: { value: string } }) => void
  children: ReactNode
  disabled?: boolean
  className?: string
  placeholder?: string
  "aria-label"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-required"?: boolean | "true" | "false"
  required?: boolean
  name?: string
}

/**
 * Selector de la interfaz (`@odentia/ui` Select) con la forma del `<select>`
 * nativo: recibe `<option>` y entrega `event.target.value`. Unifica el aspecto,
 * el teclado y el foco de la ficha sin reescribir cada formulario.
 */
export function ChoiceSelect({
  id,
  value,
  onChange,
  children,
  disabled,
  className,
  placeholder = "Elige una opción",
  required,
  ...aria
}: ChoiceSelectProps): React.JSX.Element {
  const options = collectOptions(children)
  // La opción vacía («Sin turno», «No registrado») es el texto sin elección.
  const emptyLabel = options.find((o) => o.value === "")?.label
  return (
    <Select
      items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const v = next == null ? "" : String(next)
        onChange({ target: { value: v }, currentTarget: { value: v } })
      }}
    >
      <SelectTrigger
        id={id}
        className={cn("w-full", className)}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        aria-required={aria["aria-required"] ?? (required ? true : undefined)}
      >
        <SelectValue placeholder={emptyLabel || placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} data-value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
