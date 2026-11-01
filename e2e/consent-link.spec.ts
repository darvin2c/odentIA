import { consentLinkJourney } from "./consent-link-journey"
import { API, tenant } from "./env"
import { test } from "./fixtures"

for (const longAgo of [false, true]) {
  const title = longAgo ? "escribió hace dos días y Sofi agradece con el mensaje aprobado" : "Sofi agradece por su chat"
  test(`consentimiento por enlace: el equipo lo envía, la persona firma, ${title} y la clínica ve su firma antes de confirmar`, async ({ owner, browser, nextEventId, fixtureDb }, info) => {
    await consentLinkJourney({
      page: owner.page,
      browser,
      info,
      slug: owner.org.slug,
      orgId: owner.org.id,
      apiBase: API,
      userId: owner.user.id,
      url: (path) => tenant(owner.org.slug, path),
      templateKey: "exodoncia",
      clinician: "odontólogo",
      nextEventId,
      ...(longAgo ? { wroteLongAgo: { db: fixtureDb } } : {}),
    })
  })
}
