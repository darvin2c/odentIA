import { DOC_TYPE_LABELS, type IdentityDocType } from "@odentia/clinical"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { useState } from "react"
import { ChoiceButtons } from "../choice-buttons"

/** A la vista van los tres documentos más usados del país; los demás, en «Otro». */
const OTHER_DOC = "__otro"

/**
 * Tipo de documento: los tres primeros del país como botones y el resto en
 * «Otro», que abre la lista. Sin elegir (`null`), ningún botón queda marcado.
 */
export function DocTypeChoice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: IdentityDocType | null
  options: ReadonlyArray<{ value: IdentityDocType; label: string }>
  onChange: (value: IdentityDocType) => void
}) {
  const shown = options.slice(0, 3)
  const rest = options.slice(3)
  const firstRest = rest[0]?.value
  const [other, setOther] = useState(() => rest.some((option) => option.value === value))
  const restValue = rest.some((option) => option.value === value) ? value : null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChoiceButtons<string>
        label={label}
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
          <SelectTrigger aria-label={`${label}: otro`} className="w-full">
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
