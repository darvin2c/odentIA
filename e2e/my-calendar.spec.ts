import { randomUUID } from "node:crypto"
import https from "node:https"
import { calendarFeed } from "@odentia/db/schema/agenda"
import { eq } from "drizzle-orm"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Pide el calendario como lo haría Google o un navegador, con su `User-Agent`.
 * Node no resuelve los `*.localhost` del entorno (el navegador sí): se apunta a
 * 127.0.0.1 conservando el nombre, que el proxy usa para elegir la API.
 */
function getFeed(url: string, userAgent: string): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: { "user-agent": userAgent },
        rejectUnauthorized: false,
        lookup: (_host, options, done) =>
          (options as { all?: boolean }).all
            ? (done as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: "127.0.0.1", family: 4 }])
            : done(null, "127.0.0.1", 4),
      },
      (response) => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          text += chunk
        })
        response.on("end", () => resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"]), text }))
      },
    )
    request.on("error", reject)
  })
}

const GOOGLE = "Google-Calendar-Importer"
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"

/** Mañana en Lima a las 10:00 (UTC−5 fijo), con su día de la semana. */
function limaTomorrow(): { date: string; weekday: number; startsAt: string; endsAt: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() + 86_400_000))
  return { date, weekday: new Date(`${date}T17:00:00Z`).getUTCDay(), startsAt: `${date}T15:00:00.000Z`, endsAt: `${date}T15:30:00.000Z` }
}

test("mi calendario: crear el enlace, lo que entrega, el aviso de uso nuevo, el celular y Equipo (issue 46)", async ({
  owner,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  const room = await call<{ id: string }>(page, "POST", "/api/agenda/rooms", org.slug, { branchId: owner.branchId, name: "Unidad dental 1" }, 201)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: randomUUID(),
    answers: { demographics: { displayName: "Micaela Ríos", docType: "DNI", docNumber: "45678903" }, respondent: "staff", privacyAccepted: false },
  }, 201)
  const { weekday, startsAt, endsAt } = limaTomorrow()
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId: owner.branchId,
    professionalUserId: owner.user.id,
    rules: [{ weekday, startMin: 8 * 60, endMin: 20 * 60 }],
  }, 200)
  const appointment = await call<{ id: string }>(page, "POST", "/api/appointments", org.slug, {
    patientId: patient.id,
    professionalUserId: owner.user.id,
    roomId: room.id,
    startsAt,
    endsAt,
    reason: "Dolor de muela",
  }, 201)

  // Escritorio: «Mi calendario» junto a «Nueva cita», con su próxima cita como saldrá.
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agenda"))
  await expect(page.getByRole("heading", { name: "Agenda", level: 1 })).toBeVisible()
  await info.attach("mi-calendario-agenda", { body: await page.screenshot(), contentType: "image/png" })
  await page.getByRole("button", { name: "Mi calendario" }).click()
  const panel = page.getByRole("region", { name: "Mi calendario" }).or(page.getByRole("dialog", { name: "Mi calendario" }))
  await expect(panel.getByText("Paciente · M. R.")).toBeVisible()
  await expect(panel).not.toContainText("Micaela")
  await info.attach("mi-calendario-antes", { body: await page.screenshot(), contentType: "image/png" })
  await panel.getByRole("button", { name: "Crear mi enlace" }).click()
  await expect(panel.getByRole("link", { name: "Añadir a Google Calendar" })).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A/)
  await expect(panel.getByRole("link", { name: "Añadir a Apple o Outlook" })).toHaveAttribute("href", /^webcal:\/\//)
  const url = await panel.getByLabel("O copia el enlace").inputValue()
  expect(url).toMatch(/\/api\/public\/calendar\/[0-9a-f]{64}\.ics$/)

  // Lo que entrega a Google: la cita con iniciales, sin el nombre ni el motivo.
  const first = await getFeed(url, GOOGLE)
  expect(first.status).toBe(200)
  expect(first.contentType).toBe("text/calendar; charset=utf-8")
  const ics = first.text.replace(/\r\n /g, "")
  expect(ics).toContain(`UID:${appointment.id}@odentia`)
  expect(ics).toContain("SUMMARY:Paciente · M. R.")
  expect(ics).not.toMatch(/Micaela|Ríos|Dolor de muela/)

  // Pasado el primer día, un navegador es un programa nuevo: avisa con «Cambiar enlace» o «Fui yo».
  await fixtureDb.update(calendarFeed).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(calendarFeed.organizationId, org.id))
  expect((await getFeed(url, BROWSER)).status).toBe(200)
  await gotoHydrated(page, tenant(org.slug, "/agenda?calendario=1"))
  await expect(panel.getByText(/Un programa nuevo usó tu enlace: navegador web/)).toBeVisible()
  await expect(panel.getByText("Google Calendar", { exact: true })).toBeVisible()
  await info.attach("mi-calendario-aviso", { body: await page.screenshot(), contentType: "image/png" })
  await panel.getByRole("button", { name: "Fui yo" }).click()
  await expect(panel.getByText(/Un programa nuevo usó tu enlace/)).toHaveCount(0)

  // Equipo dice quién comparte su agenda.
  await gotoHydrated(page, tenant(org.slug, "/settings/team"))
  await expect(page.getByText(/Comparte su agenda · consultada hoy/)).toBeVisible()
  await info.attach("mi-calendario-equipo", { body: await page.screenshot(), contentType: "image/png" })

  // Celular: «Mi calendario» va en el menú de la cabecera; cambiar el enlace deja inservible el anterior.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agenda"))
  await page.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Mi calendario" }).click()
  await expect(panel.getByRole("link", { name: "Añadir a Google Calendar" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach("mi-calendario-movil", { body: await page.screenshot(), contentType: "image/png" })
  await panel.getByRole("button", { name: "Cambiar enlace" }).first().click()
  await page.getByRole("button", { name: "Sí, cambiarlo" }).click()
  await expect(page.getByText(/el enlace anterior ya no sirve/)).toBeVisible()
  expect((await getFeed(url, GOOGLE)).status).toBe(404)
})
