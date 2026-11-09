/**
 * La atención según lo que pasa: una sesión abierta desde su cita propone el
 * motivo («Continúa: …») y el diagnóstico del tratamiento («Usar»), dice lo que
 * falta para firmar en un solo lugar y todo se escribe en la misma página.
 */
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, patientApiPath } from "./patients-fixture"

test("sesión desde su cita: motivo y diagnóstico propuestos, lo que falta una vez y todo en una página", async ({
  owner,
}, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  const ids = await buildClinicalBase(owner)
  await createAcceptedBudget(owner, ids)
  const apiPath = patientApiPath(ids.patientId)
  // Agenda abierta todo el día, para que la cita de ahora sea válida a cualquier hora.
  const room = await call<{ id: string }>(page, "POST", "/api/agenda/rooms", slug, { branchId: owner.branchId, name: "Unidad 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", slug, {
    branchId: owner.branchId,
    professionalUserId: owner.user.id,
    rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 })),
  })
  const start = new Date(Math.ceil((Date.now() + 5 * 60_000) / (5 * 60_000)) * (5 * 60_000))
  const appointment = await call<{ id: string }>(page, "POST", "/api/appointments", slug, {
    patientId: ids.patientId,
    professionalUserId: owner.user.id,
    roomId: room.id,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    planItemIds: [ids.itemId],
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { appointmentId: appointment.id }, 201)

  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${encounter.id}`))
  // El diagnóstico del tratamiento se ofrece en la tarjeta, con «Usar».
  await expect(page.getByText(/Del tratamiento/).first()).toBeVisible()
  await expect(page.getByText(/Continúa:/).first()).toBeVisible()
  await views("sesion-al-abrir")
  // El «Usar» del diagnóstico, no el del motivo de la cita («Usar «…» como motivo»).
  await page.getByRole("button", { name: /^Usar(?! «| como)/ }).first().click()
  await expect(page.getByText("K02.1").first()).toBeVisible()
  // Lo que falta para firmar ya no incluye el diagnóstico.
  await expect(page.getByText(/diagnóstico/i).filter({ hasText: /Falta/ })).toHaveCount(0)
  await shot("sesion-diagnostico-usado")
  // La evolución se escribe en su sitio, en la misma página: sin cajón ni «Listo».
  await expect(page.getByRole("button", { name: "Listo", exact: true })).toHaveCount(0)
  await page.getByLabel("Evolución", { exact: true }).fill("Se trabajó la 36; sin molestias.")
  await views("evolucion-en-linea")
  // Guardado: lo que falta ya no incluye la evolución.
  await expect(page.getByText(/Falta 1 para cerrar/)).toBeVisible()
  await shot("sesion-casi-lista")
})
