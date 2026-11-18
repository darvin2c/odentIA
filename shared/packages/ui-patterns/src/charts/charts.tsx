import { barX, barY, defineChart, lineY } from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { ChartContainer, cn } from "@odentia/ui";
import { useMemo, type JSX } from "react";

export interface ChartPoint {
  label: string;
  value: number;
}

/**
 * Paleta categórica de datos (`--series-1..3`, comprobada para daltonismo en
 * `globals.css`). De la cuarta categoría en adelante van en gris: la leyenda
 * con valores las nombra, el color no alcanza para distinguir más de tres.
 */
const PALETA = ["var(--series-1)", "var(--series-2)", "var(--series-3)"] as const;
const RESTO = "var(--series-muted)";

function colorDe(indice: number): string {
  return PALETA[indice] ?? RESTO;
}

function paletaPara(cantidad: number): string[] {
  return Array.from({ length: cantidad }, (_, i) => colorDe(i));
}

/**
 * Leyenda con valores exactos: los gráficos de porciones y etapas no rotulan
 * cada marca dentro del SVG, así que la lista visible es la alternativa
 * textual (además del `summary` para lectores de pantalla).
 */
function LeyendaConValores(props: {
  entradas: { label: string; value: number; detail?: string }[];
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {props.entradas.map((entrada, i) => (
        <li key={entrada.label} className="flex items-baseline gap-2 text-sm">
          <span
            aria-hidden
            className="size-2.5 shrink-0 translate-y-[-1px] rounded-full"
            style={{ backgroundColor: colorDe(i) }}
          />
          <span className="font-medium text-foreground">{entrada.label}</span>
          {entrada.detail ? (
            <span className="text-muted-foreground">{entrada.detail}</span>
          ) : null}
          <span className="ml-auto font-semibold tabular-nums text-foreground">
            {entrada.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FunnelChart(props: {
  title: string;
  summary: string;
  className?: string;
  /** Etapas ordenadas de arriba abajo. */
  stages: { label: string; value: number; detail?: string }[];
}): JSX.Element {
  const { title, summary, className, stages } = props;
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barX(stages, {
            x: "value",
            y: "label",
            color: "label",
            key: "label",
            inset: 2,
            maxThickness: 48,
          }),
        ],
        scales: {
          x: { scale: scaleLinear, nice: true, grid: true },
          y: {
            scale: () =>
              scaleBand<string>()
                .domain(stages.map((etapa) => etapa.label))
                .padding(0.25),
          },
        },
        color: {
          domain: stages.map((etapa) => etapa.label),
          range: paletaPara(stages.length),
        },
      }),
    [stages],
  );
  return (
    <ChartContainer
      title={title}
      summary={summary}
      definition={definition}
      className={cn(className)}
    >
      <LeyendaConValores entradas={stages} />
    </ChartContainer>
  );
}

export function DonutChart(props: {
  title: string;
  summary: string;
  className?: string;
  segments: { label: string; value: number }[];
}): JSX.Element {
  const { title, summary, className, segments } = props;
  // `pie` reparte los valores en intervalos angulares; es ávido, así que se
  // memoiza junto con la definición que lo consume.
  const definition = useMemo(() => {
    const porciones = pie(segments, { value: "value" });
    return defineChart({
      marks: [
        polar({
          inset: 8,
          radiusRatio: 0.82,
          marks: [
            radialArc(porciones, {
              innerRadius: ({ radius }) => radius * 0.58,
              cornerRadius: 4,
              color: "label",
              key: "label",
            }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      color: {
        domain: segments.map((segmento) => segmento.label),
        range: paletaPara(segments.length),
      },
    });
  }, [segments]);
  return (
    <ChartContainer
      title={title}
      summary={summary}
      definition={definition}
      className={cn(className)}
    >
      <LeyendaConValores entradas={segments} />
    </ChartContainer>
  );
}

export function TrendChart(props: {
  title: string;
  summary: string;
  className?: string;
  /** Serie temporal en orden cronológico. */
  points: ChartPoint[];
}): JSX.Element {
  const { title, summary, className, points } = props;
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          lineY(points, {
            x: "label",
            y: "value",
            points: true,
            stroke: "var(--series-1)",
            key: "label",
          }),
        ],
        scales: {
          x: {
            scale: () =>
              scalePoint<string>()
                .domain(points.map((punto) => punto.label))
                .padding(0.2),
          },
          y: { scale: scaleLinear, nice: true, grid: true },
        },
      }),
    [points],
  );
  return (
    <ChartContainer
      title={title}
      summary={summary}
      definition={definition}
      className={className}
    />
  );
}

export function BarChart(props: {
  title: string;
  summary: string;
  className?: string;
  bars: ChartPoint[];
}): JSX.Element {
  const { title, summary, className, bars } = props;
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(bars, {
            x: "label",
            y: "value",
            fill: "var(--series-1)",
            key: "label",
            inset: 2,
          }),
        ],
        scales: {
          x: {
            scale: () =>
              scaleBand<string>()
                .domain(bars.map((barra) => barra.label))
                .padding(0.16),
          },
          y: { scale: scaleLinear, nice: true, grid: true },
        },
      }),
    [bars],
  );
  return (
    <ChartContainer
      title={title}
      summary={summary}
      definition={definition}
      className={className}
    />
  );
}
