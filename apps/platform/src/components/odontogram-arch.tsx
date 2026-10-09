import { Fragment } from "react"
import type { OdontogramEntry } from "../lib/patients"
import { ToothSVG } from "./tooth-svg"

const CX = 50
const CY = 50
const RX = 38
const RY = 38
/** Arco interior (temporales en dentición mixta): mismo centro, radio menor. */
const INNER_RX = 22
const INNER_RY = 23
const LABEL_OFFSET_X = 8
const LABEL_OFFSET_Y = 6
/** Inset angular de los extremos: los molares terminales superior e inferior
 *  nunca comparten coordenadas y queda un hueco real al centro (herradura). */
const END_INSET = 10

function point(phiDeg: number, rx: number, ry: number): { left: number; top: number } {
  const rad = (phiDeg * Math.PI) / 180
  return { left: CX + rx * Math.cos(rad), top: CY + ry * Math.sin(rad) }
}

export function OdontogramArch({
  teeth,
  inner,
  entriesOf,
  selected,
  disabled = false,
  onToggle,
}: {
  teeth: { upper: readonly number[]; lower: readonly number[] }
  /** Segundo arco concéntrico; sus números van hacia el centro. */
  inner?: { upper: readonly number[]; lower: readonly number[] }
  entriesOf: (tooth: number) => OdontogramEntry[]
  selected: number[]
  disabled?: boolean
  onToggle: (tooth: number, additive: boolean) => void
}): React.JSX.Element {
  const renderArch = (row: readonly number[], lower: boolean, innerRing = false) =>
    row.map((tooth, i) => {
      const rx = innerRing ? INNER_RX : RX
      const ry = innerRing ? INNER_RY : RY
      const labelSign = innerRing ? -1 : 1
      const span = 180 - END_INSET * 2
      const phi =
        row.length <= 1
          ? lower
            ? 90
            : 270
          : lower
            ? 180 - END_INSET - (i / (row.length - 1)) * span
            : 180 + END_INSET + (i / (row.length - 1)) * span
      const pos = point(phi, rx, ry)
      const label = point(phi, rx + labelSign * LABEL_OFFSET_X, ry + labelSign * LABEL_OFFSET_Y)
      const rotation = phi - 90
      // Envolvente proporcional al ancho: el diente llena su wrapper y el
      // wrapper escala con el contenedor (también a 320px móvil).
      const wrapWidth = innerRing ? 6.5 : row.length > 12 ? 8 : 11
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
            style={{
              left: `${label.left}%`,
              top: `${label.top}%`,
              transform: "translate(-50%,-50%)",
            }}
          >
            {tooth}
          </span>
        </Fragment>
      )
    })

  return (
    <div
      className="relative mx-auto aspect-[3/4] min-w-0 w-full max-w-[360px]"
      role="group"
      aria-label="Odontograma"
    >
      <div
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 h-[6%] w-px -translate-x-1/2 -translate-y-1/2 bg-border"
      />
      <div
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 h-px w-[6%] -translate-x-1/2 -translate-y-1/2 bg-border"
      />
      {renderArch(teeth.upper, false)}
      {renderArch(teeth.lower, true)}
      {inner ? renderArch(inner.upper, false, true) : null}
      {inner ? renderArch(inner.lower, true, true) : null}
    </div>
  )
}
