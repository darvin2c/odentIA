import { withOrgContext } from "@odentia/db"
import { supportCase, supportMessage, supportNotice } from "@odentia/db/schema/admin-support"
import { asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { reportModelOutage } from "./model-outage.js"
import { claimSupportNotice } from "./support-notices.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** «Modelo sin responder»: el caso automático que recibe Soporte de odentIA. */
setupTestDb()

const report = (orgId: string, code = "API_KEY_REQUIRED", at = new Date("2026-10-16T14:00:00Z")) => ({
  orgId,
  llm: "chatgpt_6",
  llmLabel: "ChatGPT 6",
  code,
  detail: "La plataforma no tiene la clave de OpenAI configurada (LLM_OPENAI_API_KEY)",
  at,
})

describe("caso automático «Modelo sin responder»", () => {
  it("un mismo motivo en varias clínicas abre un solo caso, con el motivo técnico y desde cuándo", async () => {
    const first = await reportModelOutage(ownerDb, report("org_a"))
    expect(first.created).toBe(true)
    // La misma clínica otra vez y otra clínica después: el mismo caso.
    expect(await reportModelOutage(ownerDb, report("org_a"))).toEqual({ caseId: first.caseId, created: false })
    expect(await reportModelOutage(ownerDb, report("org_b", "API_KEY_REQUIRED", new Date("2026-10-16T14:05:00Z")))).toEqual({
      caseId: first.caseId,
      created: false,
    })

    const cases = await ownerDb.select().from(supportCase).where(eq(supportCase.dedupeKey, "modelo-sin-responder:chatgpt_6:API_KEY_REQUIRED"))
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({
      question: "Modelo sin responder · Clínica norte, Clínica sur",
      organizationId: null,
      openedBy: null,
      kind: "problema",
      status: "abierto",
    })
    expect(cases[0]?.detail).toContain("LLM_OPENAI_API_KEY")
    const lines = await ownerDb
      .select({ body: supportMessage.body, authorKind: supportMessage.authorKind })
      .from(supportMessage)
      .where(eq(supportMessage.caseId, first.caseId))
      .orderBy(asc(supportMessage.createdAt))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ authorKind: "sistema" })
    expect(lines[0]?.body).toContain("Clínica norte [org_a] · ChatGPT 6 no responde desde 2026-10-16T14:00:00.000Z")
    expect(lines[1]?.body).toContain("Clínica sur [org_b]")

    // Un solo correo «Caso nuevo» al buzón de soporte, que nombra a la clínica y a odentIA como autor.
    const notices = await ownerDb.select().from(supportNotice).where(eq(supportNotice.caseId, first.caseId))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: "caso_nuevo", recipientUserId: null })
    const claimed = await claimSupportNotice(ownerDb, notices[0]?.id ?? "")
    expect(claimed).toMatchObject({ to: null, who: "odentIA", clinicName: "Clínica norte, Clínica sur" })

    // Ninguna clínica ve el caso ni su motivo técnico.
    for (const org of ["org_a", "org_b"]) {
      const seen = await withOrgContext(appDb, org, (tx) => tx.select({ id: supportCase.id }).from(supportCase).where(eq(supportCase.id, first.caseId)))
      expect(seen).toEqual([])
    }
  })

  it("otro motivo es otro caso, y uno resuelto no recibe el siguiente fallo", async () => {
    const quota = await reportModelOutage(ownerDb, report("org_a", "PROVIDER_QUOTA"))
    expect(quota.created).toBe(true)
    await ownerDb.update(supportCase).set({ status: "resuelto" }).where(eq(supportCase.id, quota.caseId))
    const again = await reportModelOutage(ownerDb, report("org_a", "PROVIDER_QUOTA"))
    expect(again.created).toBe(true)
    expect(again.caseId).not.toBe(quota.caseId)
  })

  it("dos clínicas que fallan a la vez por un motivo nuevo abren un solo caso", async () => {
    const both = await Promise.all([reportModelOutage(ownerDb, report("org_a", "PROVIDER_REJECTED")), reportModelOutage(ownerDb, report("org_b", "PROVIDER_REJECTED"))])
    expect(both.filter((result) => result.created)).toHaveLength(1)
    expect(both[0]?.caseId).toBe(both[1]?.caseId)
    const [kase] = await ownerDb.select().from(supportCase).where(eq(supportCase.dedupeKey, "modelo-sin-responder:chatgpt_6:PROVIDER_REJECTED"))
    expect(kase?.question).toMatch(/^Modelo sin responder · Clínica (norte|sur), Clínica (norte|sur)$/)
  })
})
