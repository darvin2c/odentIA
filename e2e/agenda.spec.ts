import { randomUUID } from "node:crypto"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

/** Hoy en Lima como «yyyy-mm-dd» y un instante a las 18:00 Lima (UTC−5 fijo). */
function limaToday(): { date: string; startsAt: string; endsAt: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  return { date, startsAt: `${date}T23:00:00.000Z`, endsAt: `${date}T23:45:00.000Z` }
}

async function prepareAppointment(owner: OwnerFixture): Promise<{
  chair: { id: string }
  patient: { id: string }
  appointment: { id: string; version: number }
  date: string
  startsAt: string
  endsAt: string
}> {
  const chair = await call<{ id: string }>(
    owner.page,
    "POST",
    "/api/agenda/chairs",
    owner.org.slug,
    { branchId: owner.branchId, name: "Sillón 1" },
    201,
  )
  const patient = await call<{ id: string }>(
    owner.page,
    "POST",
    "/api/patients",
    owner.org.slug,
    {
      submissionId: randomUUID(),
      answers: {
        demographics: { displayName: "Micaela Ríos", docType: "DNI", docNumber: "45678901" },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
    201,
  )
  const { date, startsAt, endsAt } = limaToday()
  // Horario explícito del profesional (la reserva estricta lo exige): el día
  // de hoy en Lima de 17:00 a 20:00 cubre la cita de las 18:00.
  const weekday = new Date(`${date}T17:00:00Z`).getUTCDay()
  await call(
    owner.page,
    "PUT",
    "/api/agenda/schedules",
    owner.org.slug,
    {
      branchId: owner.branchId,
      dentistUserId: owner.user.id,
      rules: [{ weekday, startMin: 17 * 60, endMin: 20 * 60 }],
    },
    200,
  )
  const appointment = await call<{ id: string; version: number }>(
    owner.page,
    "POST",
    "/api/appointments",
    owner.org.slug,
    {
      patientId: patient.id,
      dentistUserId: owner.user.id,
      chairId: chair.id,
      startsAt,
      endsAt,
      reason: "Control de ortodoncia",
    },
    201,
  )
  return { chair, patient, appointment, date, startsAt, endsAt }
}

test("agenda: alta de sillón, paciente y cita visibles en el tenant", async ({ createOwner }) => {
  const owner = await createOwner("agenda")
  const { date } = await prepareAppointment(owner)

  const resources = await call<{ chairs: { id: string; label: string }[] }>(
    owner.page,
    "GET",
    "/api/agenda/resources",
    owner.org.slug,
  )
  expect(resources.chairs.map((item) => item.label)).toContain("Sillón 1")

  await gotoHydrated(owner.page, tenant(owner.org.slug, `/agenda?date=${date}`))
  await expect(owner.page).toHaveURL(tenantPattern(owner.org.slug, "/agenda"))
  await expect(owner.page.getByRole("heading", { name: "Agenda" })).toBeVisible()
  await expect(owner.page.getByText("Micaela Ríos").first()).toBeVisible()
  await owner.page.getByLabel("Ver por").selectOption("chairs")
  await expect(owner.page.getByText("Sillón 1").first()).toBeVisible()
})

test("agenda: solape responde 409 y movimiento con versión", async ({ createOwner }) => {
  const owner = await createOwner("agenda")
  const { chair, patient, appointment, startsAt, endsAt } = await prepareAppointment(owner)

  const conflict = await api<{ error: { code: string } }>(
    owner.page,
    "POST",
    "/api/appointments",
    owner.org.slug,
    {
      patientId: patient.id,
      dentistUserId: owner.user.id,
      chairId: chair.id,
      startsAt,
      endsAt,
    },
  )
  expect(conflict.status).toBe(409)
  expect(conflict.body?.error.code).toBe("APPOINTMENT_CONFLICT")

  const moved = await call<{ version: number }>(
    owner.page,
    "POST",
    `/api/appointments/${appointment.id}/move`,
    owner.org.slug,
    { expectedVersion: appointment.version, startsAt, endsAt },
  )
  expect(moved.version).toBeGreaterThan(appointment.version)
})

test("agenda: otra organización no ve sillones ni citas ajenas", async ({ createOwner }) => {
  const first = await createOwner("agenda-a")
  const second = await createOwner("agenda-b")
  const { date } = await prepareAppointment(first)

  const resourcesB = await call<{ chairs: { id: string }[] }>(
    second.page,
    "GET",
    "/api/agenda/resources",
    second.org.slug,
  )
  expect(resourcesB.chairs).toHaveLength(0)
  const listB = await call<unknown[] | { data?: unknown[] }>(
    second.page,
    "GET",
    `/api/appointments?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`,
    second.org.slug,
  )
  const rowsB = Array.isArray(listB) ? listB : (listB.data ?? [])
  expect(rowsB).toHaveLength(0)
})
