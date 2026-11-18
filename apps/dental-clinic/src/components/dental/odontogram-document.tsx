import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"
import { conditionLabel, surfaceLabel } from "@odentia/dental"
import {
  odontogramSheetScene,
  type SheetShape,
  type SheetRow,
  sheetAbbreviation,
  sheetPoints,
} from "@odentia/dental/odontogram-sheet"
import type { ReactNode } from "react"
import type { OdontogramEntry } from "../../lib/dental/odontogram"

export interface OdontogramDocumentProps {
  entries: OdontogramEntry[]
  /** Norma con la que se dibuja y se firma («NTS 188-MINSA/DGIESP-2022»). */
  standard: string
  date?: string
  specifications?: string
  observations?: string
  examinerName?: string
  /** Título de quien firma, de su perfil («Cirujano dentista»). */
  examinerTitle?: string
  registrationNumber?: string
  patientName?: string
  /**
   * Dentro de una hoja que ya dice la clínica, la persona y la fecha: sin el
   * encabezado propio, y con su firma en lugar de la línea «Firma y sello».
   */
  embedded?: { signature: ReactNode }
}

/** Una primitiva de la escena en SVG: lo que no dice relleno ni trazo, no lo pinta. */
function SceneShape({ shape }: { shape: SheetShape }) {
  if (shape.kind === "text")
    return (
      <text
        x={shape.x}
        y={shape.y}
        textAnchor="middle"
        dominantBaseline={shape.baseline === "central" ? "central" : undefined}
        fontSize={shape.size}
        fontWeight={700}
        fill={shape.fill}
      >
        {shape.text}
      </text>
    )
  const paint = {
    fill: shape.fill ?? "none",
    fillOpacity: shape.fillOpacity,
    stroke: shape.stroke,
    strokeWidth: shape.stroke ? shape.strokeWidth : undefined,
    strokeLinecap: shape.cap,
    strokeLinejoin: shape.join,
  }
  switch (shape.kind) {
    case "line":
      return <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} {...paint} />
    case "rect":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          {...paint}
        />
      )
    case "polygon":
      return <polygon points={sheetPoints(shape.points)} {...paint} />
    case "polyline":
      return <polyline points={sheetPoints(shape.points)} {...paint} />
    case "path":
      return <path d={shape.d} {...paint} />
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint} />
    case "ellipse":
      return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...paint} />
  }
}

/** Una fila de la hoja: la dibuja `@odentia/dental/odontogram-sheet`, igual que el PDF. */
function DocRow({ row }: { row: SheetRow }) {
  const n = row.teeth.length
  return (
    <svg
      viewBox={`0 0 ${row.width} ${row.height}`}
      className={`mx-auto block ${n > 12 ? "w-full odonto-doc-row-16" : "w-[62.5%] odonto-doc-row-10"}`}
      role="group"
      aria-label={row.upper ? "Arcada superior" : "Arcada inferior"}
    >
      <g pointerEvents="none">
        {row.shapes.map((shape, i) => (
          // La escena no cambia de orden: su posición es su identidad.
          // biome-ignore lint/suspicious/noArrayIndexKey: lista fija que se pinta en orden
          <SceneShape key={i} shape={shape} />
        ))}
      </g>
    </svg>
  )
}

function formatDate(raw?: string): string {
  if (!raw) return ""
  const time = new Date(raw).getTime()
  if (Number.isNaN(time)) return raw
  // La fecha del documento es la de la clínica, no la del navegador que imprime.
  return new Date(raw).toLocaleDateString(activeOrgLocale(), { timeZone: activeOrgTimeZone() })
}

/**
 * Gráfico oficial del odontograma (solo en clínicas de Perú: NTS 188; ADR
 * 0036): un SVG por fila con piezas, franja externa de números, recuadros de
 * siglas, coronas cuadradas de 5 zonas, raíces y overlays continuos de parejas
 * y tramos. El gráfico va en negro (5.17) y los hallazgos en rojo o azul
 * (5.12 y 5.13). Respeta los entries recibidos (el servidor entrega la
 * instantánea firmada). Se firma con el perfil, sin trazo (5.3): la hoja firmada
 * lleva la firma electrónica con su QR, y la vista previa, la línea «Firma y
 * sello». Componente puro, sin mutaciones ni queries; no
 * es la vista de boca, que es la misma en todos los países.
 */
export function OdontogramDocument({
  entries,
  standard,
  date,
  specifications,
  observations,
  examinerName,
  examinerTitle,
  registrationNumber,
  patientName,
  embedded,
}: OdontogramDocumentProps) {
  const {
    rows,
    specifications: specs,
    observations: notes,
  } = odontogramSheetScene(entries, {
    specifications,
    observations,
  })
  return (
    <div className="odontogram-document mx-auto w-full max-w-3xl bg-white p-4 text-gray-900">
      <style>{`@media print{.odontogram-document{max-width:none}.odontogram-document .odonto-doc-row-16{width:170mm}.odontogram-document .odonto-doc-row-10{width:106mm}.odontogram-document *{print-color-adjust:exact;-webkit-print-color-adjust:exact}}`}</style>
      <div
        role="img"
        aria-label={`Odontograma normativo de ${patientName ?? "la historia clínica"} con ${entries.length} hallazgos registrados.`}
      >
        {embedded ? null : (
          <header className="mb-3 flex items-start justify-between gap-4 border-b-2 border-gray-900 pb-2">
            <div>
              <h2 className="text-lg font-bold tracking-wide">ODONTOGRAMA</h2>
              <p className="text-[11px] text-gray-700">{standard} · Gráfico oficial</p>
              {patientName ? (
                <p className="mt-1 text-sm font-semibold">Paciente: {patientName}</p>
              ) : null}
            </div>
            <p className="shrink-0 text-sm">
              <span className="font-semibold">FECHA: </span>
              {formatDate(date)}
            </p>
          </header>
        )}

        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <section key={row.caption} aria-label={row.caption}>
              <DocRow row={row} />
            </section>
          ))}
        </div>

        <div className="mt-4 grid gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide">Especificaciones</h3>
            <div className="mt-1 min-h-16 whitespace-pre-wrap rounded-sm border border-gray-400 p-2 text-xs leading-relaxed">
              {specs.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide">Observaciones</h3>
            <div className="mt-1 min-h-16 whitespace-pre-wrap rounded-sm border border-gray-400 p-2 text-xs leading-relaxed">
              {notes.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </div>

        {embedded ? (
          embedded.signature
        ) : (
          <footer className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-gray-400 pt-3">
            <div className="text-xs">
              <p>
                <span className="font-semibold">Examinador: </span>
                {examinerName || ""}
                {examinerTitle ? ` · ${examinerTitle}` : ""}
              </p>
              <p className="mt-1">
                <span className="font-semibold">Colegiatura: </span>
                {registrationNumber || ""}
              </p>
            </div>
            <div className="text-center">
              <div className="h-20 w-64 border-b border-gray-800" aria-hidden="true" />
              <p className="mt-1 text-[11px] text-gray-700">Firma y sello</p>
            </div>
          </footer>
        )}
        <p className="mt-3 text-center text-[10px] text-gray-600">
          Fuente: Dirección de Salud Bucal - Dirección General de Intervenciones Estratégicas en
          Salud Pública
        </p>
      </div>

      <ul className="sr-only">
        {rows.flatMap((row) =>
          row.teeth.map((tooth) => {
            const own = entries.filter((e) => e.toothNumber === tooth)
            if (own.length === 0) return null
            return (
              <li key={`${row.caption}-${tooth}`}>
                {`Pieza ${tooth}: ${own
                  .map((e) => {
                    const abbr = sheetAbbreviation(e)
                    const scope = e.surface ? ` (${surfaceLabel(e.surface)})` : ""
                    return `${abbr ? `${abbr} · ` : ""}${conditionLabel(e.condition)}${scope}`
                  })
                  .join("; ")}`}
              </li>
            )
          }),
        )}
      </ul>
    </div>
  )
}
