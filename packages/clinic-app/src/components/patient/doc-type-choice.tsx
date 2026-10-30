import { DOC_TYPE_LABELS, type IdentityDocType } from "@odentia/clinical"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { useId, useState } from "react"
import { ChoiceButtons } from "../choice-buttons"

/** A la vista van los tres documentos más usados del país; los demás, en «Otro». */
const OTHER_DOC = "__otro"

/**
 * Tipo de documento: los tres primeros del país como botones y el resto en
 * «Otro», que abre la lista. Sin elegir (`null`), ningún botón queda marcado.
 * No pinta etiqueta: se nombra desde fuera (`aria-labelledby` o `aria-label`);
 * `id` va en la raíz de los botones y `onBlur` avisa al salir del conjunto.
 */
export function DocTypeChoice({
  id,
  value,
  options,
  onChange,
  invalid = false,
  onBlur,
  ...aria
}: {
  id?: string
  value: IdentityDocType | null
  options: ReadonlyArray<{ value: IdentityDocType; label: string }>
  onChange: (value: IdentityDocType) => void
  invalid?: boolean
  /** Al salir de los botones y de la lista de «Otro». */
  onBlur?: () => void
  /** Id del texto visible que nombra al dato. */
  "aria-labelledby"?: string
  /** Nombre accesible cuando no hay un texto visible que lo nombre. */
  "aria-label"?: string
  "aria-describedby"?: string
}) {
  const fallbackId = useId()
  const baseId = id ?? fallbackId
  // ChoiceButtons da a cada opción el id `${id}-${valor}`.
  const otherButtonId = `${baseId}-${OTHER_DOC}`
  const shown = options.slice(0, 3)
  const rest = options.slice(3)
  const firstRest = rest[0]?.value
  const [other, setOther] = useState(() => rest.some((option) => option.value === value))
  const restValue = rest.some((option) => option.value === value) ? value : null
  const ariaLabel = aria["aria-label"]
  const labelledBy = aria["aria-labelledby"]
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha cuándo el foco sale de lo que tiene dentro, para dar el campo por visitado.
    <div
      className="flex min-w-0 flex-col gap-2"
      onBlur={
        onBlur
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
    >
      <ChoiceButtons<string>
        id={baseId}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={aria["aria-describedby"]}
        invalid={invalid}
        value={other ? OTHER_DOC : value}
        options={[...shown, ...(rest.length ? [{ value: OTHER_DOC, label: "Otro" }] : [])]}
        onChange={(next) => {
          if (next === OTHER_DOC) {
            setOther(true)
            if (rest[0]) onChange(restValue ?? rest[0].value)
            return
          }
          setOther(false)
          onChange(next as IdentityDocType)
        }}
      />
      {other && firstRest ? (
        <Select<IdentityDocType>
          value={restValue ?? firstRest}
          onValueChange={(next) => next && onChange(next)}
        >
          <SelectTrigger
            aria-label={ariaLabel ? `${ariaLabel}: otro` : labelledBy ? undefined : "Otro tipo de documento"}
            aria-labelledby={!ariaLabel && labelledBy ? `${labelledBy} ${otherButtonId}` : undefined}
            aria-invalid={invalid || undefined}
            className="w-full"
          >
            <SelectValue>{DOC_TYPE_LABELS[restValue ?? firstRest]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {rest.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
