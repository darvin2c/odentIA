import { useId, useState } from "react";
import { FDI_ADULT_ROWS, FDI_CHILD_ROWS } from "@odentia/clinical";
import { Button } from "@odentia/ui";
import { OdontogramArch } from "../odontogram-arch";

export interface ToothSelectorProps {
  value: number[];
  onChange: (value: number[]) => void;
  disabled?: boolean;
  label?: string;
}

type Dentition = "adulta" | "temporal";

const ROWS: Record<Dentition, readonly (readonly number[])[]> = {
  adulta: FDI_ADULT_ROWS,
  temporal: FDI_CHILD_ROWS,
};

/** Mitades de cada arcada → cuadrantes [superior derecho, superior izquierdo, inferior derecho, inferior izquierdo]. */
const QUADRANT_LABELS = [
  "Cuadrante superior derecho",
  "Cuadrante superior izquierdo",
  "Cuadrante inferior derecho",
  "Cuadrante inferior izquierdo",
] as const;

function quadrantOf(rows: readonly (readonly number[])[]): readonly (readonly number[])[] {
  const halves: number[][] = [];
  for (const row of rows) {
    const mid = Math.ceil(row.length / 2);
    halves.push([...row.slice(0, mid)], [...row.slice(mid)]);
  }
  return halves;
}


function addAll(teeth: number[], add: readonly number[]): number[] {
  return [...new Set([...teeth, ...add])].sort((a, b) => a - b);
}


/**
 * Selector visual multi-pieza reutilizable sobre el OdontogramArch anatómico
 * existente (no recrea dibujos). MULTI por defecto: cada clic alterna la pieza
 * sin reemplazar la selección. Cambiar de dentición solo cambia la vista y
 * conserva las piezas ya seleccionadas.
 */
export function ToothSelector({ value, onChange, disabled = false, label }: ToothSelectorProps) {
  const groupId = useId();
  const [dentition, setDentition] = useState<Dentition>(() =>
    value.some((t) => t >= 50) ? "temporal" : "adulta",
  );
  const rows = ROWS[dentition];
  const flat = rows.flat();
  const quadrants = quadrantOf(rows);
  const selectedHere = value.filter((t) => flat.includes(t));

  const groupLabel = label ?? "Selección de piezas dentales";

  return (
    <div role="group" aria-labelledby={groupId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={groupId} className="text-sm font-medium">
          {groupLabel}
        </span>
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
          if (disabled) return;
          const next = value.includes(tooth) ? value.filter((t) => t !== tooth) : [...value, tooth];
          onChange([...new Set(next)].sort((a, b) => a - b));
        }}
      />

      <div className="flex flex-wrap gap-1.5" aria-label="Selección rápida">
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
            const gone = new Set(flat);
            onChange(value.filter((t) => !gone.has(t)));
          }}
        >
          Limpiar
        </Button>
      </div>

      <p aria-live="polite" className="text-xs text-muted-foreground">
        {value.length === 0
          ? "Sin piezas seleccionadas. Toca las piezas del odontograma o usa la selección rápida."
          : `${value.length} ${value.length === 1 ? "pieza seleccionada" : "piezas seleccionadas"}: ${[...value].sort((a, b) => a - b).join(", ")}`}
      </p>
    </div>
  );
}
