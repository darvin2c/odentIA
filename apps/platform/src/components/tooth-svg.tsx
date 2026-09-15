import { useId } from "react";
import {
  conditionLabel,
  entryColor,
  statusLabel,
  surfaceLabel,
  toothTypeOf,
  type OdontogramEntry,
} from "../lib/patients";

export interface ToothSVGProps {
  toothNumber: number;
  entries: OdontogramEntry[];
  selected?: boolean;
  painting?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onPaint: (surface: string) => void;
}

const UPPER_QUADRANTS: Record<number, true> = { 1: true, 2: true, 5: true, 6: true };
const CROWN_BOX = { x0: 5, x1: 19, y0: 2.5, y1: 13.5, cx0: 9.5, cx1: 14.5, cy0: 5.5, cy1: 10.5 };

function silhouetteFor(type: "incisivo" | "canino" | "premolar" | "molar"): { crown: string; roots: string[] } {
  switch (type) {
    case "incisivo":
      return {
        crown: "M5 2.5 H19 V11 Q19 13.5 16.5 13.5 H7.5 Q5 13.5 5 11 Z",
        roots: ["M9.5 13.5 H14.5 L13 25 Q12.7 26.5 12 26.5 Q11.3 26.5 11 25 Z"],
      };
    case "canino":
      return {
        crown: "M5 5 L12 1.5 L19 5 V11 Q19 13.5 16.5 13.5 H7.5 Q5 13.5 5 11 Z",
        roots: ["M10 13.5 H14 L13 26 Q12.7 27 12 27 Q11.3 27 11 26 Z"],
      };
    case "premolar":
      return {
        crown: "M7 2.5 H17 Q19 2.5 19 5.5 V10 Q19 13.5 15 13.5 H9 Q5 13.5 5 10 V5.5 Q5 2.5 7 2.5 Z",
        roots: ["M10 13.5 H14 L13.4 24.5 Q13.2 26 12 26 Q10.8 26 10.6 24.5 Z"],
      };
    case "molar":
      return {
        crown: "M4 2.5 H20 V11 Q20 13.5 17.5 13.5 H6.5 Q4 13.5 4 11 Z",
        roots: [
          "M6.5 13.5 H10 L9.6 24 Q9.5 25.5 8.3 25.5 Q7.1 25.5 7 24 Z",
          "M14 13.5 H17.5 L17 24 Q16.9 25.5 15.7 25.5 Q14.5 25.5 14.4 24 Z",
        ],
      };
  }
}

interface ZoneDef {
  surface: string;
  points: string;
  dot: { cx: number; cy: number };
}

export function ToothSVG({
  toothNumber,
  entries,
  selected = false,
  painting = false,
  disabled = false,
  onSelect,
  onPaint,
}: ToothSVGProps) {
  const clipId = useId();
  const type = toothTypeOf(toothNumber);
  const quadrant = Math.trunc(toothNumber / 10);
  const upper = UPPER_QUADRANTS[quadrant] === true;
  const mesialOnRight = quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8;
  const innerSurface = upper ? "palatina" : "lingual";
  const centralSurface = type === "incisivo" || type === "canino" ? "incisal" : "oclusal";
  const { x0, x1, y0, y1, cx0, cx1, cy0, cy1 } = CROWN_BOX;

  const zones: ZoneDef[] = [
    { surface: mesialOnRight ? "distal" : "mesial", points: `${x0},${y0} ${cx0},${cy0} ${cx0},${cy1} ${x0},${y1}`, dot: { cx: 7.9, cy: 8 } },
    { surface: mesialOnRight ? "mesial" : "distal", points: `${x1},${y0} ${cx1},${cy0} ${cx1},${cy1} ${x1},${y1}`, dot: { cx: 16.1, cy: 8 } },
    { surface: innerSurface, points: `${x0},${y0} ${x1},${y0} ${cx1},${cy0} ${cx0},${cy0}`, dot: { cx: 12, cy: 4.3 } },
    { surface: "vestibular", points: `${x0},${y1} ${cx0},${cy1} ${cx1},${cy1} ${x1},${y1}`, dot: { cx: 12, cy: 11.7 } },
    { surface: centralSurface, points: `${cx0},${cy0} ${cx1},${cy0} ${cx1},${cy1} ${cx0},${cy1}`, dot: { cx: 12, cy: 8 } },
  ];

  const bySurface: Record<string, OdontogramEntry> = {};
  for (const entry of entries) {
    if (entry.surface && bySurface[entry.surface] === undefined) bySurface[entry.surface] = entry;
  }
  const whole = entries.find((entry) => !entry.surface) ?? null;
  const newest = entries[0] ?? null;
  const newestDetail = newest
    ? `${conditionLabel(newest.condition)}${newest.surface ? ` (${surfaceLabel(newest.surface)})` : " (pieza completa)"} · ${statusLabel(newest.status)}`
    : "sin hallazgos";
  const title = `Pieza ${toothNumber} — ${newestDetail}`;
  const pieceLabel = `Pieza ${toothNumber}: ${newestDetail}. Seleccionar pieza.`;

  const silhouette = silhouetteFor(type);
  const silhouetteFill = whole ? entryColor(whole.status) : "fill-white";
  const silhouetteStroke = selected ? "stroke-blue-700" : "stroke-gray-500";
  const interactive = painting && !disabled;

  const handleSelect = () => {
    if (!disabled) onSelect();
  };

  const renderSvg = (forPainting: boolean) => (
    <svg
      viewBox="0 0 24 28"
      className="h-12 w-10"
      strokeWidth={1.4}
      {...(forPainting
        ? { role: "group" as const, "aria-label": `Superficies de la pieza ${toothNumber}` }
        : { "aria-hidden": true })}
    >
      {!forPainting ? null : <title>{title}</title>}
      <defs><clipPath id={clipId}><path d={silhouette.crown} /></clipPath></defs>
      <g transform={upper ? "translate(0 28) scale(1 -1)" : undefined}>
      <g className={`${silhouetteFill} ${silhouetteStroke}`}>
        <path d={silhouette.crown} strokeLinejoin="round" />
        {silhouette.roots.map((d) => (
          <path key={d} d={d} strokeLinejoin="round" />
        ))}
      </g>
      {whole ? (
        <circle cx={20.6} cy={20} r={1.7} className={entryColor(whole.status)} stroke="#fff" strokeWidth={0.6} pointerEvents="none" aria-hidden="true" />
      ) : null}
      <g clipPath={`url(#${clipId})`}>
      {zones.map((zone) => {
        const winner = bySurface[zone.surface] ?? null;
        const painted = winner !== null;
        const zoneFill = painted ? entryColor(winner.status) : "fill-white";
        const common = {
          "data-surface": zone.surface,
          points: zone.points,
          className: zoneFill,
          stroke: "#9ca3af",
          strokeWidth: 0.4,
          fillOpacity: painted ? 1 : 0.55,
          style: { pointerEvents: interactive ? ("auto" as const) : ("none" as const) },
        };
        if (!forPainting) {
          return <polygon key={zone.surface} {...common} aria-hidden="true" />;
        }
        return (
          <polygon
            key={zone.surface}
            {...common}
            role="button"
            tabIndex={interactive ? 0 : -1}
            aria-label={`Superficie ${surfaceLabel(zone.surface)} de la pieza ${toothNumber}${painted ? `: ${conditionLabel(winner.condition)} · ${statusLabel(winner.status)}` : ": sin hallazgos"}`}
            aria-disabled={disabled || undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (!disabled) onPaint(zone.surface);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (!disabled) onPaint(zone.surface);
              }
            }}
          />
        );
      })}
      {zones.map((zone) => {
        const winner = bySurface[zone.surface] ?? null;
        if (!winner) return null;
        return (
          <circle
            key={`dot-${zone.surface}`}
            cx={zone.dot.cx}
            cy={zone.dot.cy}
            r={1.2}
            className={entryColor(winner.status)}
            stroke="#fff"
            strokeWidth={0.6}
            pointerEvents="none"
            aria-hidden="true"
          />
        );
      })}
      </g>
      </g>
    </svg>
  );

  const tileClass = `flex min-h-11 min-w-11 cursor-pointer flex-col items-center gap-0.5 rounded-md border bg-background p-1 transition-colors ${
    selected ? "border-blue-700 ring-2 ring-blue-600" : "hover:ring-2 hover:ring-ring"
  } ${disabled ? "cursor-not-allowed opacity-60" : ""}`;

  if (!painting) {
    return (
      <button
        type="button"
        data-tooth={toothNumber}
        onClick={handleSelect}
        disabled={disabled}
        aria-label={pieceLabel}
        aria-pressed={selected}
        title={title}
        className={tileClass}
      >
        {renderSvg(false)}
        <span aria-hidden="true" className="text-xs font-medium leading-none">
          {toothNumber}
        </span>
      </button>
    );
  }

  return (
    <div
      onClick={handleSelect}
      title={title}
      data-tooth={toothNumber}
      className={`${tileClass} ${disabled ? "" : "hover:ring-2 hover:ring-ring"}`}
    >
      {renderSvg(true)}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleSelect();
        }}
        disabled={disabled}
        aria-label={pieceLabel}
        aria-pressed={selected}
        className="rounded px-1 text-xs font-medium leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {toothNumber}
      </button>
    </div>
  );
}
