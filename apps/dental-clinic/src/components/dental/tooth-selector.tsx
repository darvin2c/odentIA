import { FDI_ADULT_ROWS, FDI_CHILD_ROWS, isValidTooth } from "@odentia/dental"
import { Button, Input } from "@odentia/ui"
import { useId, useState } from "react"
import { OdontogramArch } from "./odontogram-arch"

export interface ToothSelectorProps {
  value: number[]
  onChange: (value: number[]) => void
  disabled?: boolean
  /** Una sola pieza (campo «pieza» de formularios): sin selección rápida. */
  single?: boolean
  /** Va al campo «Escribir pieza FDI» (para `FieldLabel htmlFor`); los ids internos salen de él. */
  id?: string
  /** `aria-invalid` en el grupo y en el campo que se escribe. */
  invalid?: boolean
  /** La ayuda y el error de la pantalla; se une a las pistas internas. */
  "aria-describedby"?: string
  /** Nombre del grupo si la pantalla no lo envuelve en un `FieldSet` con leyenda. */
  "aria-label"?: string
  "aria-labelledby"?: string
  /** Al salir del grupo. */
  onBlur?: () => void
}

type Dentition = "adulta" | "temporal"

const ROWS: Record<Dentition, readonly (readonly number[])[]> = {
  adulta: FDI_ADULT_ROWS,
  temporal: FDI_CHILD_ROWS,
}

/** Mitades de cada arcada → cuadrantes [superior derecho, superior izquierdo, inferior derecho, inferior izquierdo]. */
const QUADRANT_LABELS = [
  "Cuadrante superior derecho",
  "Cuadrante superior izquierdo",
  "Cuadrante inferior derecho",
  "Cuadrante inferior izquierdo",
] as const

function quadrantOf(rows: readonly (readonly number[])[]): readonly (readonly number[])[] {
  const halves: number[][] = []
  for (const row of rows) {
    const mid = Math.ceil(row.length / 2)
    halves.push([...row.slice(0, mid)], [...row.slice(mid)])
  }
  return halves
}

function addAll(teeth: number[], add: readonly number[]): number[] {
  return [...new Set([...teeth, ...add])].sort((a, b) => a - b)
}

/**
 * Selector visual multi-pieza reutilizable sobre el OdontogramArch anatómico
 * existente (no recrea dibujos). MULTI por defecto: cada clic alterna la pieza
 * sin reemplazar la selección. Cambiar de dentición solo cambia la vista y
 * conserva las piezas ya seleccionadas. No pinta su etiqueta: la pantalla lo
 * nombra (`FieldSet` + `FieldLegend` o `field.Group`).
 */
export function ToothSelector({
  value,
  onChange,
  disabled = false,
  single = false,
  id,
  invalid = false,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  onBlur,
}: ToothSelectorProps) {
  const generatedId = useId()
  const typedId = id ?? generatedId
  const typedErrorId = `${typedId}-error`
  const statusId = `${typedId}-estado`
  const [typed, setTyped] = useState("")
  const [typedError, setTypedError] = useState<string | null>(null)
  const select = (tooth: number) => {
    if (single) {
      onChange(value.includes(tooth) ? [] : [tooth])
      return
    }
    const next = value.includes(tooth) ? value.filter((t) => t !== tooth) : [...value, tooth]
    onChange([...new Set(next)].sort((a, b) => a - b))
  }
  // Alternativa al clic: escribir el número FDI (teclado y lectores de pantalla).
  const addTyped = () => {
    const tooth = Number(typed.trim())
    if (!Number.isInteger(tooth) || !isValidTooth(tooth)) {
      setTypedError(`«${typed}» no es una pieza FDI (11–48 o 51–85)`)
      return
    }
    setTypedError(null)
    setTyped("")
    setDentition(tooth >= 50 ? "temporal" : "adulta")
    if (single) onChange([tooth])
    else if (!value.includes(tooth)) onChange([...value, tooth].sort((a, b) => a - b))
  }
  const [dentition, setDentition] = useState<Dentition>(() =>
    value.some((t) => t >= 50) ? "temporal" : "adulta",
  )
  const rows = ROWS[dentition]
  const flat = rows.flat()
  const quadrants = quadrantOf(rows)
  const selectedHere = value.filter((t) => flat.includes(t))

  return (
    <div
      role="group"
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
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Dentición">
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
              {d === "adulta" ? "Adultos" : "Temporal"}
            </Button>
          ))}
        </div>
      </div>

      <OdontogramArch
        teeth={{ upper: rows[0] ?? [], lower: rows[1] ?? [] }}
        entriesOf={() => []}
        selected={value}
        disabled={disabled}
        onToggle={(tooth) => {
          if (disabled) return
          select(tooth)
        }}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={typedId} className="text-xs text-muted-foreground">
          Escribir pieza FDI
        </label>
        <Input
          id={typedId}
          className="h-8 w-20"
          inputMode="numeric"
          maxLength={2}
          value={typed}
          disabled={disabled}
          aria-invalid={typedError || invalid ? true : undefined}
          aria-describedby={[describedBy, typedError ? typedErrorId : undefined, statusId].filter(Boolean).join(" ")}
          onChange={(event) => {
            setTyped(event.target.value.replace(/\D/g, ""))
            setTypedError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addTyped()
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled || !typed} onClick={addTyped}>
          {single ? "Elegir" : "Agregar"}
        </Button>
        {typedError ? (
          <span id={typedErrorId} role="alert" className="text-xs text-destructive">
            {typedError}
          </span>
        ) : null}
      </div>

      <div className={single ? "hidden" : "flex flex-wrap gap-1.5"} aria-label="Selección rápida">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(addAll(value, rows[0] ?? []))}
        >
          Arcada superior
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(addAll(value, rows[1] ?? []))}
        >
          Arcada inferior
        </Button>
        {quadrants.map((q, i) => (
          <Button
            key={QUADRANT_LABELS[i]}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            title={QUADRANT_LABELS[i]}
            aria-label={`Seleccionar ${QUADRANT_LABELS[i].toLowerCase()}`}
            onClick={() => onChange(addAll(value, q))}
          >
            {QUADRANT_LABELS[i].replace("Cuadrante ", "")}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(addAll(value, flat))}
        >
          Todas
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || selectedHere.length === 0}
          onClick={() => {
            const gone = new Set(flat)
            onChange(value.filter((t) => !gone.has(t)))
          }}
        >
          Limpiar
        </Button>
      </div>

      <p id={statusId} aria-live="polite" className="text-xs text-muted-foreground">
        {value.length === 0
          ? "Sin piezas seleccionadas. Toca las piezas del odontograma o usa la selección rápida."
          : `${value.length} ${value.length === 1 ? "pieza seleccionada" : "piezas seleccionadas"}: ${[...value].sort((a, b) => a - b).join(", ")}`}
      </p>
    </div>
  )
}
