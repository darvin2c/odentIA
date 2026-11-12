import { type Db, runReadOnly, withOrgContext } from "@odentia/db"
import { supportAccessAudit, supportAccessGrant } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  getMySupportCase,
  giveSupportAccessFromHelp,
  grantSupportAccess,
  readSupportDiagnostic,
  requestSupportAccess,
  revokeSupportAccess,
  setSupportCaseStatus,
} from "./admin-support.js"
import { recordClinicalAccess } from "./clinical-access.js"
import { sendHelpRequest } from "./help.js"
import { createSupportPass, endSupportSession, redeemSupportPass, resolveSupportSession, supportSessionEnding } from "./support-session.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"

/** Soporte mira la clínica con un rol, en solo lectura (ADR 0184). */
setupTestDb()
const ORG = "org_soporte_rol"
const OTHER = "org_soporte_otra"
const OWNER = "sr-owner"
const ADMIN = "sr-admin"
const RECEPTION = "sr-reception"
const STAFF = "sr-staff"
const STAFF_2 = "sr-staff-2"
const staff: AdminActor = { userId: STAFF, role: "support" }
const otherStaff: AdminActor = { userId: STAFF_2, role: "support" }

const run = <T,>(fn: (tx: Db) => Promise<T>, org = ORG) => withOrgContext(appDb, org, fn)
const give = (minutes: number, viewRole: string | null, by = OWNER) =>
  run((tx) => giveSupportAccessFromHelp(tx, ORG, by, true, { minutes, viewRole, reason: "Revisar la carga", screen: "/home", role: "Propietario", appVersion: null }))
const openGrants = () =>
  ownerDb.select().from(supportAccessGrant).where(and(eq(supportAccessGrant.organizationId, ORG), isNull(supportAccessGrant.revokedAt)))

beforeAll(async () => {
  await insertOrg(ownerDb, ORG, "soporte-rol")
  await insertOrg(ownerDb, OTHER, "soporte-otra")
  await ownerDb.insert(user).values([
    { id: OWNER, name: "Dra. Ana", email: "ana@sr.test", emailVerified: true },
    { id: ADMIN, name: "Admin Luis", email: "luis@sr.test", emailVerified: true },
    { id: RECEPTION, name: "Lucía", email: "lucia@sr.test", emailVerified: true },
    { id: STAFF, name: "Sofía Soporte", email: "sofia@sr.test", emailVerified: true },
    { id: STAFF_2, name: "Otro Soporte", email: "otro@sr.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-sr-owner", userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: "m-sr-admin", userId: ADMIN, organizationId: ORG, role: "admin", createdAt: new Date() },
    { id: "m-sr-reception", userId: RECEPTION, organizationId: ORG, role: "reception", createdAt: new Date() },
  ])
})

describe("dar acceso con un rol", () => {
  it("desde Ayuda abre el caso y da el permiso; deja autor en la auditoría y en Actividad del equipo", async () => {
    const { caseId, grant } = await give(30, "clinician")
    expect(grant.scope).toBe("rol")
    expect(grant.viewRole).toBe("clinician")
    const audits = await ownerDb.select().from(supportAccessAudit).where(eq(supportAccessAudit.grantId, grant.id))
    expect(audits.map((row) => [row.action, row.staffUserId])).toEqual([["autorizado", OWNER]])
    const events = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, ORG), eq(auditEvent.entityId, grant.id)))
    expect(events.map((row) => row.action)).toEqual(["support.access_granted"])
    const detail = await run((tx) => getMySupportCase(tx, ORG, OWNER, caseId))
    expect(detail.question).toBe("Revisar la carga")
  })

  it("un rol que no es de la clínica, o el de propietario, se rechaza", async () => {
    await expect(give(30, "owner")).rejects.toThrow(/rol/i)
    await expect(give(30, "workshop")).rejects.toThrow(/rol/i)
  })

  it("uno solo vigente por clínica: dar otro reemplaza al anterior, también a la vez", async () => {
    await Promise.all([give(30, "reception"), give(30, "cashier"), give(15, null)])
    expect(await openGrants()).toHaveLength(1)
    const [first] = await openGrants()
    await give(60, "admin", ADMIN)
    const closed = await ownerDb.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, first?.id ?? ""))
    expect(closed[0]).toMatchObject({ endReason: "reemplazado", revokedBy: ADMIN })
    expect(await openGrants()).toHaveLength(1)
  })

  it("quitar deja quién y por qué, y en Actividad del equipo; la dirección con otro caso no lo quita", async () => {
    const { caseId, grant } = await give(30, "reception")
    await expect(run((tx) => revokeSupportAccess(tx, ORG, OWNER, true, grant.id, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow(/no encontrado/i)
    await run((tx) => revokeSupportAccess(tx, ORG, OWNER, true, grant.id, caseId))
    const [row] = await ownerDb.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, grant.id))
    expect(row).toMatchObject({ endReason: "quitado", revokedBy: OWNER })
    const events = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, ORG), eq(auditEvent.entityId, grant.id)))
    expect(events.map((event) => event.action).sort()).toEqual(["support.access_granted", "support.access_revoked"])
  })

  it("recepción no da ni quita", async () => {
    await expect(
      run((tx) => giveSupportAccessFromHelp(tx, ORG, RECEPTION, false, { minutes: 30, viewRole: "reception", screen: "/", role: "Recepción", appVersion: null })),
    ).rejects.toThrow(/propietario/i)
    const { caseId, grant } = await give(30, "reception")
    await expect(run((tx) => revokeSupportAccess(tx, ORG, RECEPTION, false, grant.id, caseId))).rejects.toThrow(/No puedes/)
  })
})

describe("el pedido de soporte", () => {
  it("lleva el rol y los minutos; autorizarlo da el permiso a quien lo pidió", async () => {
    const kase = await run((tx) => sendHelpRequest(tx, ORG, { userId: RECEPTION, roleLabel: "Recepción" }, { question: "No veo la radiografía", screen: "/people", kind: "problema" }))
    await ownerDb.transaction((tx) => requestSupportAccess(tx as Db, staff, kase.id, new Date(), { viewRole: "clinician", minutes: 60 }))
    const detail = await run((tx) => getMySupportCase(tx, ORG, OWNER, kase.id))
    expect(detail).toMatchObject({ accessRequestedRole: "clinician", accessRequestedMinutes: 60, accessRequestPending: true })
    const grant = await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 60, { viewRole: "clinician" }))
    expect(grant.staffUserId).toBe(STAFF)
  })

  it("resolver el caso cierra su permiso", async () => {
    const kase = await run((tx) => sendHelpRequest(tx, ORG, { userId: OWNER, roleLabel: "Propietario" }, { question: "Revisen la agenda", screen: "/agenda", kind: "problema" }))
    const grant = await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 30, { viewRole: "reception" }))
    await setSupportCaseStatus(ownerDb, staff, kase.id, "resuelto")
    const [row] = await ownerDb.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, grant.id))
    expect(row?.endReason).toBe("caso_resuelto")
  })
})

describe("la sesión de solo mirar", () => {
  it("el pase sirve una vez, para quien tiene el permiso, y la sesión termina al quitarlo", async () => {
    const { caseId, grant } = await give(30, "clinician")
    // Sin pedido, el permiso pasa a ser de la primera persona de soporte que lo usa.
    const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, staff, caseId))
    await expect(ownerDb.transaction((tx) => createSupportPass(tx as Db, otherStaff, caseId))).rejects.toThrow(/dado a ti/)
    expect(pass.slug).toBe("soporte-rol")
    const session = await redeemSupportPass(ownerDb, pass.token)
    await expect(redeemSupportPass(ownerDb, pass.token)).rejects.toThrow(/no sirve/)
    const live = await resolveSupportSession(ownerDb, session.sessionToken)
    expect(live).toMatchObject({ organizationId: ORG, staffUserId: STAFF, viewRole: "clinician", grantId: grant.id })
    await run((tx) => revokeSupportAccess(tx, ORG, OWNER, true, grant.id, caseId))
    expect(await resolveSupportSession(ownerDb, session.sessionToken)).toBeNull()
    expect(await supportSessionEnding(ownerDb, session.sessionToken)).toMatchObject({ reason: "quitado", byName: "Dra. Ana" })
  })

  it("si quien lo dio deja de administrar la clínica, el acceso termina", async () => {
    const { caseId, grant } = await give(30, "reception", ADMIN)
    const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, staff, caseId))
    const session = await redeemSupportPass(ownerDb, pass.token)
    await ownerDb.update(member).set({ role: "reception" }).where(eq(member.id, "m-sr-admin"))
    try {
      expect(await resolveSupportSession(ownerDb, session.sessionToken)).toBeNull()
      const [row] = await ownerDb.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, grant.id))
      expect(row?.endReason).toBe("sin_quien_lo_dio")
    } finally {
      await ownerDb.update(member).set({ role: "admin" }).where(eq(member.id, "m-sr-admin"))
    }
  })

  it("«Salir» termina la sesión aunque el permiso siga", async () => {
    const { caseId } = await give(30, "reception")
    const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, staff, caseId))
    const session = await redeemSupportPass(ownerDb, pass.token)
    await endSupportSession(ownerDb, session.sessionToken)
    expect(await resolveSupportSession(ownerDb, session.sessionToken)).toBeNull()
  })

  it("el diagnóstico es de la persona a quien se dio", async () => {
    const kase = await run((tx) => sendHelpRequest(tx, ORG, { userId: OWNER, roleLabel: "Propietario" }, { question: "Revisen canales", screen: "/settings", kind: "problema" }))
    await ownerDb.transaction((tx) => requestSupportAccess(tx as Db, staff, kase.id, new Date(), { viewRole: null, minutes: 30 }))
    await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 30))
    await expect(readSupportDiagnostic(ownerDb, otherStaff, kase.id)).rejects.toThrow(/permiso vigente/i)
    expect((await readSupportDiagnostic(ownerDb, staff, kase.id)).organizationId).toBe(ORG)
  })
})

describe("solo lectura en la base", () => {
  it("una transacción de la clínica dentro de runReadOnly no escribe", async () => {
    const error = await runReadOnly(() => run((tx) => tx.insert(auditEvent).values({ organizationId: ORG, action: "x.y", entity: "x" }))).then(
      () => null,
      (caught: unknown) => caught,
    )
    // PostgreSQL lo rechaza: «cannot execute INSERT in a read-only transaction».
    const cause = (error as { cause?: { message?: string } } | null)?.cause?.message ?? String(error)
    expect(cause).toMatch(/read-only/i)
  })

  it("lo que soporte abre queda en el caso de la clínica, con el nombre de la persona", async () => {
    const { caseId } = await give(30, "clinician")
    const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, staff, caseId))
    await redeemSupportPass(ownerDb, pass.token)
    const [patient] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Rosa Prueba", patientNumber: await nextPatientNumber(ownerDb, ORG) })
    if (!patient) throw new Error("sin paciente")
    await run((tx) => recordClinicalAccess(tx, ORG, STAFF, patient.id, "documentos"))
    const detail = await run((tx) => getMySupportCase(tx, ORG, OWNER, caseId))
    const grant = detail.grants.find((item) => item.active)
    expect(grant?.staffName).toBe("Sofía Soporte")
    expect(grant?.reads.map((read) => read.resource)).toEqual(["documentos"])
  })
})

