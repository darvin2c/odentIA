import { randomUUID } from "node:crypto"
import { tenant, tenantPattern } from "./env"
import type { Page } from "@playwright/test"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

/** Hoy en Lima como «yyyy-mm-dd» y un instante a las 18:00 Lima (UTC−5 fijo). */
function limaToday(): { date: string; startsAt: string; endsAt: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  return { date, startsAt: `${date}T23:00:00.000Z`, endsAt: `${date}T23:45:00.000Z` }
}

/**
 * Abre «Nueva cita» y espera al bloque ya colocado. En escritorio el formulario se
 * acomoda en la columna lateral nada más abrirse: lo escrito antes de eso se pierde.
 */
async function openBooking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Nueva cita" }).click()
  await expect(
    page
      .getByRole("region", { name: /^Horas del/ })
      .getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / }),
  ).toBeVisible()
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
  // Quien atiende abre la Agenda en su columna (tablero 7): el menú dice de quién es.
  await owner.page.getByRole("button", { name: owner.user.name, exact: true }).click()
  await owner.page.getByRole("menuitem", { name: "Ver por sillón" }).click()
  await expect(grid.getByRole("group", { name: "Sillón 1" })).toBeVisible()
  await expect(grid.getByRole("button", { name: /^Cita de Micaela Ríos/ })).toBeVisible()
})

test("agenda: «Llegó» con un clic, «Deshacer» y «Atender» sin formulario", async ({ createOwner }, info) => {
  const owner = await createOwner("agenda-llego")
  const { appointment, date } = await prepareAppointment(owner)
  const { page } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, `/agenda?date=${date}&appointmentId=${appointment.id}`))
  // Antes de llegar: «Llegó»; «Atendida» ya no se pone a mano.
  await expect(page.getByRole("button", { name: "Llegó", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Atendida", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Llegó", exact: true }).click()
  // Llegó: la hora y la espera en palabras, «Atender» y «Deshacer»; ya no se cancela.
  await expect(page.getByText(/^Llegó a las \d\d:\d\d · espera \d+ min$/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Cancelar cita" })).toHaveCount(0)
  await info.attach("llego", { body: await page.screenshot(), contentType: "image/png" })
  await page.getByRole("button", { name: "Deshacer", exact: true }).click()
  await expect(page.getByRole("button", { name: "Llegó", exact: true })).toBeVisible()
  expect((await call<{ visit: string }>(page, "GET", `/api/appointments/${appointment.id}`, owner.org.slug)).visit).toBe("por_confirmar")
  // «Atender» en un clic: sin formulario de motivo, la atención se abre unida a la cita y la llegada queda marcada.
  await page.getByRole("button", { name: "Llegó", exact: true }).click()
  await page.getByRole("button", { name: "Atender", exact: true }).click()
  await expect(page).toHaveURL(/\/patients\/[^/]+\/encounters\//)
  await expect(page.getByRole("dialog", { name: "Atender la cita" })).toHaveCount(0)
  const attending = await call<{ visit: string; arrivedAt: string | null }>(page, "GET", `/api/appointments/${appointment.id}`, owner.org.slug)
  expect(attending.visit).toBe("en_atencion")
  expect(attending.arrivedAt).not.toBeNull()
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
  await expect(grid.getByRole("group", { name: owner.user.name })).toBeVisible()
  await shot("dia-escritorio-vacio")

  // Reservar: paciente y horas libres; el bloque ya viene puesto en el primer hueco
  // y dura lo que una cita regular (1 h). Ni fecha ni hora escritas a mano.
  await openBooking(page)
  await page.getByLabel("Paciente", { exact: true }).fill("Mica")
  await page.getByRole("option", { name: /Micaela Ríos/ }).click()
  const hours = page.getByRole("region", { name: /^Horas del/ })
  await expect(hours).toBeVisible()
  // Con el día casi acabado no cabe una cita entera: se pasa a la semana siguiente.
  if (lima(new Date().toISOString()).hour >= 18) {
    await page.getByRole("button", { name: "Semana siguiente" }).click()
  }
  const block = hours.getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / })
  await expect(block).toBeVisible()
  await expect(page.getByRole("button", { name: /^Dura 1 h\./ })).toBeVisible()
  // Con teclado: la flecha lo baja un cuarto de hora y Mayús con flecha lo acorta.
  const firstHour = await block.textContent()
  await block.press("ArrowDown")
  await expect(block).not.toHaveText(firstHour ?? "")
  await block.press("Shift+ArrowUp")
  await expect(page.getByRole("button", { name: /^Dura 45 min\./ })).toBeVisible()
  // El menú deja la duración como estaba.
  await page.getByRole("button", { name: /^Dura 45 min\./ }).click()
  await page.getByRole("menuitem", { name: "1 h", exact: true }).click()
  await expect(page.getByRole("button", { name: /^Dura 1 h\./ })).toBeVisible()
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

  // Reprogramar es cambiar de día y hora: mismo profesional y misma duración. Se ve dónde
  // está la cita y el bloque ya viene puesto en el hueco que le sigue.
  const booked = await appointmentOf()
  await page.getByRole("button", { name: "Reprogramar" }).click()
  const moveHours = page.getByRole("region", { name: /^Horas del/ })
  await expect(moveHours.getByText(/^Ahora está aquí, \d\d:\d\d$/)).toBeVisible()
  await expect(moveHours.getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / })).toBeVisible()
  // Ni duración ni lista de profesionales: eso ya estaba decidido.
  await expect(page.getByRole("button", { name: /^Dura / })).toHaveCount(0)
  await expect(page.getByRole("group", { name: "Profesional" })).toHaveCount(0)
  await shot("reprogramar")
  // Cambiar de profesional queda a un toque, para cuando el suyo no puede.
  await page.getByRole("button", { name: "Cambiar de profesional" }).click()
  await expect(page.getByRole("group", { name: "Profesional" })).toBeVisible()
  await page.getByRole("button", { name: /^Mover (a|al) / }).click()
  await expect(page.getByRole("button", { name: "Reprogramar" })).toBeVisible()
  const moved = await appointmentOf()
  // Una hora más tarde: justo después de donde estaba, con la misma duración.
  expect(Date.parse(moved.startsAt) - Date.parse(booked.startsAt)).toBe(3_600_000)

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

  // Cancelar: pide el motivo y la cita sale de la agenda. Justo después de soltar una cita,
  // la rejilla ignora un instante los clics (el clic fantasma del arrastre): se reintenta.
  await expect(async () => {
    await page
      .getByRole("region", { name: /^Agenda del/ })
      .getByRole("button", { name: /^Cita de Micaela Ríos/ })
      .click()
    await expect(page.getByRole("button", { name: "Cancelar cita" })).toBeVisible({ timeout: 1500 })
  }).toPass()
  await page.getByRole("button", { name: "Cancelar cita" }).click()
  const cancel = page.getByRole("alertdialog")
  await cancel.getByRole("radio", { name: "Lo pidió la clínica" }).click()
  await cancel.getByLabel("Nota, si hace falta").fill("Se reprograma por viaje")
  await shot("cancelar")
  await cancel.getByRole("button", { name: "Cancelar cita" }).click()
  await expect.poll(async () => (await appointmentOf()).status).toBe("cancelada")
  await expect(
    page.getByRole("region", { name: /^Agenda del/ }).getByRole("button", { name: /^Cita de Micaela Ríos/ }),
  ).toHaveCount(0)
  // La lista de espera ya no existe: ni en la cabecera ni al cancelar.
  await expect(page.getByRole("button", { name: /espera/i })).toHaveCount(0)

  // Lista y Semana.
  await page.getByRole("button", { name: "Lista", exact: true }).click()
  await expect(page.getByRole("button", { name: /Todas/ })).toBeVisible()
  await expect(page.getByText("Micaela Ríos").first()).toBeVisible()
  await shot("lista-escritorio")
  await page.getByRole("button", { name: "Semana", exact: true }).click()
  await expect(page.getByRole("region", { name: /^Semana del/ })).toBeVisible()
  await shot("semana-escritorio")

  // Teléfono: un profesional a la vez; lo libre se ve en la rejilla, no en la ficha.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Día", exact: true }).click()
  await expect(page.getByRole("group", { name: "Profesionales" })).toContainText("Ana")
  await expect(page.getByRole("group", { name: "Profesionales" })).not.toContainText("Libre")
  await expect(page.getByRole("region", { name: /^Agenda del/ })).toBeVisible()
  await shot("dia-telefono")
  // En teléfono también se puede ver por sillón.
  await page.getByRole("button", { name: /^Profesionales/ }).click()
  await expect(page.getByRole("group", { name: "Sillones" })).toContainText("Sillón 1")
  await shot("dia-telefono-sillones")
  await page.getByRole("button", { name: /^Sillones/ }).click()
  await expect(page.getByRole("group", { name: "Profesionales" })).toBeVisible()
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

  // Con sillón pero sin horario: se configura ahí mismo, igual que el sillón.
  await expect(page.getByText("Falta el horario de atención")).toBeVisible()
  await shot("vacio-sin-horario")
  await page.getByRole("button", { name: "Configurar horario" }).click()
  await expect(page.getByRole("heading", { name: "Horario de atención" })).toBeVisible()
  for (const day of ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]) {
    await page.getByRole("button", { name: `Añadir turno el ${day}` }).click()
  }
  // Horario partido: el segundo turno del día propone la tarde.
  await page.getByRole("button", { name: "Añadir turno el lunes" }).click()
  // La hora es la lista «Hora» (cada 15 minutos): dice la elegida.
  await expect(page.getByLabel("lunes, desde").nth(1)).toContainText("15:00")
  await expect(page.getByLabel("lunes, hasta").nth(1)).toContainText("19:00")
  await page.getByRole("button", { name: "Guardar horario" }).click()
  // La agenda se llena al lado, sin haber salido de ella.
  await expect(page.getByRole("region", { name: /^Agenda del/ })).toBeVisible()
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/agenda"))
  await shot("horario-en-agenda")
  // La pantalla completa queda a un enlace, en la misma sede y con lo recién guardado.
  await page.getByRole("link", { name: "Ver toda la configuración" }).click()
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/availability"))
  await expect(page.getByRole("heading", { name: "De cada profesional" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "De la sede" })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: `Horario semanal de ${owner.user.name}` }),
  ).toBeVisible()
  await expect(page.getByLabel("lunes, desde").first()).toContainText("09:00")
  await expect(page.getByLabel("lunes, desde")).toHaveCount(2)
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

  // Dos sedes: se elige bajo el título y la elección vale también en Horarios y ausencias.
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

test("agenda: una ausencia de varios días avisa de sus citas y saca al profesional", async ({
  createOwner,
}, info) => {
  const owner = await createOwner("agenda-ausencia")
  const { page } = owner
  const shot = async (name: string) =>
    info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
  /** Día de Lima (UTC−5 fijo) a `offset` días de hoy. */
  const limaDay = (offset: number) =>
    new Date(Date.now() - 5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
  const tomorrow = limaDay(1)
  const dayAfter = limaDay(2)
  const chair = await call<{ id: string }>(
    page,
    "POST",
    "/api/agenda/chairs",
    owner.org.slug,
    { branchId: owner.branchId, name: "Sillón 1" },
    201,
  )
  const patient = await call<{ id: string }>(
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
  // Una cita mañana a las 10:00 de Lima, que quedará dentro de la ausencia.
  await call(
    page,
    "POST",
    "/api/appointments",
    owner.org.slug,
    {
      patientId: patient.id,
      dentistUserId: owner.user.id,
      chairId: chair.id,
      startsAt: `${tomorrow}T15:00:00.000Z`,
      durationMin: 30,
    },
    201,
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/settings/availability"))
  // Las ausencias de alguien están con su horario: no hay que decir de quién son.
  await expect(page.getByRole("heading", { name: `Ausencias de ${owner.user.name}` })).toBeVisible()
  await page.getByRole("button", { name: "Nueva ausencia" }).click()
  const form = page.getByRole("form").or(page.locator("form")).last()
  // «Hasta» pasado mañana: tres días de vacaciones en un solo paso.
  await form.getByLabel("Hasta").click()
  const [year = 0, month = 1, date = 1] = dayAfter.split("-").map(Number)
  const dayKey = await page.evaluate(
    ([y, m, d]) => new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString("es"),
    [year, month, date],
  )
  const dayButton = page.locator(`[data-day="${dayKey}"]`)
  if ((await dayButton.count()) === 0) await page.locator(".rdp-button_next").click()
  await dayButton.click()
  await expect(form.getByText("1 cita queda dentro de la ausencia")).toBeVisible()
  await expect(form.getByText(/Micaela Ríos/)).toBeVisible()
  await shot("ausencia-con-citas-dentro")
  await form.getByRole("button", { name: "Guardar ausencia" }).click()
  await expect(page.getByText(/^Del .* al /)).toBeVisible()
  await expect(page.getByRole("link", { name: "1 cita por mover" })).toBeVisible()

  // Un feriado es de la sede, no de una persona: va en su propio grupo.
  await page.getByRole("button", { name: "Nuevo feriado o cierre" }).click()
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  const closures = page.locator("section", { has: page.getByRole("heading", { name: "Feriados y cierres" }) })
  await expect(closures.getByText("Feriado", { exact: true })).toBeVisible()
  await expect(closures.getByText(/toda la sede/)).toBeVisible()
  await shot("configuracion-dos-grupos")
  // Quitarlo pregunta antes y dice qué pasa; cancelar lo deja como estaba.
  await closures.getByRole("button", { name: /^Quitar Feriado/ }).click()
  const removal = page.getByRole("alertdialog", { name: "Quitar el feriado o cierre" })
  await expect(removal).toContainText("ese tramo vuelve a ofrecerse para reservar")
  await removal.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(closures.getByText("Feriado", { exact: true })).toBeVisible()
  await closures.getByRole("button", { name: /^Quitar Feriado/ }).click()
  await removal.getByRole("button", { name: "Quitar", exact: true }).click()
  await expect(closures.getByText("Sin feriados ni cierres", { exact: false })).toBeVisible()

  // Durante la ausencia no queda ningún tramo reservable (lo mismo que pinta la agenda).
  const availability = await call<{ free: unknown[] }>(
    page,
    "GET",
    `/api/agenda/availability?branchId=${owner.branchId}&from=${tomorrow}T05:00:00.000Z&to=${dayAfter}T05:00:00.000Z`,
    owner.org.slug,
  )
  expect(availability.free).toHaveLength(0)

  // Mañana: como aún tiene una cita, sigue en la rejilla y la cita avisa de que hay que moverla.
  await gotoHydrated(page, tenant(owner.org.slug, `/agenda?date=${tomorrow}`))
  await expect(
    page
      .getByRole("region", { name: /^Agenda del/ })
      .getByRole("button", { name: /Micaela Ríos.*Dentro de una ausencia: Vacaciones/ }),
  ).toBeVisible()
  await shot("ausencia-cita-por-mover")

  // Pasado mañana: sin citas, ya no es una columna vacía sino un motivo.
  await gotoHydrated(page, tenant(owner.org.slug, `/agenda?date=${dayAfter}`))
  await expect(page.getByText(/no atiende el /)).toBeVisible()
  await expect(page.getByText(/^Vacaciones\./)).toBeVisible()
  await shot("ausencia-dia-sin-atencion")
})

test("agenda: duración de una cita regular, paciente nuevo y urgencia fuera de horario", async ({
  createOwner,
}, info) => {
  const owner = await createOwner("agenda-casos")
  const { page } = owner
  const shot = async (name: string) =>
    info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
  await call(page, "POST", "/api/agenda/chairs", owner.org.slug, { branchId: owner.branchId, name: "Sillón 1" }, 201)
  // Atiende todos los días de 09:00 a 13:00.
  await call(
    page,
    "PUT",
    "/api/agenda/schedules",
    owner.org.slug,
    {
      branchId: owner.branchId,
      dentistUserId: owner.user.id,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
    },
    200,
  )
  await page.setViewportSize({ width: 1440, height: 900 })

  // Ajustes: una cita regular dura 1 h hasta que la sede dice otra cosa.
  await gotoHydrated(page, tenant(owner.org.slug, "/settings/availability"))
  const regular = page.getByRole("radiogroup", { name: "Duración de una cita regular" })
  await expect(regular.getByRole("radio", { name: "1 h", exact: true })).toBeChecked()
  await regular.getByRole("radio", { name: "30 min" }).click()
  await expect(page.getByText("Una cita regular dura 30 min")).toBeVisible()
  await expect(regular.getByRole("radio", { name: "30 min" })).toBeChecked()
  await shot("duracion-regular")
  const resources = await call<{ defaultDurationMin: number }>(
    page,
    "GET",
    `/api/agenda/resources?branchId=${owner.branchId}`,
    owner.org.slug,
  )
  expect(resources.defaultDurationMin).toBe(30)

  // La clínica publica su registro, que pide la fecha de nacimiento: aun así se reserva con lo mínimo (fase 2.1).
  const registration = await call<{ version: number; fields: Record<string, string> }>(page, "GET", "/api/patient-registration/config", owner.org.slug)
  await call(page, "PUT", "/api/patient-registration/config", owner.org.slug, {
    expectedVersion: registration.version, enabled: false, fields: registration.fields, privacyNotice: "Aviso de prueba.",
  })
  // Con WhatsApp conectado, el teléfono que escribe recepción pasa a ser su WhatsApp (alta manual, ADR 0027).
  await call(page, "POST", "/api/channels/connections", owner.org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA Agenda",
    config: { phoneNumberId: "E2E-AGENDA", wabaId: "E2E-AGENDA-WABA", accessToken: "e2e", appSecret: "e2e-secret" },
  }, 201)

  // Paciente nuevo: se registra con lo mínimo sin salir de «Nueva cita».
  await gotoHydrated(page, tenant(owner.org.slug, "/agenda"))
  await openBooking(page)
  await expect(page.getByRole("button", { name: "Registrar paciente nuevo" })).toBeVisible()
  await page.getByLabel("Paciente", { exact: true }).fill("Rosa Quispe")
  // Si no existe, registrarla se ofrece ahí mismo, donde antes solo decía «Sin resultados».
  await page.getByRole("button", { name: "Registrar a Rosa Quispe" }).click()
  // Lo tecleado al buscar ya viene puesto.
  await expect(page.getByLabel("Nombres", { exact: true })).toHaveValue("Rosa")
  await expect(page.getByLabel("Primer apellido", { exact: true })).toHaveValue("Quispe")
  await page.getByLabel("Teléfono", { exact: true }).fill("+51999123456")
  // Dice lo que de verdad pasa: lo que pide la clínica queda pendiente en su página.
  await expect(page.getByText("Con esto basta para la cita. Lo que la clínica pide (fecha de nacimiento) queda pendiente en su página.")).toBeVisible()
  // El aviso previo que pide WhatsApp para los mensajes de su cita (ADR 0040).
  await expect(page.getByText("Díselo: «Te avisaremos por WhatsApp sobre tus citas.»")).toBeVisible()
  // Lo único que pide permiso, opcional: lo que dijo por teléfono.
  await expect(page.getByText("¿Acepta recibir novedades y promociones de la clínica?")).toBeVisible()
  await page.getByRole("button", { name: "Sí, aceptó por teléfono" }).click()
  await expect(page.getByRole("button", { name: "Sí, aceptó por teléfono" })).toHaveAttribute("aria-pressed", "true")
  // Una semana después el día entero está libre, sea la hora que sea hoy.
  await page.getByRole("button", { name: "Semana siguiente" }).click()
  const hours = page.getByRole("region", { name: /^Horas del/ })
  const block = hours.getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / })
  // El bloque toma la duración regular recién configurada.
  await expect(block).toHaveAccessibleName(/^De 09:00 a 09:30 con /)
  await expect(page.getByRole("button", { name: /^Dura 30 min\./ })).toBeVisible()
  await shot("nueva-cita-paciente-nuevo")
  await page.getByRole("button", { name: /^Registrar y reservar / }).click()
  const grid = page.getByRole("region", { name: /^Agenda del/ })
  await expect(grid.getByRole("button", { name: /^Cita de Rosa Quispe/ })).toHaveCount(1)
  const people = await call<{ id: string; displayName: string }[]>(
    page,
    "GET",
    "/api/patients?q=Rosa&limit=5",
    owner.org.slug,
  )
  expect(people.map((person) => person.displayName)).toEqual(["Rosa Quispe"])
  const rosaPerson = await call<{ personId: string }>(page, "GET", `/api/people/by-patient/${people[0]!.id}`, owner.org.slug)
  const rosaPage = await call<{ channels: string[] }>(page, "GET", `/api/people/${rosaPerson.personId}`, owner.org.slug)
  expect(rosaPage.channels).toEqual(["whatsapp"])
  const said = await call<Array<{ purpose: string; granted: boolean | null; source: string | null }>>(
    page, "GET", `/api/agent/admin/people/${rosaPerson.personId}/permissions`, owner.org.slug,
  )
  expect(said.find((row) => row.purpose === "novedades")).toMatchObject({ granted: true, source: "telefono" })
  const rosaFicha = await call<{ patient: { birthDate: string | null; identityNeedsReview: boolean } }>(page, "GET", `/api/patients/${people[0]!.id}`, owner.org.slug)
  expect(rosaFicha.patient).toMatchObject({ birthDate: null, identityNeedsReview: true })

  // Urgencia: fuera del horario no se reserva sin más; se pregunta y queda dicho.
  await openBooking(page)
  await page.getByLabel("Paciente", { exact: true }).fill("Rosa")
  await page.getByRole("option", { name: /Rosa Quispe/ }).click()
  // Se abre en el día que se estaba viendo: el primer hueco es el que sigue a su cita.
  await expect(block).toHaveAccessibleName(/^De 09:30 a 10:00 con /)
  // Encima de su propia cita no deja reservar.
  await block.press("ArrowUp")
  await expect(page.getByText(/ya está ocupado/)).toBeVisible()
  await expect(page.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ })).toBeDisabled()
  // Antes de que abra, sí: como urgencia.
  for (let step = 0; step < 5; step++) await block.press("ArrowUp")
  await expect(block).toHaveAccessibleName(/^De 08:00 a 08:30 con /)
  await expect(page.getByText(/queda fuera del horario/)).toBeVisible()
  await page.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ }).click()
  const urgent = page.getByRole("dialog", { name: /no atiende a esa hora/ })
  await expect(urgent).toContainText("atiende de 09:00 a 13:00")
  await shot("urgencia-fuera-de-horario")
  await urgent.getByRole("button", { name: "Reservar igual a las 08:00" }).click()
  await expect(grid.getByRole("button", { name: /^Cita de Rosa Quispe/ })).toHaveCount(2)
  const from = new Date(Date.now() - 86_400_000).toISOString()
  const to = new Date(Date.now() + 16 * 86_400_000).toISOString()
  const rows = await call<{ startsAt: string; endsAt: string }[]>(
    page,
    "GET",
    `/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    owner.org.slug,
  )
  // 08:00 y 09:00 de Lima (UTC−5 fijo), media hora cada una.
  expect(rows.map((row) => row.startsAt.slice(11, 16)).sort()).toEqual(["13:00", "14:00"])
  for (const row of rows) expect(Date.parse(row.endsAt) - Date.parse(row.startsAt)).toBe(30 * 60_000)

  // Teléfono: el mismo «cuándo», con los días arriba y las horas debajo.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Nueva cita" }).click()
  await expect(page.getByRole("navigation", { name: "Días de la semana" })).toBeVisible()
  await expect(hours).toBeVisible()
  await hours.scrollIntoViewIfNeeded()
  await shot("nueva-cita-telefono")
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
