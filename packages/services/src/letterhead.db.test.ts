/**
 * La hoja membretada (ADR 0180) en la base: cada cambio es una versión, cada papel usa
 * la vigente cuando se emitió, «Deshacer» vuelve a ponerla y otra clínica no la ve.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, clinicLetterhead } from "@odentia/db/schema/org"
import { and, eq, like } from "drizzle-orm"
import { expect, it } from "vitest"
import { loadDocumentLetterhead } from "./document-clinic.js"
import {
  adjustLetterhead,
  getCurrentLetterhead,
  getLetterheadAt,
  type LetterheadInput,
  removeLetterhead,
  restoreLetterhead,
  saveLetterhead,
} from "./letterhead.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const sheet = (name: string): LetterheadInput => ({
  pdfKey: `clinics/x/hoja-membretada/${name}.pdf`,
  topBandUrl: `https://example.com/${name}-arriba.png`,
  bottomBandUrl: `https://example.com/${name}-abajo.png`,
  thumbnailUrl: `https://example.com/${name}-mini.png`,
  pageWidthPt: 595.28,
  pageHeightPt: 841.89,
  topMm: 50,
  bottomMm: 41,
  leftMm: 19,
  rightMm: 19,
  hasContact: false,
  fileName: `${name}.pdf`,
})

async function clinicWithOwner() {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  const userId = `user_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  await ownerDb
    .insert(user)
    .values({ id: userId, name: "Dueña", email: `${userId}@hoja.test`, emailVerified: true })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, userId, run }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 25))

it("cada cambio es una versión y cada momento tiene la suya", async () => {
  const { orgId, userId, run } = await clinicWithOwner()
  expect(await run((tx) => getCurrentLetterhead(tx, orgId))).toBeNull()
  const before = new Date()
  await pause()
  const first = await run((tx) => saveLetterhead(tx, orgId, userId, sheet("primera")))
  await pause()
  const issuedWithFirst = new Date()
  await pause()
  const adjusted = await run((tx) =>
    adjustLetterhead(tx, orgId, userId, {
      topMm: 55,
      bottomMm: 41,
      leftMm: 19,
      rightMm: 19,
      hasContact: true,
    }),
  )
  expect(adjusted.id).not.toBe(first.id)
  expect(adjusted.pdfKey).toBe(first.pdfKey)
  expect(adjusted.topMm).toBe(55)
  expect(adjusted.hasContact).toBe(true)
  await pause()
  const issuedWithAdjusted = new Date()
  await pause()
  const { removedId } = await run((tx) => removeLetterhead(tx, orgId, userId))
  expect(removedId).toBe(adjusted.id)
  await pause()
  const issuedWithout = new Date()

  expect(await run((tx) => getCurrentLetterhead(tx, orgId))).toBeNull()
  expect(await run((tx) => getLetterheadAt(tx, orgId, before))).toBeNull()
  expect((await run((tx) => getLetterheadAt(tx, orgId, issuedWithFirst)))?.id).toBe(first.id)
  expect((await run((tx) => getLetterheadAt(tx, orgId, issuedWithAdjusted)))?.id).toBe(adjusted.id)
  expect(await run((tx) => getLetterheadAt(tx, orgId, issuedWithout))).toBeNull()

  // «Deshacer»: vuelve la misma hoja como versión nueva; lo emitido sin hoja sigue sin ella.
  const back = await run((tx) => restoreLetterhead(tx, orgId, userId, adjusted.id))
  expect(back.id).not.toBe(adjusted.id)
  expect(back.pdfKey).toBe(adjusted.pdfKey)
  expect((await run((tx) => getCurrentLetterhead(tx, orgId)))?.id).toBe(back.id)
  expect(await run((tx) => getLetterheadAt(tx, orgId, issuedWithout))).toBeNull()

  // Queda en Actividad del equipo: puesta, ajustada, quitada y puesta otra vez.
  const actions = await ownerDb
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        like(auditEvent.action, "org_profile.letterhead_%"),
      ),
    )
  expect(actions.map((row) => row.action).sort()).toEqual([
    "org_profile.letterhead_adjusted",
    "org_profile.letterhead_removed",
    "org_profile.letterhead_set",
    "org_profile.letterhead_set",
  ])
})

it("una versión no se borra ni se cambia, y quitada no vuelve", async () => {
  const { orgId, userId, run } = await clinicWithOwner()
  const saved = await run((tx) => saveLetterhead(tx, orgId, userId, sheet("fija")))
  await expect(
    run((tx) =>
      tx.update(clinicLetterhead).set({ topMm: 10 }).where(eq(clinicLetterhead.id, saved.id)),
    ),
  ).rejects.toThrow()
  await expect(
    run((tx) => tx.delete(clinicLetterhead).where(eq(clinicLetterhead.id, saved.id))),
  ).rejects.toThrow()
  await run((tx) => removeLetterhead(tx, orgId, userId))
  await expect(
    run((tx) =>
      tx
        .update(clinicLetterhead)
        .set({ removedAt: null, removedBy: null })
        .where(eq(clinicLetterhead.id, saved.id)),
    ),
  ).rejects.toThrow()
})

it("otra clínica no ve ni pone la hoja de esta", async () => {
  const one = await clinicWithOwner()
  const other = await clinicWithOwner()
  const saved = await one.run((tx) => saveLetterhead(tx, one.orgId, one.userId, sheet("propia")))
  expect(await other.run((tx) => getCurrentLetterhead(tx, one.orgId))).toBeNull()
  await expect(
    other.run((tx) => restoreLetterhead(tx, other.orgId, other.userId, saved.id)),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  })
})

it("la hoja que se firma en pantalla trae sus franjas y no repite lo que la hoja ya dice", async () => {
  const { orgId, userId, run } = await clinicWithOwner()
  await run((tx) => saveLetterhead(tx, orgId, userId, { ...sheet("pantalla"), hasContact: true }))
  const letterhead = await run((tx) => loadDocumentLetterhead(tx, orgId))
  expect(letterhead.sheet).toEqual({
    topBand: "https://example.com/pantalla-arriba.png",
    bottomBand: "https://example.com/pantalla-abajo.png",
    hasContact: true,
  })
  expect(letterhead.logo).toBeNull()
  expect(letterhead.address).toBeNull()
  expect(letterhead.phone).toBeNull()
})
