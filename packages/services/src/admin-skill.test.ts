import { saasClient, saasImportDraft, saasSkillKey } from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { userGlobalBlock } from "@odentia/db/schema/admin-organizations"
import { user } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clientFileKey, registerClientFile } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import {
  approveImportDraft,
  checkImportDraft,
  createSkillKey,
  depositImportDraft,
  hashSkillKey,
  importDraftPayload,
  listImportDrafts,
  listSkillKeys,
  markImportDraftUsed,
  purgeImportDraftPayloads,
  resolveSkillKey,
  returnImportDraft,
  revokeSkillKey,
  type SkillActor,
} from "./admin-skill.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** La llave de la skill de la carga: solo deposita borradores; el sí, la carga y el envío son de una persona. */
setupTestDb()
const admin: AdminActor = { userId: "sk-admin", role: "admin" }
const support: AdminActor = { userId: "sk-support", role: "support" }
const ORG = "sk-org"
const SLUG = "sk-clinica"
const DAY = 86_400_000
let clientId: string
let token: string
let keyId: string

const setupPlan = (slug = SLUG) => ({
  kind: "clinica",
  version: 1,
  product: "dental",
  countryCode: "PE",
  clinic: "Clínica Llave (ficticia)",
  slug,
  branches: [{ key: "centro", name: "Sede Centro" }],
})

const patientsPlan = (firstName = "Rosa") => ({
  version: 1,
  countryCode: "PE",
  sources: [{ name: "pacientes.xlsx", sha256: "a".repeat(64) }],
  people: [
    {
      key: "1",
      patient: true,
      demographics: {
        displayName: `${firstName} Mamani`,
        givenNames: firstName,
        familyName: "Mamani",
      },
    },
    {
      key: "2",
      patient: false,
      demographics: { displayName: "Juan Mamani", givenNames: "Juan", familyName: "Mamani" },
    },
  ],
})

const report = (number = 1) => ({
  product: "dental",
  clinic: "Clínica Llave",
  to: "Dra. Ana Pérez",
  email: "ana@llave.test",
  number,
  stage: "Alta de su cuenta",
  companion: { name: "Ada", email: "ada@odentia32.com" },
  done: ["Cargamos sus servicios"],
  where: ["En Configuración"],
})

async function fakeKeyActor(): Promise<SkillActor> {
  return resolveSkillKey(ownerDb, token)
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@skill.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@skill.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin", active: true },
    { userId: support.userId, role: "support", active: true },
  ])
  await insertOrg(ownerDb, ORG, SLUG)
  await insertOrg(ownerDb, "sk-sin-cliente", "sk-sin-cliente")
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Llave (ficticia)", product: "dental", organizationId: ORG })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  clientId = row.id
})

describe("llaves", () => {
  it("solo Administración crea su llave; vuelve una vez y se guarda su huella", async () => {
    await expect(createSkillKey(ownerDb, support, { label: "Mi equipo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(createSkillKey(ownerDb, admin, { label: "  " })).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { label: expect.any(String) },
    })
    const now = new Date()
    const created = await createSkillKey(ownerDb, admin, { label: "Portátil de Ada" }, now)
    token = created.token
    keyId = created.id
    expect(token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/)
    expect(created.expiresAt.getTime()).toBe(now.getTime() + 90 * DAY)
    const [stored] = await ownerDb.select().from(saasSkillKey).where(eq(saasSkillKey.id, keyId))
    expect(stored?.tokenHash).toBe(hashSkillKey(token))
    expect(JSON.stringify(stored)).not.toContain(token)
    const listed = await listSkillKeys(ownerDb, admin)
    expect(listed).toEqual([
      expect.objectContaining({
        id: keyId,
        label: "Portátil de Ada",
        state: "vigente",
        user: { userId: admin.userId, name: "Ada Administración" },
      }),
    ])
    expect(JSON.stringify(listed)).not.toContain(stored?.tokenHash ?? "-")
    await expect(listSkillKeys(ownerDb, support)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("la llave vale con su dueña activa y sin bloqueo; anota el último uso", async () => {
    const at = new Date()
    const actor = await resolveSkillKey(ownerDb, token, at)
    expect(actor).toEqual({
      userId: admin.userId,
      role: "admin",
      via: "skill",
      keyId,
      scope: "carga",
    })
    const [used] = await ownerDb
      .select({ at: saasSkillKey.lastUsedAt })
      .from(saasSkillKey)
      .where(eq(saasSkillKey.id, keyId))
    expect(used?.at?.getTime()).toBe(at.getTime())

    for (const bad of ["", "sk_corta", `sk_${"x".repeat(43)}`, `${token}x`])
      await expect(resolveSkillKey(ownerDb, bad)).rejects.toMatchObject({
        code: "SKILL_KEY_INVALID",
        status: 401,
      })
    await expect(
      resolveSkillKey(ownerDb, token, new Date(Date.now() + 91 * DAY)),
    ).rejects.toMatchObject({
      code: "SKILL_KEY_INVALID",
    })

    await ownerDb
      .update(adminStaff)
      .set({ active: false })
      .where(eq(adminStaff.userId, admin.userId))
    await expect(resolveSkillKey(ownerDb, token)).rejects.toMatchObject({
      code: "SKILL_KEY_INVALID",
    })
    await ownerDb
      .update(adminStaff)
      .set({ active: true })
      .where(eq(adminStaff.userId, admin.userId))

    await ownerDb
      .insert(userGlobalBlock)
      .values({ userId: admin.userId, reason: "Bloqueo de prueba de la llave" })
    await expect(resolveSkillKey(ownerDb, token)).rejects.toMatchObject({
      code: "SKILL_KEY_INVALID",
    })
    await ownerDb
      .update(userGlobalBlock)
      .set({ active: false })
      .where(eq(userGlobalBlock.userId, admin.userId))
    expect((await resolveSkillKey(ownerDb, token)).userId).toBe(admin.userId)
  })

  it("el rol es el de hoy: si su dueña pasa a Soporte, la llave ya no deposita", async () => {
    await ownerDb
      .update(adminStaff)
      .set({ role: "support" })
      .where(eq(adminStaff.userId, admin.userId))
    const actor = await resolveSkillKey(ownerDb, token)
    expect(actor.role).toBe("support")
    await expect(
      checkImportDraft(ownerDb, actor, {
        organizationSlug: SLUG,
        kind: "plan_configuracion",
        number: 1,
        payload: setupPlan(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await ownerDb
      .update(adminStaff)
      .set({ role: "admin" })
      .where(eq(adminStaff.userId, admin.userId))
  })
})

describe("depositar", () => {
  it("valida que el archivo sea del tipo y de esa clínica, sin repetir sus datos", async () => {
    const actor = await fakeKeyActor()
    const check = (input: Partial<Parameters<typeof checkImportDraft>[2]>) =>
      checkImportDraft(ownerDb, actor, {
        organizationSlug: SLUG,
        kind: "plan_configuracion",
        number: 1,
        payload: setupPlan(),
        ...input,
      })
    await expect(check({ organizationSlug: "no-existe" })).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { organizationSlug: expect.any(String) },
    })
    await expect(check({ organizationSlug: "sk-sin-cliente" })).rejects.toMatchObject({
      fields: { organizationSlug: "Esa clínica aún no tiene su cliente en la administración" },
    })
    await expect(check({ payload: setupPlan("otra-clinica") })).rejects.toMatchObject({
      fields: { "payload.slug": expect.any(String) },
    })
    await expect(check({ kind: "informe", payload: report(2) })).rejects.toMatchObject({
      fields: { number: expect.any(String) },
    })
    // Un plan de pacientes mal armado dice dónde, nunca el dato.
    const broken = patientsPlan("Clotilde")
    ;(broken.people[0] as { demographics: unknown }).demographics = {
      displayName: "Clotilde",
      extra: "Clotilde 999",
    }
    const error = await check({ kind: "plan_pacientes", payload: broken }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "VALIDATION" })
    expect(JSON.stringify(error)).not.toContain("Clotilde")
    expect(Object.values((error as { fields: Record<string, string> }).fields)).toEqual(
      expect.arrayContaining(["Este dato no es válido"]),
    )
    expect(await check({ kind: "plan_pacientes", payload: patientsPlan() })).toEqual({
      organizationId: ORG,
      clientId,
      kind: "plan_pacientes",
      number: 1,
      summary: { personas: 2, pacientes: 1, omitidas: 0, archivos: 1 },
    })
    // Una sesión (no la llave) no deposita.
    await expect(
      checkImportDraft(ownerDb, admin as SkillActor, {
        organizationSlug: SLUG,
        kind: "informe",
        number: 1,
        payload: report(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("queda lista con su PDF, su auditoría por la llave y sin repetir el número", async () => {
    const actor = await fakeKeyActor()
    const pdf = await registerClientFile(ownerDb, actor, {
      clientId,
      kind: "plan_carga",
      filename: "plan-de-carga-1.pdf",
      objectKey: clientFileKey(clientId, "pdf"),
      contentType: "application/pdf",
      sizeBytes: 100,
      source: "skill",
    })
    const deposited = await depositImportDraft(ownerDb, actor, {
      organizationSlug: SLUG,
      kind: "plan_configuracion",
      number: 1,
      payload: setupPlan(),
      payloadKey: `clients/${clientId}/plan-1.json`,
      pdfFileId: pdf.id,
      summary: { paginas: 2, "no vale": 3 },
    })
    expect(deposited).toMatchObject({ clientId, organizationId: ORG, replacedPayloadKey: null })
    const [row] = await ownerDb
      .select()
      .from(saasImportDraft)
      .where(eq(saasImportDraft.id, deposited.id))
    expect(row).toMatchObject({
      status: "lista",
      uploadedBy: admin.userId,
      viaSkill: true,
      pdfFileId: pdf.id,
    })
    expect(row?.summary).toMatchObject({ paginas: 2, sedes: 1, servicios: 0 })
    expect(row?.summary).not.toHaveProperty("no vale")
    const [audit] = await ownerDb
      .select({ actor: adminAudit.actorUserId, metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(
        and(eq(adminAudit.action, "skill.draft_deposited"), eq(adminAudit.entityId, deposited.id)),
      )
    expect(audit).toMatchObject({
      actor: admin.userId,
      metadata: { via: "skill", keyId, kind: "plan_configuracion", number: 1 },
    })

    await expect(
      depositImportDraft(ownerDb, actor, {
        organizationSlug: SLUG,
        kind: "plan_configuracion",
        number: 1,
        payload: setupPlan(),
        payloadKey: `clients/${clientId}/plan-1b.json`,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_DRAFT_EXISTS", status: 409 })
    await expect(
      depositImportDraft(ownerDb, actor, {
        organizationSlug: SLUG,
        kind: "plan_configuracion",
        number: 2,
        payload: setupPlan(),
        payloadKey: "clients/otro-cliente/plan-2.json",
      }),
    ).rejects.toMatchObject({ fields: { payloadKey: expect.any(String) } })
  })

  it("la llave no aprueba, no devuelve ni lee: eso es de una persona con su sesión", async () => {
    const actor = await fakeKeyActor()
    const [draft] = await listImportDrafts(ownerDb, admin, clientId)
    if (!draft) throw new Error("sin borrador")
    await expect(approveImportDraft(ownerDb, actor, draft.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(returnImportDraft(ownerDb, actor, draft.id, "no")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(listImportDrafts(ownerDb, actor, clientId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      importDraftPayload(ownerDb, actor, { getAttachment: async () => new Uint8Array() }, draft.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(listImportDrafts(ownerDb, support, clientId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})

describe("aprobar, devolver y cargar", () => {
  it("aprobar una vez; devolver con nota; la skill deja otro con el mismo número", async () => {
    const [draft] = await listImportDrafts(ownerDb, admin, clientId)
    if (!draft) throw new Error("sin borrador")
    await expect(approveImportDraft(ownerDb, support, draft.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const approved = await approveImportDraft(ownerDb, admin, draft.id)
    expect(approved).toMatchObject({
      status: "aprobada",
      approvedBy: { userId: admin.userId, name: "Ada Administración" },
    })
    await expect(approveImportDraft(ownerDb, admin, draft.id)).rejects.toMatchObject({
      code: "IMPORT_DRAFT_STATE",
    })

    await expect(returnImportDraft(ownerDb, admin, draft.id, " ")).rejects.toMatchObject({
      fields: { note: expect.any(String) },
    })
    expect(
      await returnImportDraft(ownerDb, admin, draft.id, "Falta la sede de Miraflores"),
    ).toMatchObject({
      status: "devuelta",
      returnedNote: "Falta la sede de Miraflores",
    })
    const [audit] = await ownerDb
      .select({ metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "skill.draft_returned"), eq(adminAudit.entityId, draft.id)))
    expect(JSON.stringify(audit?.metadata)).not.toContain("Miraflores")

    const again = await depositImportDraft(ownerDb, await fakeKeyActor(), {
      organizationSlug: SLUG,
      kind: "plan_configuracion",
      number: 1,
      payload: setupPlan(),
      payloadKey: `clients/${clientId}/plan-1-corregido.json`,
    })
    expect(again).toMatchObject({
      id: draft.id,
      replacedPayloadKey: `clients/${clientId}/plan-1.json`,
    })
    const [row] = await ownerDb
      .select()
      .from(saasImportDraft)
      .where(eq(saasImportDraft.id, draft.id))
    expect(row).toMatchObject({
      status: "lista",
      returnedNote: null,
      approvedBy: null,
      // El JSON anterior espera su borrado hasta que el almacenamiento lo confirme.
      stalePayloadKeys: [`clients/${clientId}/plan-1.json`],
      payloadDeletedAt: null,
    })
  })

  it("el JSON se lee del bucket, se vuelve a validar y deja rastro; usada no vuelve a lista", async () => {
    const [draft] = await listImportDrafts(ownerDb, admin, clientId)
    if (!draft) throw new Error("sin borrador")
    const read: string[] = []
    const storage = {
      async getAttachment(key: string) {
        read.push(key)
        return new TextEncoder().encode(JSON.stringify(setupPlan()))
      },
    }
    const opened = await importDraftPayload(ownerDb, admin, storage, draft.id)
    expect(opened).toMatchObject({
      kind: "plan_configuracion",
      number: 1,
      organizationId: ORG,
      payload: { slug: SLUG },
    })
    expect(read).toEqual([`clients/${clientId}/plan-1-corregido.json`])
    await expect(importDraftPayload(ownerDb, admin, {}, draft.id)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    })
    await expect(
      importDraftPayload(
        ownerDb,
        admin,
        { getAttachment: async () => new TextEncoder().encode("{") },
        draft.id,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_DRAFT_UNREADABLE" })

    const used = await markImportDraftUsed(ownerDb, admin, draft.id)
    expect(used).toMatchObject({ status: "usada", approvedBy: { userId: admin.userId } })
    await expect(returnImportDraft(ownerDb, admin, draft.id, "tarde")).rejects.toMatchObject({
      code: "IMPORT_DRAFT_STATE",
    })
  })
})

/** Un almacenamiento que anota lo que borra y puede fallar con una clave. */
function deletingStorage(failOn: string[] = []) {
  const deleted: string[] = []
  return {
    deleted,
    async deleteAttachment(key: string) {
      if (failOn.includes(key)) throw new Error("el bucket no respondió")
      deleted.push(key)
    },
  }
}

async function draftOf(id: string) {
  const [row] = await ownerDb.select().from(saasImportDraft).where(eq(saasImportDraft.id, id))
  if (!row) throw new Error("sin borrador")
  return row
}

describe("borrar el JSON del borrador", () => {
  it("el de uno usado y el reemplazado se borran del bucket, con constancia sin datos", async () => {
    const [draft] = await listImportDrafts(ownerDb, admin, clientId)
    if (!draft) throw new Error("sin borrador")
    expect(draft.status).toBe("usada")
    const storage = deletingStorage()
    const now = new Date()
    expect(await purgeImportDraftPayloads(ownerDb, storage, now)).toEqual({ deleted: 2, failed: 0 })
    expect(storage.deleted.sort()).toEqual(
      [`clients/${clientId}/plan-1-corregido.json`, `clients/${clientId}/plan-1.json`].sort(),
    )
    expect(await draftOf(draft.id)).toMatchObject({ stalePayloadKeys: [], payloadDeletedAt: now })
    const audits = await ownerDb
      .select({ actor: adminAudit.actorUserId, metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.action, "skill.draft_payload_deleted"),
          eq(adminAudit.entityId, draft.id),
        ),
      )
    expect(
      audits
        .map((audit) => audit.metadata)
        .sort((a, b) => String(a?.reason).localeCompare(String(b?.reason))),
    ).toEqual([
      { clientId, kind: "plan_configuracion", number: 1, reason: "reemplazado", files: 1 },
      { clientId, kind: "plan_configuracion", number: 1, reason: "usada", files: 1 },
    ])
    expect(audits.every((audit) => audit.actor === null)).toBe(true)
    expect(JSON.stringify(audits)).not.toContain(".json")
    // Ya no se abre, y otra pasada no vuelve a borrar nada.
    await expect(
      importDraftPayload(ownerDb, admin, { getAttachment: async () => new Uint8Array() }, draft.id),
    ).rejects.toMatchObject({ code: "IMPORT_DRAFT_PAYLOAD_GONE" })
    expect(await purgeImportDraftPayloads(ownerDb, deletingStorage(), now)).toEqual({
      deleted: 0,
      failed: 0,
    })
    expect((await listImportDrafts(ownerDb, admin, clientId))[0]?.payloadDeletedAt).toEqual(now)
  })

  it("a los 30 días de subido se borra aunque nadie lo haya usado; después la skill puede dejar otro", async () => {
    const actor = await fakeKeyActor()
    const now = new Date()
    const patients = await depositImportDraft(
      ownerDb,
      actor,
      {
        organizationSlug: SLUG,
        kind: "plan_pacientes",
        number: 1,
        payload: patientsPlan(),
        payloadKey: `clients/${clientId}/pacientes-1.json`,
      },
      new Date(now.getTime() - 30 * DAY),
    )
    const recent = await depositImportDraft(
      ownerDb,
      actor,
      {
        organizationSlug: SLUG,
        kind: "informe",
        number: 1,
        payload: report(1),
        payloadKey: `clients/${clientId}/informe-1.json`,
      },
      new Date(now.getTime() - 29 * DAY),
    )
    // El almacenamiento falla una vez: queda para la próxima pasada.
    const failing = deletingStorage([`clients/${clientId}/pacientes-1.json`])
    expect(await purgeImportDraftPayloads(ownerDb, failing, now)).toEqual({ deleted: 0, failed: 1 })
    expect((await draftOf(patients.id)).payloadDeletedAt).toBeNull()

    const storage = deletingStorage()
    expect(await purgeImportDraftPayloads(ownerDb, storage, now)).toEqual({ deleted: 1, failed: 0 })
    expect(storage.deleted).toEqual([`clients/${clientId}/pacientes-1.json`])
    expect(await draftOf(patients.id)).toMatchObject({ status: "lista", payloadDeletedAt: now })
    expect((await draftOf(recent.id)).payloadDeletedAt).toBeNull()
    const [audit] = await ownerDb
      .select({ metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.action, "skill.draft_payload_deleted"),
          eq(adminAudit.entityId, patients.id),
        ),
      )
    expect(audit?.metadata).toEqual({
      clientId,
      kind: "plan_pacientes",
      number: 1,
      reason: "30_dias",
      files: 1,
    })
    expect(JSON.stringify(audit)).not.toContain("Rosa")
    await expect(
      importDraftPayload(
        ownerDb,
        admin,
        { getAttachment: async () => new Uint8Array() },
        patients.id,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_DRAFT_PAYLOAD_GONE" })

    // Sin su JSON no hay qué cargar: la skill deja otro con el mismo número y vuelve a contar.
    const again = await depositImportDraft(
      ownerDb,
      actor,
      {
        organizationSlug: SLUG,
        kind: "plan_pacientes",
        number: 1,
        payload: patientsPlan(),
        payloadKey: `clients/${clientId}/pacientes-1b.json`,
      },
      now,
    )
    expect(again).toMatchObject({ id: patients.id, replacedPayloadKey: null })
    expect(await draftOf(patients.id)).toMatchObject({
      status: "lista",
      payloadKey: `clients/${clientId}/pacientes-1b.json`,
      payloadUploadedAt: now,
      payloadDeletedAt: null,
      stalePayloadKeys: [],
    })
    // El que sigue vigente no se reemplaza.
    await expect(
      depositImportDraft(ownerDb, actor, {
        organizationSlug: SLUG,
        kind: "informe",
        number: 1,
        payload: report(1),
        payloadKey: `clients/${clientId}/informe-1b.json`,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_DRAFT_EXISTS" })
  })

  it("con un borrador, solo toca ese", async () => {
    const now = new Date(Date.now() + 31 * DAY)
    const drafts = await listImportDrafts(ownerDb, admin, clientId)
    const report1 = drafts.find((draft) => draft.kind === "informe")
    if (!report1) throw new Error("sin informe")
    const storage = deletingStorage()
    expect(await purgeImportDraftPayloads(ownerDb, storage, now, { draftId: report1.id })).toEqual({
      deleted: 1,
      failed: 0,
    })
    expect(storage.deleted).toEqual([`clients/${clientId}/informe-1.json`])
    const patients = drafts.find((draft) => draft.kind === "plan_pacientes")
    expect(patients && (await draftOf(patients.id)).payloadDeletedAt).toBeNull()
  })
})

describe("revocar", () => {
  it("revocar deja la llave sin valor; otra vez no cambia nada", async () => {
    const first = await revokeSkillKey(ownerDb, admin, keyId)
    expect((await revokeSkillKey(ownerDb, admin, keyId)).revokedAt.getTime()).toBe(
      first.revokedAt.getTime(),
    )
    await expect(resolveSkillKey(ownerDb, token)).rejects.toMatchObject({
      code: "SKILL_KEY_INVALID",
    })
    expect((await listSkillKeys(ownerDb, admin))[0]).toMatchObject({
      state: "revocada",
      revokedBy: { userId: admin.userId, name: "Ada Administración" },
    })
    await expect(revokeSkillKey(ownerDb, support, keyId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})
