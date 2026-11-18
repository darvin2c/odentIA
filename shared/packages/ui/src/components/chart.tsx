import { Chart } from "@tanstack/charts/react";
import type { ChartValue, DomChartDefinition } from "@tanstack/charts";
import { cn } from "cn";
import type { JSX, ReactNode } from "react";

export interface ChartContainerProps<
  TDatum = unknown,
  TXValue extends ChartValue = ChartValue,
  TYValue extends ChartValue = ChartValue,
> {
  /** Título visible del gráfico; también es su nombre accesible. */
  title: string;
  /** Resumen de lo que muestra el gráfico (lectores de pantalla). */
  summary: string;
  /** Definición memoizada de `@tanstack/charts` (vía `defineChart`). */
  definition: DomChartDefinition<TDatum, TXValue, TYValue>;
  /** Alto fijo de la escena en píxeles. */
  height?: number;
  className?: string;
  /** Contenido bajo el gráfico (leyendas con valores exactos). */
  children?: ReactNode;
}

/**
 * Envoltorio de bajo nivel para los gráficos del dashboard.
 *
 * - Theming: el adaptador pinta con los tokens `--ts-chart-1..6`, que
 *   `globals.css` deriva de `--chart-1..5` del tema (claro/oscuro automático).
 * - Movimiento reducido: el renderer SVG respeta `prefers-reduced-motion` por
 *   defecto (`respectReducedMotion`), más el refuerzo CSS de `globals.css`.
 * - SSR: `@tanstack/charts/react` es SSR-safe (spike verificado en Node puro:
 *   importar y `renderToString` emiten el SVG completo con `role="img"` sin
 *   tocar `window`), así que se renderiza directo sin guard de montaje para
 *   no romper la hidratación.
 * - a11y: `title` y `summary` son obligatorios; el título se muestra y el
 *   resumen viaja como descripción accesible (más copia sr-only).
 */
export function ChartContainer<
  TDatum,
  TXValue extends ChartValue,
  TYValue extends ChartValue,
>(props: ChartContainerProps<TDatum, TXValue, TYValue>): JSX.Element {
  const { title, summary, definition, height = 280, className, children } = props;
  return (
    <figure className={cn("flex flex-col gap-3 rounded-md bg-card p-4 sm:p-6", className)}>
      <figcaption className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="sr-only">{summary}</span>
      </figcaption>
      <Chart
        definition={definition}
        height={height}
        ariaLabel={title}
        ariaDescription={summary}
      />
      {children}
    </figure>
  );
}
