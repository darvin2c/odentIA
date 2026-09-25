import { SCHEDULE_COLUMNS, scheduleDayEntries } from "./story-fixtures.js"
import type { ScheduleColumn, ScheduleEntry, ScheduleMove, ScheduleStatus } from "./types.js"

export type ResourceGroup = "professionals" | "chairs"
export interface DemoAppointment {
  id: string
  start: string
  end: string
  title: string
  subtitle?: string
  status: ScheduleStatus
  professionalId: string
  chairId: string
}
export const PROFESSIONALS: ScheduleColumn[] = [
  ...SCHEDULE_COLUMNS,
  { id: "carmen", label: "Dra. Carmen Silva", detail: "Odontopediatría" },
  { id: "jorge", label: "Dr. Jorge Medina", detail: "Cirugía oral" },
  { id: "paola", label: "Dra. Paola Ríos", detail: "Periodoncia" },
]
export const ROOMS: ScheduleColumn[] = [
  { id: "room-a", label: "Sala A", detail: "Atención general" },
  { id: "room-b", label: "Sala B", detail: "Especialidades" },
  { id: "room-c", label: "Sala C", detail: "Cirugía" },
]
export const CHAIRS = [
  { id: "chair-1", label: "Sillón 1", roomId: "room-a", detail: "Sala A" },
  { id: "chair-2", label: "Sillón 2", roomId: "room-a", detail: "Sala A" },
  { id: "chair-3", label: "Sillón 3", roomId: "room-b", detail: "Sala B" },
  { id: "chair-4", label: "Sillón 4", roomId: "room-b", detail: "Sala B" },
  { id: "chair-5", label: "Sillón 5", roomId: "room-c", detail: "Sala C" },
  { id: "chair-6", label: "Sillón 6", roomId: "room-c", detail: "Sala C" },
]
export const RESOURCE_OPTIONS = { professionals: PROFESSIONALS, chairs: CHAIRS, rooms: ROOMS }
export const GROUP_LABELS: Record<ResourceGroup | "rooms", string> = {
  professionals: "Profesionales",
  chairs: "Sillones",
  rooms: "Salas",
}
export const FILTER_KEYS = ["q", "professionals", "chairs", "rooms", "status"]

export function roomOf(appointment: DemoAppointment): string {
  const chair = CHAIRS.find((item) => item.id === appointment.chairId)
  if (!chair) throw new Error("La cita debe tener un sillón de la sede.")
  return chair.roomId
}
export function matchesResource(raw: string | undefined, id: string): boolean {
  return !raw || (raw !== "none" && raw.split(",").includes(id))
}
export function assignedResource(appointment: DemoAppointment, group: ResourceGroup): string {
  return group === "professionals" ? appointment.professionalId : appointment.chairId
}
export function appointmentContext(appointment: DemoAppointment): string {
  return [
    PROFESSIONALS.find((item) => item.id === appointment.professionalId)?.label,
    CHAIRS.find((item) => item.id === appointment.chairId)?.label,
    ROOMS.find((item) => item.id === roomOf(appointment))?.label,
  ].join(" · ")
}
/** Proyección de una misma cita, no una nueva ficha por recurso. */
export function projectAppointment(
  appointment: DemoAppointment,
  group: ResourceGroup,
): ScheduleEntry {
  return {
    id: appointment.id,
    start: appointment.start,
    end: appointment.end,
    title: appointment.title,
    status: appointment.status,
    subtitle: [appointment.subtitle, appointmentContext(appointment)].filter(Boolean).join(" · "),
    columnId: assignedResource(appointment, group),
  }
}
/** Cambia solo el recurso ocupable de la vista actual; sala se deriva del sillón. */
export function moveAppointment(
  appointment: DemoAppointment,
  move: ScheduleMove,
  group: ResourceGroup,
): DemoAppointment {
  return {
    ...appointment,
    start: move.start,
    end: move.end,
    ...(group === "professionals" ? { professionalId: move.columnId } : { chairId: move.columnId }),
  }
}
export function demoAppointments(date: string): DemoAppointment[] {
  const source = scheduleDayEntries(date)
  const names = [
    "Valeria Salas",
    "Andrés Peña",
    "Camila Ortiz",
    "Diego Núñez",
    "Isabel Rojas",
    "Mateo Vera",
  ]
  return PROFESSIONALS.flatMap((professional, index) =>
    source
      .filter((entry) => entry.columnId === SCHEDULE_COLUMNS[index % 3].id)
      .map((entry, slot) => ({
        id: `${entry.id}-${professional.id}`,
        professionalId: professional.id,
        chairId: CHAIRS[index].id,
        start: entry.start,
        end: entry.end,
        status: entry.status,
        title: index < 3 ? entry.title : names[(slot + index) % names.length],
        subtitle: entry.subtitle,
      })),
  )
}
