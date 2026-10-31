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
 * diagnósticos, procedimientos y documentos: un solo selector de pieza. No
 * pinta su etiqueta: la pantalla lo nombra (`FieldSet` + `FieldLegend` o
 * `field.Group`).
 */
export function ToothSiteSelector({
  value,
  onChange,
  withSurfaces = false,
  disabled = false,
  surfacesRequired = false,
  id,
  invalid = false,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  onBlur,
}: {
  value: ToothSite
  onChange: (value: ToothSite) => void
  withSurfaces?: boolean
  disabled?: boolean
  surfacesRequired?: boolean
  /** Va al campo «Número FDI» (para `FieldLabel htmlFor`); los ids internos salen de él. */
  id?: string
  /** `aria-invalid` en el grupo, en el número FDI y en cada superficie que se muestra. */
  invalid?: boolean
  /** La ayuda y el error de la pantalla; se une a las pistas internas. */
  "aria-describedby"?: string
  /** Nombre del grupo si la pantalla no lo envuelve en un `FieldSet` con leyenda. */
  "aria-label"?: string
  "aria-labelledby"?: string
  /** Al salir del grupo. */
  onBlur?: () => void
}): React.JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const statusId = `${inputId}-estado`
  const typedErrorId = `${inputId}-error`
  const surfacesLabelId = `${inputId}-superficies`
  const [dentition, setDentition] = useState<Dentition>(() =>
    value.toothNumber !== null && value.toothNumber >= 50 ? "temporal" : "adulta",
  )
  const [typed, setTyped] = useState(value.toothNumber === null ? "" : String(value.toothNumber))
  const rows = dentition === "adulta" ? FDI_ADULT_ROWS : FDI_CHILD_ROWS
  const tooth = value.toothNumber
  const available = tooth !== null && isValidTooth(tooth) ? surfacesForTooth(tooth) : []
  // Dos dígitos que no son una pieza: el error manda sobre la pieza anterior, que ya se quitó.
  const typedInvalid = typed.length === 2 && !isValidTooth(Number(typed))

  const pick = (next: number | null) => {
    setTyped(next === null ? "" : String(next))
    // Cambiar de pieza invalida las superficies de la anterior.
    onChange({ toothNumber: next, surfaces: [] })
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onBlur={
        onBlur
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
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
            aria-invalid={typedInvalid || invalid ? true : undefined}
            aria-describedby={[describedBy, typedInvalid ? typedErrorId : statusId].filter(Boolean).join(" ")}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "").slice(0, 2)
              setTyped(digits)
              const next = Number(digits)
              // Lo escrito manda: si ya no es la pieza elegida, se quita (no queda la anterior a la vista).
              if (digits.length === 2 && isValidTooth(next)) onChange({ toothNumber: next, surfaces: [] })
              else if (tooth !== null) onChange({ toothNumber: null, surfaces: [] })
            }}
          />
        </div>
        {typedInvalid ? (
          <p id={typedErrorId} role="alert" className="pb-2 text-xs text-destructive">
            Número FDI no válido: escribe de 11 a 48 o de 51 a 85.
          </p>
        ) : (
          <p id={statusId} aria-live="polite" className="pb-2 text-xs text-muted-foreground">
            {tooth !== null && isValidTooth(tooth) ? `${tooth} · ${toothNameOf(tooth)}` : "Toca una pieza o escribe su número."}
          </p>
        )}
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
          <span id={surfacesLabelId} className="text-xs text-muted-foreground">
            {surfacesRequired ? "Superficies (al menos una)" : "Superficies (opcional)"}
          </span>
          <fieldset
            className="m-0 flex flex-wrap gap-1.5 border-0 p-0"
            aria-label={`Superficies de la pieza ${tooth}`}
            aria-describedby={surfacesLabelId}
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
                  aria-invalid={invalid || undefined}
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
