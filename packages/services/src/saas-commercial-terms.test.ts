import { withOrgContext } from "@odentia/db"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasCommercialTerms } from "@odentia/db/schema/saas-billing"
import { desc, eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  currentSaasTerms,
  getSaasTermsView,
  listSaasTermsVersions,
  loadSaasTermsTimeline,
  SAAS_TERMS_INITIAL,
  saasTermsAt,
  setSaasTerms,
} from "./saas-commercial-terms.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Condiciones comerciales (issue 167, ADR 0074): versiones que nunca se
 * reescriben, cada una rige desde que se guarda, el historial dice en palabras
 * qué cambió y solo la administración las cambia.
 */
setupTestDb()

const ADMIN = { userId: "terms-admin", role: "admin" as const }
const SUPPORT = { userId: "terms-support", role: "support" as const }

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: ADMIN.userId, name: "Ana Pruebas", email: "ana@terms.test" },
    { id: SUPPORT.userId, name: "Luis Prado", email: "luis@terms.test" },
  ])
})

it("parte de los valores que estaban en el código, en una versión que no se reescribe y que la app solo lee", async () => {
  expect(await currentSaasTerms(ownerDb)).toEqual(SAAS_TERMS_INITIAL)
  const view = await getSaasTermsView(ownerDb)
  expect(view.version.initial).toBe(true)
  expect(view.groups.map((group) => group.title)).toEqual([
    "Qué se cobra",
    "Revisión de cobros",
    "Pagos",
    "Prueba y avisos del presupuesto",
    "Invitaciones y vendedores",
    "Avisos antes de que termine algo",
  ])
  // Las frases llevan la cifra resaltada, con su unidad.
  expect(view.groups[0]!.sentences[0]).toEqual([
    { text: "Una conversación por persona cada " },
    { text: "24 horas", strong: true },
    { text: ", aunque escriba diez mensajes o cambie de canal." },
  ])
  const [initial, ...rest] = await listSaasTermsVersions(ownerDb)
  expect(rest).toEqual([])
  expect(initial).toMatchObject({ initial: true, changes: [] })
  expect(initial!.summary).toContainEqual({ key: "reviewAnswerDays", name: "Responder una revisión", value: "2 días hábiles" })

  // Nada se reescribe ni se borra, ni siquiera con owner.
  await expect(ownerDb.execute(sql`update admin.saas_commercial_terms set grace_days = 9`)).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(ownerDb.execute(sql`delete from admin.saas_commercial_terms`)).rejects.toMatchObject({ cause: { code: "23514" } })
  // La app las lee para contar dentro de la clínica, pero no las escribe.
  expect((await withOrgContext(appDb, "org_a", (tx) => currentSaasTerms(tx))).graceDays).toBe(7)
  await expect(
    withOrgContext(appDb, "org_a", (tx) => tx.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, effectiveFrom: new Date() })),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})

it("un cambio es una versión nueva que rige desde que se guarda, con su historial en palabras y su auditoría", async () => {
  const before = await getSaasTermsView(ownerDb)
  // Un milisegundo antes de guardar: la versión nueva rige desde el instante en que se guarda.
  const justBefore = new Date(Date.now() - 1)
  const after = await ownerDb.transaction((tx) =>
    setSaasTerms(tx, ADMIN, {
      values: { graceDays: 10, reviewAutoPercent: 15 },
      basedOn: before.version.id,
      reason: "Las clínicas piden más tiempo para el comprobante",
    }),
  )
  expect(after.values).toMatchObject({ graceDays: 10, reviewAutoPercent: 15, paymentDays: 7 })
  expect(after.version).toMatchObject({ initial: false, createdByName: "Ana Pruebas", reason: "Las clínicas piden más tiempo para el comprobante" })
  expect(after.groups.find((group) => group.key === "pagos")!.sentences[1]).toContainEqual({ text: "10 días", strong: true })

  // Lo que empezó antes conserva la regla que tenía.
  expect((await saasTermsAt(ownerDb, justBefore)).graceDays).toBe(7)
  expect((await currentSaasTerms(ownerDb)).graceDays).toBe(10)
  const timeline = await loadSaasTermsTimeline(ownerDb)
  expect(timeline.at(justBefore).reviewAutoPercent).toBe(10)
  expect(timeline.at(new Date()).reviewAutoPercent).toBe(15)

  const [latest] = await listSaasTermsVersions(ownerDb)
  expect(latest).toMatchObject({
    createdByName: "Ana Pruebas",
    reason: "Las clínicas piden más tiempo para el comprobante",
    changes: [
      { key: "reviewAutoPercent", name: "Spam que se devuelve al instante", before: "10 %", after: "15 %" },
      { key: "graceDays", name: "Días de gracia", before: "7 días", after: "10 días" },
    ],
  })
  const [audit] = await ownerDb.select().from(adminAudit).where(eq(adminAudit.action, "saas.terms_changed")).orderBy(desc(adminAudit.createdAt)).limit(1)
  expect(audit).toMatchObject({ actorUserId: ADMIN.userId, actorRole: "admin" })
  expect(audit!.metadata).toMatchObject({
    changes: [
      { key: "reviewAutoPercent", before: 10, after: 15 },
      { key: "graceDays", before: 7, after: 10 },
    ],
  })

  // Guardar sin cambios no crea otra versión.
  const count = (await listSaasTermsVersions(ownerDb)).length
  await ownerDb.transaction((tx) => setSaasTerms(tx, ADMIN, { values: { graceDays: 10 }, basedOn: after.version.id }))
  expect(await listSaasTermsVersions(ownerDb)).toHaveLength(count)

  // Quien editaba la versión anterior no pisa el cambio: se le avisa.
  await expect(
    ownerDb.transaction((tx) => setSaasTerms(tx, ADMIN, { values: { graceDays: 5 }, basedOn: before.version.id })),
  ).rejects.toMatchObject({ code: "TERMS_CHANGED", status: 409 })
})

it("solo la administración las cambia, dentro de sus límites", async () => {
  const { version } = await getSaasTermsView(ownerDb)
  const save = (values: Parameters<typeof setSaasTerms>[2]["values"], actor: typeof ADMIN | typeof SUPPORT = ADMIN) =>
    ownerDb.transaction((tx) => setSaasTerms(tx, actor, { values, basedOn: version.id }))
  await expect(save({ graceDays: 9 }, SUPPORT)).rejects.toMatchObject({ code: "FORBIDDEN" })
  await expect(save({ graceDays: 0 })).rejects.toMatchObject({ code: "VALIDATION", message: "Días de gracia: escribe un número entero entre 1 y 30." })
  await expect(save({ reviewAutoPercent: 2.5 })).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(save({ warnPercent: 92 })).rejects.toMatchObject({
    code: "VALIDATION",
    message: "El aviso va antes que la alarma: escribe menos de 90 %.",
  })
  await expect(save({ nada: 3 } as never)).rejects.toMatchObject({ code: "VALIDATION" })
  // La base pone los mismos límites aunque alguien se salte el servicio.
  await expect(
    ownerDb.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, warnPercent: 95, effectiveFrom: new Date(Date.now() + 60_000) }),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
})
