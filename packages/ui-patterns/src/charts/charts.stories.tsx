import type { Meta, StoryObj } from "@storybook/react";
import { PageShell } from "../page-shell.js";
import { BarChart, DonutChart, FunnelChart, TrendChart } from "./index.js";

/**
 * Gráficos del pulso del home: embudo comercial, canales, autonomía del
 * agente y cobros. Todos exigen `title` + `summary` (nombre y descripción
 * accesible) y heredan la paleta `--chart-1..5` del tema, así el modo oscuro
 * funciona sin lógica extra.
 */
const meta = {
  title: "Patrones/Charts",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Embudo de oportunidades por etapa, de arriba abajo, con importes. */
export const Embudo: Story = {
  render: () => (
    <PageShell>
      <FunnelChart
        title="Embudo comercial"
        summary="De 24 primeras visitas, 15 pasaron a diagnóstico, 9 recibieron presupuesto y 5 iniciaron tratamiento."
        stages={[
          { label: "Primera visita", value: 24, detail: "24 pacientes" },
          { label: "Diagnóstico", value: 15, detail: "15 pacientes" },
          { label: "Presupuesto enviado", value: 9, detail: "9 presupuestos" },
          { label: "Tratamiento iniciado", value: 5, detail: "5 tratamientos" },
        ]}
      />
    </PageShell>
  ),
};

/** Conversaciones abiertas por canal de origen. */
export const Canales: Story = {
  render: () => (
    <PageShell>
      <DonutChart
        title="Conversaciones por canal"
        summary="75 conversaciones abiertas: 42 por WhatsApp, 18 por Instagram, 9 por teléfono y 6 por la web."
        segments={[
          { label: "WhatsApp", value: 42 },
          { label: "Instagram", value: 18 },
          { label: "Teléfono", value: 9 },
          { label: "Web", value: 6 },
        ]}
      />
    </PageShell>
  ),
};

/** Corridas correctas del agente en los últimos 7 días. */
export const Autonomia: Story = {
  render: () => (
    <PageShell>
      <TrendChart
        title="Autonomía del agente"
        summary="Corridas correctas por día durante la última semana, entre 11 y 19 al día."
        points={[
          { label: "lun 21", value: 12 },
          { label: "mar 22", value: 15 },
          { label: "mié 23", value: 11 },
          { label: "jue 24", value: 17 },
          { label: "vie 25", value: 19 },
          { label: "sáb 26", value: 14 },
          { label: "dom 27", value: 13 },
        ]}
      />
    </PageShell>
  ),
};

/** Tratamientos realizados por tipo en la última semana. */
export const Tratamientos: Story = {
  render: () => (
    <PageShell>
      <BarChart
        title="Tratamientos de la semana"
        summary="22 limpiezas, 14 ortodoncias, 8 endodoncias y 5 implantes en la última semana."
        bars={[
          { label: "Limpieza", value: 22 },
          { label: "Ortodoncia", value: 14 },
          { label: "Endodoncia", value: 8 },
          { label: "Implantes", value: 5 },
        ]}
      />
    </PageShell>
  ),
};
