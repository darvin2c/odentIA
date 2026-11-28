import { Badge, Button, cn } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { DetailDrawer } from "../detail/detail-drawer.js"
import { demoProductImage } from "../story-fixtures.js"
import { TaskCard } from "../task-card.js"
import { ScheduleDayStrip } from "./day-strip.js"
import {
  type ScheduleDropTarget,
  ScheduleDropProvider,
  ScheduleStepArrow,
  useScheduleDraggable,
  useScheduleDropTarget,
} from "./drop.js"
import { addDays, formatDateLong } from "./time.js"

/**
 * La franja de días con su número, el feriado y flechas de 44 px; y mantener y arrastrar una
 * entrega a otro día o a otra franja. Al soltar no se mueve nada: se abre «Pasar a…» ya lleno,
 * donde se confirma. Con el teclado: Alt+Intro sobre la tarjeta, flechas e Intro.
 */
const meta = {
  title: "Patrones/Agenda/Días y arrastrar",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const MONDAY = "2026-11-23"
const TODAY = "2026-11-26"
const HOLIDAY = "2026-12-08"
const week = (monday: string) => Array.from({ length: 7 }, (_, index) => addDays(monday, index))
const COUNTS: Record<string, number> = {
  "2026-11-23": 5,
  "2026-11-24": 4,
  "2026-11-25": 5,
  "2026-11-26": 19,
  "2026-11-27": 9,
  "2026-11-28": 4,
  "2026-12-08": 1,
  "2026-12-09": 1,
}
/** La agenda de siempre: solo qué tan lleno está cada día. */
const agendaLoad = (date: string) => ({
  count: COUNTS[date] ?? 0,
  level: (COUNTS[date] ? Math.min(3, Math.ceil((COUNTS[date] ?? 0) / 6)) : 0) as 0 | 1 | 2 | 3,
})
const load = (date: string) => ({
  count: COUNTS[date] ?? 0,
  level: (COUNTS[date] ? Math.min(3, Math.ceil((COUNTS[date] ?? 0) / 6)) : 0) as 0 | 1 | 2 | 3,
  holiday: date === HOLIDAY ? "Inmaculada Concepción" : undefined,
  alert: date === TODAY ? "algo no se entregó" : undefined,
})

/** La de la Agenda de siempre (puntos) y la de una lista de entregas (número, feriado, flechas de 44 px). */
export const Franjas: Story = {
  render: () => {
    const [day, setDay] = useState(TODAY)
    const [monday, setMonday] = useState(MONDAY)
    return (
      <div className="flex min-h-svh flex-col gap-8 bg-canvas p-4 sm:p-6">
        <section className="flex max-w-3xl flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Agenda (como siempre)</h2>
          <ScheduleDayStrip
            dates={week(monday).slice(0, 6)}
            value={day}
            today={TODAY}
            onChange={setDay}
            onPrevious={() => setMonday(addDays(monday, -7))}
            onNext={() => setMonday(addDays(monday, 7))}
            load={agendaLoad}
          />
        </section>
        <section className="flex max-w-3xl flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Entregas: el número de cada día, con las flechas arriba
          </h2>
          <div className="flex items-center gap-1">
            <ScheduleStepArrow direction={-1} label="Semana anterior" onStep={() => setMonday(addDays(monday, -7))} />
            <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
              {formatDateLong(monday)} a {formatDateLong(addDays(monday, 6))}
            </span>
            <ScheduleStepArrow direction={1} label="Semana siguiente" onStep={() => setMonday(addDays(monday, 7))} />
          </div>
          <ScheduleDayStrip
            dates={week(monday)}
            value={day}
            today={TODAY}
            onChange={setDay}
            load={load}
            loadDisplay="count"
            noun={["entrega", "entregas"]}
          />
          <Button variant="outline" className="h-11 self-start" onClick={() => setMonday("2026-12-07")}>
            Ver la semana del feriado
          </Button>
        </section>
        <section className="flex max-w-3xl flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Con sus flechas de 44 px a los lados</h2>
          <ScheduleDayStrip
            dates={week(monday).slice(0, 6)}
            value={day}
            today={TODAY}
            onChange={setDay}
            onPrevious={() => setMonday(addDays(monday, -7))}
            onNext={() => setMonday(addDays(monday, 7))}
            load={load}
            loadDisplay="count"
            noun={["entrega", "entregas"]}
            arrowSize="touch"
          />
        </section>
      </div>
    )
  },
}

interface Entrega {
  id: string
  clienta: string
  fecha: string
  franja: "manana" | "tarde"
  etapa: { label: string; tone: "soft" | "success" | "warning" }
  lleva: string
  toca?: { texto: string; boton: string }
  sigue?: string
  color: string
}

const FRANJAS = [
  { id: "manana", label: "Mañana · 9 a 1" },
  { id: "tarde", label: "Tarde · 2 a 6" },
] as const

const ENTREGAS: Entrega[] = [
  {
    id: "0169",
    clienta: "Brenda Choque",
    fecha: TODAY,
    franja: "tarde",
    etapa: { label: "Preparando", tone: "soft" },
    lleva: "Botín de tacón con pasador · negro · 37",
    toca: { texto: "Empácalo y dáselo a Jhon. Sale de 2 a 6 p. m.", boton: "Empacar" },
    color: "#1f1f1f",
  },
  {
    id: "0157",
    clienta: "Mónica Salas",
    fecha: TODAY,
    franja: "tarde",
    etapa: { label: "Por salir", tone: "soft" },
    lleva: "Sandalia de tiras · dorado · 37",
    sigue: "Sigue solo: Jhon lo recoge y toca «Salí». Cobra S/ 99 en la puerta.",
    color: "#7a4a22",
  },
  {
    id: "0150",
    clienta: "Claudia Ramos",
    fecha: TODAY,
    franja: "manana",
    etapa: { label: "Entregado", tone: "success" },
    lleva: "Mocasín con borla · marrón · 40",
    sigue: "Entregado por Kevin.",
    color: "#5b3a24",
  },
]

const FRANJA_NOMBRE: Record<string, string> = { manana: "mañana", tarde: "tarde" }
const decir = (target: ScheduleDropTarget) =>
  [target.date ? formatDateLong(target.date) : null, target.slot ? FRANJA_NOMBRE[target.slot] : null]
    .filter(Boolean)
    .join(", ")

function Franja({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  const drop = useScheduleDropTarget({ date: TODAY, slot: id })
  return (
    <section
      aria-label={label}
      {...drop.props}
      className={cn(
        "flex min-h-24 flex-col gap-2 rounded-2xl border border-transparent bg-muted/40 p-2 transition-colors",
        drop.active && "border-dashed border-border",
        drop.over && "border-primary bg-primary-soft",
      )}
    >
      <h3 className="px-1 text-sm font-semibold">{label}</h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  )
}

function Tarjeta({ e, onOpen }: { e: Entrega; onOpen: (e: Entrega) => void }) {
  const drag = useScheduleDraggable({
    id: e.id,
    title: `${e.clienta}, pedido ${e.id}`,
    from: { date: e.fecha, slot: e.franja },
    disabled: e.etapa.label === "Entregado",
    ghost: () => (
      <span className="flex items-center gap-2">
        <img src={demoProductImage(e.color)} alt="" className="size-9 rounded-lg" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <b className="truncate">{e.clienta}</b>
            <Badge variant={e.etapa.tone}>{e.etapa.label}</Badge>
          </span>
          <span className="truncate text-xs text-muted-foreground">Suéltala en un día o una franja</span>
        </span>
      </span>
    ),
  })
  return (
    <TaskCard
      {...drag}
      title={e.clienta}
      reference={e.id}
      image={demoProductImage(e.color)}
      status={<Badge variant={e.etapa.tone}>{e.etapa.label}</Badge>}
      details={[e.lleva, `${FRANJA_NOMBRE[e.franja]} · Jhon · Independencia`]}
      owner={e.toca ? "person" : "auto"}
      task={e.toca?.texto ?? e.sigue}
      actionLabel={e.toca?.boton}
      onOpen={() => onOpen(e)}
    />
  )
}

/**
 * Mantener una entrega (o arrastrarla con el mouse) y soltarla en otro día de la franja de días o
 * en otra franja abre «Pasar a…» ya lleno; soltarla donde estaba no hace nada. Lo entregado no se
 * levanta. Quedarse sobre la flecha pasa de semana.
 */
export const MantenerYArrastrar: Story = {
  render: () => {
    const [day, setDay] = useState(TODAY)
    const [monday, setMonday] = useState(MONDAY)
    const [cajon, setCajon] = useState<{ e: Entrega; pasar?: ScheduleDropTarget } | null>(null)
    const porId = (id: string) => ENTREGAS.find((e) => e.id === id)
    return (
      <ScheduleDropProvider
        describe={decir}
        hint="Suéltala en un día o en una franja."
        onDrop={(id, target) => {
          const e = porId(id)
          if (e) setCajon({ e, pasar: target })
        }}
      >
        <div className="flex min-h-svh flex-col gap-4 bg-canvas p-4 sm:p-6">
          <div className="flex max-w-3xl items-center gap-1">
            <ScheduleStepArrow direction={-1} label="Semana anterior" onStep={() => setMonday(addDays(monday, -7))} />
            <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold" aria-live="polite">
              {formatDateLong(monday)} a {formatDateLong(addDays(monday, 6))}
            </span>
            <ScheduleStepArrow direction={1} label="Semana siguiente" onStep={() => setMonday(addDays(monday, 7))} />
          </div>
          <ScheduleDayStrip
            className="max-w-3xl"
            dates={week(monday)}
            value={day}
            today={TODAY}
            onChange={setDay}
            load={load}
            loadDisplay="count"
            noun={["entrega", "entregas"]}
          />
          <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
            {FRANJAS.map((franja) => (
              <Franja key={franja.id} id={franja.id} label={franja.label}>
                {ENTREGAS.filter((e) => e.franja === franja.id).map((e) => (
                  <Tarjeta key={e.id} e={e} onOpen={(x) => setCajon({ e: x })} />
                ))}
              </Franja>
            ))}
          </div>
        </div>
        <DetailDrawer
          open={cajon != null}
          dock={false}
          title={cajon ? `${cajon.e.clienta} · ${cajon.e.id}` : ""}
          description={cajon?.pasar ? "Pasar a…" : "Lo que toca"}
          onClose={() => setCajon(null)}
          actions={
            cajon?.pasar ? (
              <Button type="button" className="h-11" onClick={() => setCajon(null)}>
                Pasar a {decir(cajon.pasar)}
              </Button>
            ) : undefined
          }
        >
          <p className="text-sm">
            {cajon?.pasar
              ? `Ya lleno: ${decir(cajon.pasar)}. Nada se movió todavía; se confirma aquí.`
              : (cajon?.e.toca?.texto ?? cajon?.e.sigue)}
          </p>
        </DetailDrawer>
      </ScheduleDropProvider>
    )
  },
}
