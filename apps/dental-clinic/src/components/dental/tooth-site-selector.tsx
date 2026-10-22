import {
  FDI_ADULT_ROWS,
  FDI_CHILD_ROWS,
  isValidTooth,
  surfaceLabel,
  surfacesForTooth,
  toothNameOf,
} from "@odentia/dental"
import { Button, Input } from "@odentia/ui"
import { useId, useState } from "react"
import { OdontogramArch } from "./odontogram-arch"

export interface ToothSite {
  toothNumber: number | null
  surfaces: string[]
}

type Dentition = "adulta" | "temporal"

/**
 * Selector de sitio dental: UNA pieza sobre el arco anatómico del odontograma
 * y, si se piden, sus superficies válidas. El número FDI también se escribe,
 * para teclado y lector de pantalla. Es la misma composición para
 * diagnósticos, procedimientos y documentos: un solo selector de pieza.
 */
export function ToothSiteSelector({
  value,
  onChange,
  withSurfaces = false,
  disabled = false,
  label = "Pieza",
  optional = true,
  surfacesRequired = false,
}: {
  value: ToothSite
  onChange: (value: ToothSite) => void
  withSurfaces?: boolean
  disabled?: boolean
  label?: string
  optional?: boolean
  surfacesRequired?: boolean
}): React.JSX.Element {
  const groupId = useId()
  const inputId = useId()
  const [dentition, setDentition] = useState<Dentition>(() =>
    value.toothNumber !== null && value.toothNumber >= 50 ? "temporal" : "adulta",
  )
  const [typed, setTyped] = useState(value.toothNumber === null ? "" : String(value.toothNumber))
  const rows = dentition === "adulta" ? FDI_ADULT_ROWS : FDI_CHILD_ROWS
  const tooth = value.toothNumber
  const available = tooth !== null && isValidTooth(tooth) ? surfacesForTooth(tooth) : []

  const pick = (next: number | null) => {
    setTyped(next === null ? "" : String(next))
    // Cambiar de pieza invalida las superficies de la anterior.
    onChange({ toothNumber: next, surfaces: [] })
  }

  return (
    <fieldset aria-labelledby={groupId} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={groupId} className="text-sm font-medium">
          {label}
          {optional ? <span className="text-muted-foreground"> (opcional)</span> : null}
        </span>
        <fieldset className="m-0 flex gap-1 border-0 p-0" aria-label="Dentición">
          {(["adulta", "temporal"] as const).map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={dentition === d ? "default" : "outline"}
              aria-pressed={dentition === d}
              disabled={disabled}
              onClick={() => setDentition(d)}
            >
              {d === "adulta" ? "Permanente" : "Temporal"}
            </Button>
          ))}
        </fieldset>
      </div>
      <OdontogramArch
        teeth={{ upper: rows[0] ?? [], lower: rows[1] ?? [] }}
        entriesOf={() => []}
        selected={tooth === null ? [] : [tooth]}
        disabled={disabled}
        onToggle={(clicked) => {
          if (disabled) return
          pick(clicked === tooth ? null : clicked)
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            Número FDI
          </label>
          <Input
            id={inputId}
            className="w-24"
            inputMode="numeric"
            maxLength={2}
            placeholder="Ej.: 36"
            value={typed}
            disabled={disabled}
            aria-invalid={typed !== "" && !isValidTooth(Number(typed))}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "").slice(0, 2)
              setTyped(digits)
              if (digits === "") onChange({ toothNumber: null, surfaces: [] })
              else if (digits.length === 2 && isValidTooth(Number(digits)))
                onChange({ toothNumber: Number(digits), surfaces: [] })
            }}
          />
        </div>
        <p aria-live="polite" className="pb-2 text-xs text-muted-foreground">
          {tooth !== null && isValidTooth(tooth)
            ? `${tooth} · ${toothNameOf(tooth)}`
            : typed !== "" && typed.length === 2
              ? "Número FDI no válido (11–48 o 51–85)."
              : "Toca una pieza o escribe su número."}
        </p>
        {tooth !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => pick(null)}
          >
            Quitar pieza
          </Button>
        ) : null}
      </div>
      {withSurfaces && available.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            {surfacesRequired ? "Superficies (al menos una)" : "Superficies (opcional)"}
          </span>
          <fieldset
            className="m-0 flex flex-wrap gap-1.5 border-0 p-0"
            aria-label={`Superficies de la pieza ${tooth}`}
          >
            {available.map((surface) => {
              const pressed = value.surfaces.includes(surface)
              return (
                <Button
                  key={surface}
                  type="button"
                  size="sm"
                  variant={pressed ? "default" : "outline"}
                  aria-pressed={pressed}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      toothNumber: tooth,
                      surfaces: pressed
                        ? value.surfaces.filter((s) => s !== surface)
                        : [...value.surfaces, surface],
                    })
                  }
                >
                  {surfaceLabel(surface)}
                </Button>
              )
            })}
          </fieldset>
        </div>
      ) : null}
    </fieldset>
  )
}
