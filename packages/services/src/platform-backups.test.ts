import { platformBackup } from "@odentia/db/schema/admin-backups"
import { supportCase, supportMessage, supportNotice } from "@odentia/db/schema/admin-support"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { backupHealth, reportBackupProblem } from "./platform-backups.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** «Backup sin verificar»: lo que anota el servicio backup y el aviso a Soporte. */
setupTestDb()

const now = new Date("2026-10-28T12:00:00Z")
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000)

describe("backups verificados", () => {
  it("sin vueltas anotadas solo avisa cuando se esperaban backups hace más de 26 horas", async () => {
    expect(await backupHealth(ownerDb, { now })).toEqual({ state: "sin_registro" })
    expect(await backupHealth(ownerDb, { now, expectedSince: hoursAgo(2) })).toEqual({ state: "sin_registro" })
    expect(await backupHealth(ownerDb, { now, expectedSince: hoursAgo(27) })).toEqual({ state: "vencido", lastVerifiedAt: null })
  })

  it("al día con uno verificado reciente; vencido pasadas 26 horas; fallido si falló el último", async () => {
    await ownerDb.insert(platformBackup).values({
      startedAt: hoursAgo(30),
      finishedAt: hoursAgo(30),
      status: "verificado",
      object: "pg-viejo.dump",
      sizeBytes: 1000,
      migrations: 17,
      organizations: 2,
      patients: 0,
    })
    expect(await backupHealth(ownerDb, { now })).toMatchObject({ state: "vencido", lastVerifiedAt: hoursAgo(30) })
    expect(await reportBackupProblem(ownerDb, { state: "al_dia", lastVerifiedAt: now })).toBeNull()

    await ownerDb.insert(platformBackup).values({ startedAt: hoursAgo(5), finishedAt: hoursAgo(5), status: "verificado", object: "pg-nuevo.dump", migrations: 17 })
    expect(await backupHealth(ownerDb, { now })).toEqual({ state: "al_dia", lastVerifiedAt: hoursAgo(5) })

    await ownerDb.insert(platformBackup).values({
      startedAt: hoursAgo(1),
      finishedAt: hoursAgo(1),
      status: "fallido",
      step: "restauracion",
      detail: "pg_restore: error: could not execute query",
    })
    const health = await backupHealth(ownerDb, { now })
    expect(health).toMatchObject({ state: "fallido", step: "restauracion", lastVerifiedAt: hoursAgo(5) })

    // Un solo caso de odentIA, sin clínica, con su correo al buzón de soporte.
    const first = await reportBackupProblem(ownerDb, health)
    expect(first?.created).toBe(true)
    expect(await reportBackupProblem(ownerDb, health)).toEqual({ caseId: first?.caseId, created: false })
    const cases = await ownerDb.select().from(supportCase).where(eq(supportCase.dedupeKey, "backup-sin-verificar"))
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({ question: "Backup sin verificar", organizationId: null, openedBy: null, status: "abierto" })
    expect(cases[0]?.detail).toContain("pg_restore")
    const lines = await ownerDb.select({ body: supportMessage.body }).from(supportMessage).where(eq(supportMessage.caseId, first?.caseId ?? ""))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.body).toContain("El backup falló al restaurarlo en la base de prueba")
    const notices = await ownerDb.select().from(supportNotice).where(eq(supportNotice.caseId, first?.caseId ?? ""))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: "caso_nuevo" })
  })

  it("un verificado dice qué subió; un fallido, dónde falló", async () => {
    await expect(ownerDb.insert(platformBackup).values({ startedAt: now, status: "verificado", migrations: 1 })).rejects.toThrow()
    await expect(ownerDb.insert(platformBackup).values({ startedAt: now, status: "fallido" })).rejects.toThrow()
  })
})
