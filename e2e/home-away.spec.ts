import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import { homeVisit } from "@odentia/db/schema/workspace"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { enableAgenda } from "./patients-fixture"

for (const viewport of [
  { name: "computadora", width: 1440, height: 900 },
  { name: "celular", width: 390, height: 844 },
]) {
  test(`inicio ${viewport.name}: «Mientras no estabas» una vez al día`, async ({
    owner,
    fixtureDb,
  }, info) => {
    await owner.page.setViewportSize({ width: viewport.width, height: viewport.height })
    const { roomId } = await enableAgenda(owner)
    const patient = await call<{ id: string }>(
      owner.page,
      "POST",
      "/api/patients",
      owner.org.slug,
      {
        submissionId: randomUUID(),
        answers: {
          demographics: { displayName: "Lucía Ramos", docType: "DNI", docNumber: "41234567" },
          respondent: "staff",
          privacyAccepted: false,
        },
      },
      201,
    )
    // Ayer miró Inicio por última vez; anoche Recepción agendó una cita.
    const yesterday = new Date(Date.now() - 26 * 3_600_000)
    await fixtureDb.insert(homeVisit).values({
      organizationId: owner.org.id,
      userId: owner.user.id,
      lastSeenAt: yesterday,
      greetedOn: "2026-01-01",
    })
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    await fixtureDb.insert(appointment).values({
      organizationId: owner.org.id,
      branchId: owner.branchId,
      patientId: patient.id,
      professionalUserId: owner.user.id,
      roomId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
      source: "agent",
      createdAt: new Date(Date.now() - 10 * 3_600_000),
    })

    await gotoHydrated(owner.page, tenant(owner.org.slug, "/home"))
    const line = owner.page.getByRole("region", { name: "Mientras no estabas" })
    await expect(line).toContainText("Mientras no estabas, tus agentes agendaron 1 cita.")
    await expect(line.getByRole("link", { name: "Abrir la Agenda" })).toBeVisible()
    await owner.page.screenshot({
      path: info.outputPath("inicio-mientras-no-estabas.png"),
      fullPage: true,
    })

    await line.getByRole("button", { name: "Cerrar" }).click()
    await expect(line).toHaveCount(0)
    // Una vez al día: al volver a Inicio ya no aparece.
    await gotoHydrated(owner.page, tenant(owner.org.slug, "/home"))
    await expect(owner.page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible()
    await expect(owner.page.getByRole("region", { name: "Mientras no estabas" })).toHaveCount(0)
  })
}
