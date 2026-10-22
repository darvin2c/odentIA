import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase } from "./patients-fixture"
import { surface } from "./surface"

interface FollowUpItem {
  id: string
  status: string
  appointmentId: string | null
  scheduledAt: string | null
  appointment: { id: string; status: string; startsAt: string } | null
}
interface AppointmentView {
  id: string
  status: string
}

// Recorrido del issue #8: programar un control reserva una cita real del mismo
// paciente; mover la cita reprograma el control; cancelar la cita devuelve el
// control a pendiente; cancelar el control no cancela la cita del paciente.
test("control clínico: reserva real, mover reprograma y cancelaciones coherentes", async ({
  owner,
}) => {
  const ids = await buildClinicalBase(owner)
  const { page } = owner
  const slug = owner.org.slug
  const room = await call<{ id: string }>(
    page,
    "POST",
    "/api/agenda/rooms",
    slug,
    {
      branchId: owner.branchId,
      name: "Unidad dental control",
    },
    201,
  )
  await call(page, "PUT", "/api/agenda/schedules", slug, {
    branchId: owner.branchId,
    professionalUserId: owner.user.id,
    rules: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMin: 8 * 60,
      endMin: 20 * 60,
    })),
  })
  const control = await call<{ id: string }>(
    page,
    "POST",
    `/api/patients/${ids.patientId}/follow-ups`,
    slug,
    {
      kind: "tratamiento",
      planItemId: ids.itemId,
      originEncounterId: ids.encounterId,
      title: "Control de evolución",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    },
    201,
  )

  // UI: programar el control reservando un hueco real del profesional.
  const patientPath = `/patients/${ids.patientId}`
  // Los controles viven en el Plan, con «Reservar» (ADR 0034).
  await gotoHydrated(page, tenant(slug, `${patientPath}?tab=plan`))
  await page
    .getByRole("region", { name: "Controles" })
    .getByRole("button", { name: "Reservar", exact: true })
    .first()
    .click()
  const dialog = surface(page, { name: "Programar control" })
  // El mismo «cuándo» de Nueva cita: el bloque ya viene puesto en el primer hueco.
  await expect(
    dialog.getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / }),
  ).toBeVisible({ timeout: 15_000 })
  // Sin elegir «cómo»: programar un control es asignarle una cita.
  await expect(dialog.getByText("Cómo programar")).toHaveCount(0)
  await test.info().attach("programar-control", {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await dialog.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ }).click()
  await expect(page.getByText(/Cita reservada/)).toBeVisible({ timeout: 15_000 })

  // El vínculo lleva a la cita concreta en la agenda.
  await page.getByRole("link", { name: "Ver cita en agenda" }).click()
  await expect(page).toHaveURL(/\/agenda\?appointmentId=[0-9a-f-]{36}/)

  // API: el control queda programado con la cita del mismo paciente.
  const followUpsUrl = `/api/patients/${ids.patientId}/follow-ups`
  const [programado] = await call<FollowUpItem[]>(page, "GET", followUpsUrl, slug)
  expect(programado.status).toBe("programado")
  expect(programado.appointmentId).toBeTruthy()
  expect(programado.appointment?.status).toBe("programada")

  // Reprogramar = mover la cita: el control conserva el vínculo y la nueva fecha.
  const tomorrow = new Date(Date.now() + 86400000)
  const startsAt = new Date(
    Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 18, 0),
  ).toISOString()
  await call(page, "POST", `/api/appointments/${programado.appointmentId}/move`, slug, {
    expectedVersion: 1,
    startsAt,
  })
  const [movido] = await call<FollowUpItem[]>(page, "GET", followUpsUrl, slug)
  expect(movido.status).toBe("programado")
  expect(movido.appointmentId).toBe(programado.appointmentId)
  expect(movido.scheduledAt).toBe(startsAt)

  // Cancelar la cita devuelve el control a pendiente y conserva la traza.
  await call(page, "POST", `/api/appointments/${programado.appointmentId}/status`, slug, {
    status: "cancelada",
  })
  const [liberado] = await call<FollowUpItem[]>(page, "GET", followUpsUrl, slug)
  expect(liberado).toMatchObject({
    status: "pendiente",
    scheduledAt: null,
    appointmentId: programado.appointmentId,
  })

  // El control pendiente admite una nueva reserva transaccional.
  const reagendado = await call<FollowUpItem>(
    page,
    "POST",
    `${followUpsUrl}/${control.id}/schedule`,
    slug,
    {
      appointment: {
        professionalUserId: owner.user.id,
        roomId: room.id,
        startsAt,
        durationMin: 30,
      },
    },
  )
  expect(reagendado.status).toBe("programado")
  expect(reagendado.appointmentId).toBeTruthy()
  expect(reagendado.appointmentId).not.toBe(programado.appointmentId)

  // Cancelar el control no cancela la cita del paciente: puede compartirla.
  const cancelado = await call<FollowUpItem>(
    page,
    "POST",
    `${followUpsUrl}/${control.id}/cancel`,
    slug,
    { reason: "El paciente no puede asistir" },
  )
  expect(cancelado.status).toBe("cancelado")
  const cita = await call<AppointmentView>(
    page,
    "GET",
    `/api/appointments/${reagendado.appointmentId}`,
    slug,
  )
  expect(cita.status).toBe("programada")
})
