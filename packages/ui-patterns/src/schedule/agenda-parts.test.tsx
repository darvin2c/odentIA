// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { type ScheduleAgendaItem, ScheduleAgendaList } from "./agenda-list.js"
import { ScheduleDayStrip } from "./day-strip.js"
import { daySegments } from "./occupancy.js"
import { ScheduleResourceChips } from "./resource-chips.js"
import { type ScheduleSlotChoice, ScheduleSlotChoices } from "./slot-choices.js"
import { ScheduleStatusSummary } from "./status-summary.js"
import { setupScheduleDom } from "./test-utils.js"
import { addDays, minutesToInstant, zonedDateOf } from "./time.js"
import { initialsOf, scheduleToneAt } from "./tone.js"
import type { ScheduleColumn, ScheduleEntry, ScheduleStatus } from "./types.js"
import { ScheduleWeekOverview } from "./week-overview.js"

setupScheduleDom()

// Clínica de ejemplo, determinista: Lima, lunes 12 de octubre de 2026 a las 10:20.
const TZ = "America/Lima"
const AGENDA_TODAY = "2026-10-12"
const AGENDA_NOW = minutesToInstant(AGENDA_TODAY, 10 * 60 + 20, TZ)
/** Lunes a sábado. */
const AGENDA_WEEK = Array.from({ length: 6 }, (_, index) => addDays(AGENDA_TODAY, index))
const AGENDA_PROFESSIONALS: ScheduleColumn[] = [
  { id: "ana", label: "Dra. Ana Torres", tone: 0 },
  { id: "luis", label: "Dr. Luis Vega", tone: 1 },
  { id: "carla", label: "Dra. Carla Ruiz", tone: 2 },
  { id: "diego", label: "Dr. Diego Salas", tone: 3 },
  { id: "paula", label: "Dra. Paula Mena", tone: 4 },
]
const P: ScheduleStatus = "programada"
const C: ScheduleStatus = "confirmada"
const A: ScheduleStatus = "atendida"
/** Las citas del lunes: recurso, hora, minutos, persona, servicio y estado. */
const ROWS: Array<[string, string, number, string, string, ScheduleStatus]> = [
  ["ana", "08:30", 45, "Jorge Salas", "Limpieza", A],
  ["ana", "09:30", 45, "Rosa Quispe", "Limpieza", A],
  ["ana", "10:15", 45, "Elena Huamán", "Obturación", C],
  ["ana", "11:30", 30, "Lucía Fernández", "Control", P],
  ["ana", "12:30", 60, "Pedro Castillo", "Endodoncia", C],
  ["luis", "09:00", 30, "Carlos Paredes", "Control", A],
  ["luis", "10:00", 45, "Mariana Soto", "Ortodoncia", C],
  ["luis", "12:00", 45, "Andrés Vargas", "Evaluación", P],
  ["luis", "15:00", 60, "Carmen Rojas", "Ortodoncia", C],
  ["luis", "17:00", 30, "Sofía León", "Control", P],
  ["carla", "14:00", 60, "Diego Ramos", "Endodoncia", C],
  ["carla", "15:15", 45, "Valeria Cruz", "Evaluación", P],
  ["carla", "17:00", 60, "Hugo Medina", "Endodoncia", C],
  ["diego", "08:00", 30, "Mateo Ríos", "Control", A],
  ["diego", "09:00", 30, "Emma Díaz", "Sellantes", "no_asistio"],
  ["diego", "10:30", 30, "Thiago Luna", "Profilaxis", C],
  ["diego", "11:15", 30, "Camila Ortiz", "Control", P],
  ["diego", "14:30", 45, "Lucas Peña", "Sellantes", C],
]
const AGENDA_ENTRIES: ScheduleEntry[] = ROWS.map(
  ([columnId, time, minutes, patient, service, status], index) => {
    const [hours = 0, mins = 0] = time.split(":").map(Number)
    const start = hours * 60 + mins
    return {
      id: `cita-${index + 1}`,
      columnId,
      start: minutesToInstant(AGENDA_TODAY, start, TZ),
      end: minutesToInstant(AGENDA_TODAY, start + minutes, TZ),
      status,
      title: patient,
      subtitle: service,
    }
  },
)

const TODAY_ITEMS: ScheduleAgendaItem[] = AGENDA_ENTRIES.filter(
  (entry) => zonedDateOf(entry.start, TZ) === AGENDA_TODAY,
).map((entry) => ({
  entry,
  resourceLabel: AGENDA_PROFESSIONALS.find((item) => item.id === entry.columnId)?.label ?? "",
}))

describe("ScheduleAgendaList", () => {
  it("pone delante lo que está en curso y lo que viene, y pliega lo que ya pasó", () => {
    render(<ScheduleAgendaList items={TODAY_ITEMS} timeZone={TZ} now={AGENDA_NOW} />)
    expect(screen.getByText("Ahora · 10:20")).toBeTruthy()
    const current = within(screen.getByRole("list", { name: "En curso" }))
    expect(current.getAllByRole("listitem")).toHaveLength(2)
    expect(current.getByText("Mariana Soto")).toBeTruthy()
    expect(screen.getByText("Lo que viene · 11")).toBeTruthy()
    // Lo pasado no estorba: una fila con su balance.
    expect(screen.queryByText("Jorge Salas")).toBeNull()
    const past = screen.getByRole("button", { name: /Ya pasaron · 5 citas/ })
    expect(past.getAttribute("aria-expanded")).toBe("false")
    expect(past.textContent).toContain("4 atendidas · 1 no asistió")
    fireEvent.click(past)
    expect(screen.getByText("Jorge Salas")).toBeTruthy()
    expect(within(screen.getByRole("list", { name: "Ya pasaron" })).getAllByRole("listitem")).toHaveLength(5)
  })

  it("cada fila ofrece su paso siguiente y la fila abre el detalle", () => {
    const confirm = vi.fn()
    const onOpen = vi.fn()
    render(
      <ScheduleAgendaList
        items={TODAY_ITEMS}
        timeZone={TZ}
        now={AGENDA_NOW}
        onOpen={onOpen}
        primaryAction={({ entry }) =>
          entry.status === "programada"
            ? { label: "Confirmar", onSelect: () => confirm(entry.title) }
            : null
        }
        menuItems={() => [{ key: "mover", label: "Reprogramar", onSelect: () => {} }]}
      />,
    )
    // Solo lo que está por confirmar pide confirmación.
    expect(screen.getAllByRole("button", { name: "Confirmar" })).toHaveLength(5)
    const lucia = screen.getByText("Lucía Fernández").closest("li") as HTMLElement
    fireEvent.click(within(lucia).getByRole("button", { name: "Confirmar" }))
    expect(confirm).toHaveBeenCalledWith("Lucía Fernández")
    expect(onOpen).not.toHaveBeenCalled()
    expect(within(lucia).getByRole("button", { name: "Más acciones para Lucía Fernández" })).toBeTruthy()
    fireEvent.click(within(lucia).getByRole("button", { name: "Lucía Fernández" }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Lucía Fernández" }))
  })

  it("el estado se dice con palabras, no solo con color", () => {
    render(<ScheduleAgendaList items={TODAY_ITEMS} timeZone={TZ} now={AGENDA_NOW} />)
    const lucia = screen.getByText("Lucía Fernández").closest("li") as HTMLElement
    expect(lucia.dataset.status).toBe("programada")
    expect(within(lucia).getByText("Por confirmar")).toBeTruthy()
  })

  it("un día que ya pasó se lee entero, sin pliegue", () => {
    const tomorrow = minutesToInstant(addDays(AGENDA_TODAY, 1), 600, TZ)
    render(<ScheduleAgendaList items={TODAY_ITEMS} timeZone={TZ} now={tomorrow} />)
    expect(screen.getAllByRole("listitem")).toHaveLength(TODAY_ITEMS.length)
    expect(screen.queryByRole("button", { name: /Ya pasaron/ })).toBeNull()
  })

  it("sin citas lo dice", () => {
    render(<ScheduleAgendaList items={[]} timeZone={TZ} emptyLabel="No hay citas este día." />)
    expect(screen.getByText("No hay citas este día.")).toBeTruthy()
  })
})

function slot(date: string, minutes: number, resource: string): ScheduleSlotChoice {
  return {
    id: `${date}T${minutes}:${resource}`,
    start: minutesToInstant(date, minutes, TZ),
    end: minutesToInstant(date, minutes + 30, TZ),
    resourceLabel: resource,
  }
}

describe("ScheduleSlotChoices", () => {
  const tomorrow = addDays(AGENDA_TODAY, 1)
  const slots = [
    ...[660, 675, 690, 705, 720, 735].map((minutes) => slot(AGENDA_TODAY, minutes, "Dr. Luis")),
    slot(AGENDA_TODAY, 660, "Dra. Ana"),
    slot(tomorrow, 480, "Dra. Ana"),
  ]

  it("agrupa por día, dice hoy y mañana y recorta con «+N»", () => {
    const onChange = vi.fn()
    render(
      <ScheduleSlotChoices
        slots={slots}
        timeZone={TZ}
        today={AGENDA_TODAY}
        value={null}
        onChange={onChange}
      />,
    )
    const today = within(screen.getByRole("group", { name: "Hoy, lunes 12" }))
    // Siete huecos hoy: tres a la vista y el resto tras «+4».
    expect(today.getAllByRole("button")).toHaveLength(4)
    expect(screen.getByRole("group", { name: "Mañana, martes 13" })).toBeTruthy()
    fireEvent.click(today.getByRole("button", { name: /Ver 4 huecos más/ }))
    expect(today.getAllByRole("button")).toHaveLength(7)
    fireEvent.click(today.getAllByRole("button")[1] as HTMLElement)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: `${AGENDA_TODAY}T660:Dra. Ana` }))
  })

  it("sin recurso fijado ofrece una sola opción por hora y conserva la elegida", () => {
    const chosen = `${AGENDA_TODAY}T660:Dra. Ana`
    render(
      <ScheduleSlotChoices
        slots={slots}
        timeZone={TZ}
        today={AGENDA_TODAY}
        value={chosen}
        onChange={() => {}}
        distinctTimes
        perDay={8}
      />,
    )
    const today = within(screen.getByRole("group", { name: "Hoy, lunes 12" }))
    // Seis horas distintas; a las 11:00 queda la que la persona eligió.
    expect(today.getAllByRole("button")).toHaveLength(6)
    const pressed = today.getByRole("button", { pressed: true })
    expect(pressed.textContent).toContain("11:00")
    expect(pressed.textContent).toContain("Dra. Ana")
  })

  it("sin huecos lo dice en vez de quedarse en blanco", () => {
    render(<ScheduleSlotChoices slots={[]} timeZone={TZ} value={null} onChange={() => {}} />)
    expect(screen.getByText(/No hay huecos en los próximos días/)).toBeTruthy()
  })
})

describe("ScheduleStatusSummary", () => {
  it("cuenta por estado y cada ficha filtra", () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ScheduleStatusSummary
        counts={{ programada: 5, confirmada: 8, atendida: 4, no_asistio: 1 }}
        value={null}
        onChange={onChange}
      />,
    )
    const all = screen.getByRole("button", { name: /Todas/ })
    expect(all.getAttribute("aria-pressed")).toBe("true")
    expect(all.textContent).toContain("18")
    // «No asistió» solo tiene ficha porque hay una; «Canceladas», ninguna.
    expect(screen.getByRole("button", { name: /No asistió/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Cancelad/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Por confirmar/ }))
    expect(onChange).toHaveBeenCalledWith("programada")
    rerender(
      <ScheduleStatusSummary
        counts={{ programada: 5, confirmada: 8, atendida: 4, no_asistio: 1 }}
        value="programada"
        onChange={onChange}
      />,
    )
    // Tocar la ficha activa vuelve a todas.
    fireEvent.click(screen.getByRole("button", { name: /Por confirmar/ }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})

describe("recursos y días", () => {
  it("las fichas marcan el recurso elegido y «Todos» no elige a nadie", () => {
    const onChange = vi.fn()
    render(
      <ScheduleResourceChips
        label="Profesionales"
        resources={AGENDA_PROFESSIONALS.slice(0, 3)}
        value="luis"
        allLabel="Todos"
        onChange={onChange}
      />,
    )
    expect(screen.getByRole("button", { name: /Dr. Luis Vega/ }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Todos" }))
    expect(onChange).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByRole("button", { name: /Dra. Ana Torres/ }))
    expect(onChange).toHaveBeenCalledWith("ana")
  })

  it("las iniciales salen del nombre, no del título, y el tono es estable", () => {
    expect(initialsOf("Dra. Ana Torres")).toBe("AT")
    expect(initialsOf("Dr. Luis Vega")).toBe("LV")
    expect(initialsOf("Sillón 1")).toBe("S1")
    expect(scheduleToneAt(0)).toBe(0)
    expect(scheduleToneAt(5)).toBe(0)
    expect(scheduleToneAt(7)).toBe(2)
  })

  it("la franja marca el día elegido y pasa de semana", () => {
    const onChange = vi.fn()
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    render(
      <ScheduleDayStrip
        dates={AGENDA_WEEK}
        value={AGENDA_TODAY}
        today={AGENDA_TODAY}
        onChange={onChange}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    )
    const today = screen.getByRole("button", { name: /Lunes 12 de octubre, hoy/ })
    expect(today.getAttribute("aria-current")).toBe("date")
    fireEvent.click(screen.getByRole("button", { name: /Miércoles 14 de octubre/ }))
    expect(onChange).toHaveBeenCalledWith(AGENDA_WEEK[2])
    fireEvent.click(screen.getByRole("button", { name: "Semana anterior" }))
    fireEvent.click(screen.getByRole("button", { name: "Semana siguiente" }))
    expect(onPrevious).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it("la semana en teléfono dice cuánto hay libre cada día y lleva al día", () => {
    const onSelect = vi.fn()
    const window = { startMinutes: 480, endMinutes: 840 }
    render(
      <ScheduleWeekOverview
        today={AGENDA_TODAY}
        onSelect={onSelect}
        days={[
          {
            date: AGENDA_TODAY,
            count: 5,
            segments: daySegments({
              window,
              open: [window],
              busy: [{ startMinutes: 480, endMinutes: 660 }],
              nowMinutes: 620,
            }),
          },
          {
            date: addDays(AGENDA_TODAY, 1),
            count: 0,
            segments: daySegments({ window, open: [], busy: [] }),
          },
        ]}
      />,
    )
    const monday = screen.getByRole("button", { name: /Lunes 12 de octubre, hoy: 5 citas, 3 h libres/ })
    expect(monday.getAttribute("aria-label")).toContain("Libre desde las 11:00")
    expect(monday.querySelectorAll("[data-kind='free']")).toHaveLength(1)
    // Un día sin atención no promete sitio.
    expect(screen.getByRole("button", { name: /Martes 13 de octubre: 0 citas, sin tiempo libre/ })).toBeTruthy()
    fireEvent.click(monday)
    expect(onSelect).toHaveBeenCalledWith(AGENDA_TODAY)
  })
})
