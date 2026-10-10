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
  // La rejilla del día pone un carril por profesional; el menú cambia a sillones.
  const grid = owner.page.getByRole("region", { name: /^Agenda del/ })
  await expect(grid.getByRole("group", { name: owner.user.name })).toBeVisible()
  await owner.page.getByRole("button", { name: "Profesionales: todos" }).click()
  await owner.page.getByRole("menuitem", { name: "Ver por sillón" }).click()
  await expect(grid.getByRole("group", { name: "Sillón 1" })).toBeVisible()
  await expect(grid.getByRole("button", { name: /^Cita de Micaela Ríos/ })).toBeVisible()
})

test("agenda: reservar un hueco real, confirmarlo y encontrarlo al buscar", async ({
  createOwner,
}, info) => {
  const owner = await createOwner("agenda-ui")
  const { page } = owner
  const shot = async (name: string) =>
    info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
  /** La cita de la paciente tal como la tiene el servidor. */
  const appointmentOf = async () => {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString()
    const rows = await call<{ startsAt: string; status: string }[]>(
      page,
      "GET",
      `/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      owner.org.slug,
    )
    const row = rows[0]
    if (!row) throw new Error("La cita no existe")
    return row
  }
  /** Fecha y hora de Lima (UTC−5 fijo) de un instante. */
  const lima = (iso: string) => {
    const local = new Date(Date.parse(iso) - 5 * 3_600_000).toISOString()
    return { date: local.slice(0, 10), hour: Number(local.slice(11, 13)) }
  }
  await call(page, "POST", "/api/agenda/chairs", owner.org.slug, { branchId: owner.branchId, name: "Sillón 1" }, 201)
  await call(
    page,
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
  // Atiende todos los días de 08:00 a 20:00: siempre hay un hueco próximo que reservar.
  await call(
    page,
    "PUT",
    "/api/agenda/schedules",
    owner.org.slug,
    {
      branchId: owner.branchId,
      dentistUserId: owner.user.id,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 8 * 60, endMin: 20 * 60 })),
    },
    200,
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  const grid = page.getByRole("region", { name: /^Agenda del/ })
  // La cabecera del profesional dice su próximo hueco y lo ofrece como botón.
  const nextFree = grid.getByRole("button", { name: /^Libre / })
  await expect(nextFree).toBeVisible()
  await shot("dia-escritorio-vacio")

  // Reservar: paciente y hueco; ni fecha ni hora escritas a mano.
  await nextFree.click()
  await page.getByLabel("Paciente", { exact: true }).fill("Mica")
  await page.getByRole("option", { name: /Micaela Ríos/ }).click()
  const reserve = page.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ })
  await expect(reserve).toBeEnabled()
  await shot("nueva-cita")
  await reserve.click()
  const card = grid.getByRole("button", { name: /^Cita de Micaela Ríos/ })
  await expect(card).toBeVisible()

  // Detalle: el estado va con su paso siguiente.
  await card.click()
  await expect(page.getByText("Por confirmar", { exact: true }).last()).toBeVisible()
  await shot("detalle-por-confirmar")
  await page.getByRole("button", { name: "Confirmar cita" }).click()
  await expect(page.getByRole("button", { name: "Confirmar cita" })).toHaveCount(0)
  await expect(page.getByText("Confirmada", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Cerrar" }).click()

  // Búsqueda: por documento, y abre la cita encontrada.
  await page.getByRole("button", { name: "Buscar la cita de un paciente" }).click()
  await page.getByLabel("Paciente", { exact: true }).fill("45678901")
  const found = page.getByRole("dialog").getByRole("button", { name: /Confirmada/ })
  await expect(found).toBeVisible()
  await shot("buscar")
  await found.click()
  await expect(page.getByRole("button", { name: "Reprogramar" })).toBeVisible()
  await shot("dia-escritorio-detalle")

  // Editar detalles: el motivo se guarda y se lee en el detalle.
  await page.getByRole("button", { name: "Editar detalles" }).click()
  await page.getByLabel("Motivo (opcional)").fill("Dolor en una muela")
  await page.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(page.getByText("Dolor en una muela", { exact: true })).toBeVisible()

  // Reprogramar: se elige otro hueco real y la cita cambia de hora.
  const booked = await appointmentOf()
  await page.getByRole("button", { name: "Reprogramar" }).click()
  const choices = page.getByRole("group", { name: /^(Hoy|Mañana), / }).first()
  await choices.getByRole("button").nth(1).click()
  await shot("reprogramar")
  await page.getByRole("button", { name: "Mover cita" }).click()
  await expect(page.getByRole("button", { name: "Reprogramar" })).toBeVisible()
  const moved = await appointmentOf()
  expect(moved.startsAt).not.toBe(booked.startsAt)

  // Arrastrar: con el puntero, la cita se mueve una hora y el servidor lo acepta.
  await gotoHydrated(page, tenant(owner.org.slug, `/agenda?date=${lima(moved.startsAt).date}`))
  const dragged = page
    .getByRole("region", { name: /^Agenda del/ })
    .getByRole("button", { name: /^Cita de Micaela Ríos/ })
  await expect(dragged).toBeVisible()
  await dragged.scrollIntoViewIfNeeded()
  const box = await dragged.boundingBox()
  if (!box) throw new Error("La cita no está en pantalla")
  // 72 px son una hora en la vista Día; hacia donde quede dentro del horario.
  const delta = lima(moved.startsAt).hour < 14 ? 72 : -72
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + delta / 2, { steps: 6 })
  await page.mouse.move(x, y + delta, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(async () => Date.parse((await appointmentOf()).startsAt) - Date.parse(moved.startsAt))
    .toBe(delta > 0 ? 3_600_000 : -3_600_000)

  // Lista de espera: se registra a la persona y el botón lleva la cuenta.
  await page.getByRole("button", { name: /^Lista de espera/ }).click()
  await page.getByRole("button", { name: "Añadir a la lista" }).click()
  await page.getByLabel("Paciente", { exact: true }).fill("Mica")
  await page.getByRole("option", { name: /Micaela Ríos/ }).click()
  await page.getByRole("button", { name: "Registrar espera" }).click()
  await expect(page.getByText("Prioridad normal")).toBeVisible()
  await shot("lista-de-espera")
  await page.getByRole("button", { name: "Cerrar" }).click()
  await expect(page.getByRole("button", { name: /^Lista de espera/ })).toContainText("1")

  // Cancelar: pide el motivo y, si se marca, abre la lista de espera para ofrecer el hueco.
  await page
    .getByRole("region", { name: /^Agenda del/ })
    .getByRole("button", { name: /^Cita de Micaela Ríos/ })
    .click()
  await page.getByRole("button", { name: "Cancelar cita" }).click()
  const cancel = page.getByRole("alertdialog")
  await cancel.getByRole("radio", { name: "Lo pidió la clínica" }).click()
  await cancel.getByLabel("Nota, si hace falta").fill("Se reprograma por viaje")
  await cancel.getByText("Ofrecer el hueco a la lista de espera").click()
  await shot("cancelar")
  await cancel.getByRole("button", { name: "Cancelar cita" }).click()
  await expect(page.getByRole("button", { name: "Ofrecer hueco" })).toBeVisible()
  expect((await appointmentOf()).status).toBe("cancelada")
  await expect(
    page.getByRole("region", { name: /^Agenda del/ }).getByRole("button", { name: /^Cita de Micaela Ríos/ }),
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Cerrar" }).click()

  // Lista y Semana.
  await page.getByRole("button", { name: "Lista", exact: true }).click()
  await expect(page.getByRole("button", { name: /Todas/ })).toBeVisible()
  await expect(page.getByText("Micaela Ríos").first()).toBeVisible()
  await shot("lista-escritorio")
  await page.getByRole("button", { name: "Semana", exact: true }).click()
  await expect(page.getByRole("region", { name: /^Semana del/ })).toBeVisible()
  await shot("semana-escritorio")

  // Teléfono: un profesional a la vez, con su próximo hueco en la ficha.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Día", exact: true }).click()
  await expect(page.getByRole("group", { name: "Profesionales" })).toContainText("Libre")
  await expect(page.getByRole("region", { name: /^Agenda del/ })).toBeVisible()
  await shot("dia-telefono")
  // En teléfono también se puede ver por sillón.
  await page.getByRole("button", { name: /^Profesionales/ }).click()
  await expect(page.getByRole("group", { name: "Sillones" })).toContainText("Sillón 1")
  await shot("dia-telefono-sillones")
  await page.getByRole("button", { name: /^Sillones/ }).click()
  await expect(page.getByRole("group", { name: "Profesionales" })).toContainText("Libre")
  await page.getByRole("button", { name: "Lista", exact: true }).click()
  await expect(page.getByRole("button", { name: /Todas/ })).toBeVisible()
  await shot("lista-telefono")
  await page.getByRole("button", { name: "Semana", exact: true }).click()
  await expect(page.getByRole("button", { name: /Todas/ })).toHaveCount(0)
  await expect(page.getByText(/libres?/).first()).toBeVisible()
  await shot("semana-telefono")

  // Desde la ficha del paciente la reserva se abre con esa persona ya puesta.
  await page.setViewportSize({ width: 1440, height: 900 })
  const patients = await call<{ id: string }[]>(page, "GET", "/api/patients?q=Micaela&limit=5", owner.org.slug)
  await gotoHydrated(page, tenant(owner.org.slug, `/agenda?patientId=${patients[0]?.id}`))
  await expect(page.getByText("Paciente del caso")).toBeVisible()
  await expect(page.getByText("Micaela Ríos").first()).toBeVisible()
  await page.getByRole("button", { name: "Cancelar", exact: true }).click()

  // Tema oscuro: la misma pantalla con el tema del sistema.
  await page.emulateMedia({ colorScheme: "dark" })
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  await expect(page.getByRole("region", { name: /^Agenda del/ })).toBeVisible()
  await shot("dia-oscuro")
})

test("agenda: lo que falta se dice con su acción, y la sede se elige en un solo sitio", async ({
  createOwner,
}, info) => {
  const owner = await createOwner("agenda-vacia")
  const { page } = owner
  const shot = async (name: string) =>
    info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Sin sillones: la agenda lo dice y deja añadir uno ahí mismo.
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  await expect(page.getByText("Esta sede aún no tiene sillones")).toBeVisible()
  await shot("vacio-sin-sillones")
  await page.getByRole("button", { name: "Añadir sillón" }).click()
  await page.getByRole("button", { name: "Añadir sillón" }).last().click()

  // Con sillón pero sin horario: lleva a configurarlo, en la misma sede.
  await expect(page.getByText("Falta el horario de atención")).toBeVisible()
  await shot("vacio-sin-horario")
  await page.getByRole("button", { name: "Configurar horarios" }).click()
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/availability"))
  await expect(page.getByRole("heading", { name: "Sillones" })).toBeVisible()
  await expect(page.getByText("Sillón 1", { exact: true })).toBeVisible()

  // Atiende solo mañana: hoy la agenda ofrece ir al próximo día con atención.
  const tomorrow = new Date(Date.now() - 5 * 3_600_000 + 86_400_000)
  await call(
    page,
    "PUT",
    "/api/agenda/schedules",
    owner.org.slug,
    {
      branchId: owner.branchId,
      dentistUserId: owner.user.id,
      rules: [{ weekday: tomorrow.getUTCDay(), startMin: 8 * 60, endMin: 20 * 60 }],
    },
    200,
  )
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  await expect(page.getByText(/^Nadie atiende el /)).toBeVisible()
  await shot("vacio-nadie-atiende")
  await page.getByRole("button", { name: /^Ir al / }).click()
  await expect(page.getByRole("region", { name: /^Agenda del/ })).toBeVisible()

  // La fecha se elige con el calendario estándar, desde el propio rótulo.
  await page.getByRole("button", { name: /Ir a otra fecha/ }).click()
  await expect(page.getByRole("grid")).toBeVisible()
  await shot("calendario")
  await page.keyboard.press("Escape")

  // Dos sedes: se elige bajo el título y la elección vale también en Horarios y bloqueos.
  await call(page, "POST", "/api/branches", owner.org.slug, { name: "Sede Norte" }, 201)
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  await page.getByRole("button", { name: "Sede Central" }).click()
  await page.getByRole("menuitem", { name: "Sede Norte" }).click()
  await expect(page.getByRole("button", { name: "Sede Norte" })).toBeVisible()
  await expect(page.getByText("Esta sede aún no tiene sillones")).toBeVisible()
  await shot("sede-elegida")
  await gotoHydrated(page, tenant(owner.org.slug, "/settings/availability"))
  await expect(page.getByRole("button", { name: "Sede Norte" })).toBeVisible()
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
