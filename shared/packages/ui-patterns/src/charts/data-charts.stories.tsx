import type { Meta, StoryObj } from "@storybook/react"
import { PageShell } from "../page-shell.js"
import { type ChartCategory, ColumnChart, HeatmapGrid, LineChart, ShareBar, Sparkline, WaterfallChart, type WaterfallStep } from "./index.js"

/**
 * Gráficos de datos de Reportes. Cada marca es un control: se recorre con el
 * teclado, dice su detalle al pasar el mouse y todos ofrecen «Ver como tabla».
 * Colores `--series-1..3`, `--series-muted` y `--scale-0..4` (ver `globals.css`).
 */
const meta = {
  title: "Patrones/Gráficos de datos",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const MONTHS: ChartCategory[] = [
  ["oct", "Octubre de 2025"],
  ["nov", "Noviembre de 2025"],
  ["dic", "Diciembre de 2025"],
  ["ene", "Enero de 2026"],
  ["feb", "Febrero de 2026"],
  ["mar", "Marzo de 2026"],
  ["abr", "Abril de 2026"],
  ["may", "Mayo de 2026"],
  ["jun", "Junio de 2026"],
  ["jul", "Julio de 2026"],
  ["ago", "Agosto de 2026"],
  ["sep", "Septiembre de 2026"],
].map(([short, label], index) => ({ key: String(index), short: short ?? "", label: label ?? "", partial: index === 11 }))

const soles = (cents: number): string => `S/ ${Math.round(cents).toLocaleString("en-US").split(",").join(" ")}`
const thousands = (value: number): string => (value === 0 ? "0" : `${Math.round(value / 1000)} mil`)

/** La línea pequeña junto a cada cifra del Resumen. */
export const LineaPequena: Story = {
  render: () => (
    <PageShell className="flex flex-col gap-4">
      <div className="elevated flex w-80 flex-col gap-1 rounded-xl border bg-card p-4">
        <span className="text-[13px] font-bold text-muted-foreground">Cobrado</span>
        <div className="flex items-end justify-between gap-3">
          <span className="text-3xl font-extrabold tracking-tight">S/ 48 200</span>
          <Sparkline
            values={[38_900, 40_200, 35_100, 33_800, 37_500, 41_900, 40_700, 43_300, 42_100, 45_800, 44_600, 48_200]}
            label="Cobrado en los últimos 12 meses: sube de 38 900 a 48 200"
          />
        </div>
      </div>
      <div className="elevated flex w-80 flex-col gap-1 rounded-xl border bg-card p-4">
        <span className="text-[13px] font-bold text-muted-foreground">Clínica nueva: dos meses con datos</span>
        <Sparkline values={[null, null, null, null, null, null, null, null, null, null, 12, 19]} label="Pacientes nuevos: 12 y 19 en los dos meses con datos" />
      </div>
    </PageShell>
  ),
}

/** Cobrado por mes con el año anterior y la meta; el mes en curso va rayado. */
export const CobradoPorMes: Story = {
  render: () => (
    <PageShell>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Cobrado por mes</h2>
        <ColumnChart
          title="Cobrado por mes, con el año anterior y la meta"
          categories={MONTHS}
          bars={[{ key: "cobrado", label: "Este año", tone: "series-1", values: [38_900, 40_200, 35_100, 33_800, 37_500, 41_900, 40_700, 43_300, 42_100, 45_800, 44_600, 31_200] }]}
          line={{ key: "antes", label: "Un año antes", values: [34_100, 35_900, 31_200, 30_400, 33_000, 36_800, 36_100, 38_900, 37_300, 40_100, 39_200, 41_800] }}
          reference={{ value: 50_000, label: "Meta S/ 50 000" }}
          format={soles}
          axis={thousands}
        />
      </section>
    </PageShell>
  ),
}

const ATTENDED = [312, 330, 270, 255, 298, 341, 335, 352, 344, 371, 365, 210]
const NO_SHOW = [31, 29, 33, 30, 26, 27, 25, 24, 26, 23, 25, 14]
const CANCELLED = [22, 25, 31, 28, 20, 19, 22, 18, 21, 17, 19, 9]

/** Citas por mes y cómo terminaron: columnas apiladas con tres series y su total en la tabla. */
export const CitasApiladas: Story = {
  render: () => (
    <PageShell>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Citas por mes y cómo terminaron</h2>
        <ColumnChart
          title="Citas por mes: atendidas, no vinieron y canceladas"
          categories={MONTHS}
          stacked
          total={{ label: "Citas que ya pasaron", values: ATTENDED.map((value, index) => value + (NO_SHOW[index] ?? 0) + (CANCELLED[index] ?? 0)) }}
          bars={[
            { key: "atendidas", label: "Atendidas", tone: "series-1", values: ATTENDED },
            { key: "no-vino", label: "No vinieron", tone: "series-2", values: NO_SHOW },
            { key: "canceladas", label: "Canceladas", tone: "series-3", values: CANCELLED },
          ]}
          format={(value) => `${value} citas`}
          axis={String}
        />
      </section>
    </PageShell>
  ),
}

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
const HOURS = Array.from({ length: 12 }, (_, index) => 8 + index)
const clock = (hour: number): string => (hour < 12 ? `${hour} a. m.` : hour === 12 ? "12 p. m." : `${hour - 12} p. m.`)
const WEEK = DAYS.map((_, row) => HOURS.map((hour, column) => (row === 5 && hour >= 13 ? null : Math.max(5, Math.min(98, 55 + ((row * 7 + column * 13) % 40) - (hour >= 15 && hour < 18 ? 30 : 0))))))

/** Semana tipo: cuánto se ocupó cada hora; el sábado por la tarde no hay horario. */
export const SemanaTipo: Story = {
  render: () => (
    <PageShell>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Cuándo queda libre la agenda</h2>
        <HeatmapGrid
          title="Semana tipo de septiembre: cuánto se ocupó cada hora"
          rows={DAYS.map((day) => ({ key: day, label: day.slice(0, 3), name: day }))}
          columns={HOURS.map((hour) => ({ key: String(hour), label: hour === 13 ? "1 p. m." : String(hour > 12 ? hour - 12 : hour), name: clock(hour) }))}
          values={WEEK}
          max={100}
          format={(value) => `${value} %`}
          describe={(row, column, value) => `${DAYS[row]} de ${clock(HOURS[column] ?? 8)} a ${clock((HOURS[column] ?? 8) + 1)}: ${value === null ? "sin horario" : `${value} % ocupada`}`}
          legend={{ low: "Libre", high: "Ocupada", noData: "Sin horario" }}
          initial={{ row: 1, column: 7 }}
          cellHeight={32}
          detail={(row, column, value) => (
            <>
              <strong>
                {DAYS[row]} de {clock(HOURS[column] ?? 8)} a {clock((HOURS[column] ?? 8) + 1)}
              </strong>
              <span className="text-2xl font-extrabold">{value === null ? "Sin horario" : `${value} % ocupada`}</span>
              <span className="text-sm text-muted-foreground">{value === null ? "Ningún profesional atiende a esa hora." : `${Math.round((26 * (100 - value)) / 100)} de 26 horas libres en septiembre`}</span>
            </>
          )}
        />
      </section>
    </PageShell>
  ),
}

/** Lo que dejó el mes repartido en tres partes. */
export const BarraRepartida: Story = {
  render: () => (
    <PageShell>
      <section className="elevated flex max-w-xl flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">De dónde llegaron los pacientes nuevos</h2>
        <ShareBar
          title="Pacientes nuevos por cómo nos conocieron"
          format={String}
          parts={[
            { key: "recomendacion", label: "Recomendación", value: 17, tone: "series-1" },
            { key: "redes", label: "Redes sociales", value: 11, tone: "series-2" },
            { key: "google", label: "Google o mapas", value: 6, tone: "series-3" },
            { key: "otro", label: "Otro", value: 4, tone: "muted" },
          ]}
        />
      </section>
    </PageShell>
  ),
}

const SEPTEMBER: WaterfallStep[] = [
  { key: "cobrado", label: "Cobrado", value: 4_820_000, kind: "total" },
  { key: "comisiones", label: "Comisiones", value: 1_711_500, kind: "less", tone: "series-2" },
  { key: "personal", label: "Personal", value: 620_000, kind: "less" },
  { key: "laboratorio", label: "Laboratorio", value: 495_000, kind: "less" },
  { key: "alquiler", label: "Alquiler", value: 350_000, kind: "less" },
  { key: "materiales", label: "Materiales", value: 290_000, kind: "less" },
  { key: "servicios", label: "Servicios", value: 110_000, kind: "less" },
  { key: "otros", label: "Otros", value: 40_000, kind: "less" },
  { key: "deja", label: "Lo que deja", value: 1_203_500, kind: "result" },
]

/** De lo cobrado a lo que deja el mes: la comisión en su propia barra y cada tipo de gasto que tuvo algo. */
export const Cascada: Story = {
  render: () => (
    <PageShell className="flex flex-col gap-6">
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h3 className="font-semibold">De lo cobrado a lo que deja el mes</h3>
        <WaterfallChart
          title="De lo cobrado a lo que deja septiembre"
          steps={SEPTEMBER}
          format={soles}
          short={(cents) => Math.round(cents / 100).toLocaleString("en-US").split(",").join(" ")}
          share={{ heading: "De cada 100 cobrados", value: (index) => String(Math.round(((SEPTEMBER[index]?.value ?? 0) * 100) / 4_820_000)) }}
          detail={(index) => {
            const step = SEPTEMBER[index]
            if (!step) return null
            return (
              <>
                <strong className="text-[15px]">{step.label}</strong>
                <span className="text-2xl font-extrabold tabular-nums">{soles(step.value)}</span>
                <span className="text-sm text-muted-foreground">{Math.round((step.value * 100) / 4_820_000)} de cada 100 soles cobrados</span>
              </>
            )
          }}
        />
      </section>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h3 className="font-semibold">Un mes que no alcanzó: se gastó más de lo cobrado</h3>
        <WaterfallChart
          title="Un mes con pérdida"
          steps={[
            { key: "cobrado", label: "Cobrado", value: 1_200_000, kind: "total" },
            { key: "comisiones", label: "Comisiones", value: 420_000, kind: "less", tone: "series-2" },
            { key: "personal", label: "Personal", value: 650_000, kind: "less" },
            { key: "alquiler", label: "Alquiler", value: 350_000, kind: "less" },
            { key: "deja", label: "Lo que deja", value: -220_000, kind: "result" },
          ]}
          format={(cents) => (cents < 0 ? `−${soles(-cents)}` : soles(cents))}
          short={(cents) => (cents < 0 ? "−" : "") + Math.round(Math.abs(cents) / 100).toLocaleString("en-US").split(",").join(" ")}
          height={220}
        />
      </section>
    </PageShell>
  ),
}

const VISITS: ChartCategory[] = [
  { key: "2026-02-14", label: "14 de febrero", short: "14 feb" },
  { key: "2026-04-18", label: "18 de abril", short: "18 abr" },
  { key: "2026-06-13", label: "13 de junio", short: "13 jun" },
  { key: "2026-08-12", label: "12 de agosto", short: "12 ago" },
  { key: "2026-10-23", label: "23 de octubre", short: "23 oct" },
]

/** La presión de cada atención en el tiempo: dos líneas, un eje que no empieza en cero y una visita sin medir. */
export const PresionEnElTiempo: Story = {
  render: () => (
    <PageShell>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Presión arterial</h2>
        <LineChart
          title="Presión arterial en cada atención: la sistólica baja de 142 a 118 y la diastólica de 92 a 76"
          categories={VISITS}
          series={[
            { key: "sistolica", label: "Sistólica", tone: "series-1", values: [142, 136, null, 124, 118] },
            { key: "diastolica", label: "Diastólica", tone: "series-2", values: [92, 88, null, 80, 76] },
          ]}
          format={(value) => `${value} mmHg`}
          axis={String}
        />
      </section>
      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h3 className="font-semibold">Peso</h3>
        <LineChart
          title="Peso en cada atención: baja de 68 a 62 kilos"
          categories={VISITS}
          series={[{ key: "peso", label: "Peso", tone: "series-1", values: [68, 67, 65.5, 64, 62] }]}
          format={(value) => `${value.toLocaleString("es-PE")} kg`}
          axis={String}
        />
      </section>
    </PageShell>
  ),
}
