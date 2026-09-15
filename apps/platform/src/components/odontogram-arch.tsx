import { Fragment } from "react";
import type { OdontogramEntry } from "../lib/patients";
import { ToothSVG } from "./tooth-svg";

const CX = 50;
const CY = 50;
const RX = 38;
const RY = 38;
const LABEL_RX = RX + 8;
const LABEL_RY = RY + 6;
/** Inset angular de los extremos: los molares terminales superior e inferior
 *  nunca comparten coordenadas y queda un hueco real al centro (herradura). */
const END_INSET = 10;

function point(phiDeg: number, rx: number, ry: number): { left: number; top: number } {
  const rad = (phiDeg * Math.PI) / 180;
  return { left: CX + rx * Math.cos(rad), top: CY + ry * Math.sin(rad) };
}

export function OdontogramArch({
  teeth,
  entriesOf,
  selected,
  disabled = false,
  onToggle,
}: {
  teeth: { upper: readonly number[]; lower: readonly number[] };
  entriesOf: (tooth: number) => OdontogramEntry[];
  selected: number[];
  disabled?: boolean;
  onToggle: (tooth: number, additive: boolean) => void;
}): React.JSX.Element {
  const renderArch = (row: readonly number[], lower: boolean) =>
    row.map((tooth, i) => {
      const span = 180 - END_INSET * 2;
      const phi =
        row.length <= 1
          ? lower
            ? 90
            : 270
          : lower
            ? 180 - END_INSET - (i / (row.length - 1)) * span
            : 180 + END_INSET + (i / (row.length - 1)) * span;
      const pos = point(phi, RX, RY);
      const label = point(phi, LABEL_RX, LABEL_RY);
      const rotation = phi - 90;
      // Envolvente proporcional al ancho: el diente llena su wrapper y el
      // wrapper escala con el contenedor (también a 320px móvil).
      const wrapWidth = row.length > 12 ? 8 : 11;
      return (
        <Fragment key={tooth}>
          <div
            className="absolute [&>button]:block [&>button]:w-full"
            style={{
              left: `${pos.left}%`,
              top: `${pos.top}%`,
              width: `${wrapWidth}%`,
              transform: `translate(-50%,-50%) rotate(${rotation}deg)`,
            }}
          >
            <ToothSVG
              toothNumber={tooth}
              entries={entriesOf(tooth)}
              selected={selected.includes(tooth)}
              disabled={disabled}
              size="arch"
              showRoots={false}
              onSelect={(event) => onToggle(tooth, Boolean(event?.ctrlKey || event?.metaKey))}
            />
          </div>
          <span
            aria-hidden="true"
            className="absolute text-[11px] leading-none text-muted-foreground"
            style={{ left: `${label.left}%`, top: `${label.top}%`, transform: "translate(-50%,-50%)" }}
          >
            {tooth}
          </span>
        </Fragment>
      );
    });

  return (
    <div className="relative mx-auto aspect-[3/4] min-w-0 w-full max-w-[360px]" role="group" aria-label="Odontograma">
      <div aria-hidden="true" className="absolute top-1/2 left-1/2 h-[6%] w-px -translate-x-1/2 -translate-y-1/2 bg-border" />
      <div aria-hidden="true" className="absolute top-1/2 left-1/2 h-px w-[6%] -translate-x-1/2 -translate-y-1/2 bg-border" />
      {renderArch(teeth.upper, false)}
      {renderArch(teeth.lower, true)}
    </div>
  );
}
