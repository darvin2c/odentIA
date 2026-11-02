import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { professionalDrawnSignature } from "@odentia/db/schema/clinical-forms"
import { expect, it, vi } from "vitest"
import { clinicalFixture, makeSigner } from "./clinical-test-fixture.js"
import { DocumentKit } from "./document-kit.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import { createMedicalLeave, getMedicalLeavePrint } from "./medical-leaves.js"
import {
  currentDrawnSignature,
  drawnSignatureAt,
  getOwnProfessionalProfile,
  getProfessionalProfile,
  setProfessionalProfile,
} from "./professional-profiles.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const FIRST = [[[10, 10], [200, 120], [400, 60]]]
const SECOND = [[[50, 500], [900, 500]]]

const profileOf = (strokes: unknown) => ({
  professionalTitle: "Cirujano dentista",
  registrationBody: "COP",
  registrationNumber: "12345",
  signatureStrokes: strokes,
})

it("cada papel lleva la firma que regía al emitirse, aunque después la cambie o la quite", async () => {
  const f = await clinicalFixture()
  const [orgId, userId] = f.args
  const emit = (startsOn: string) => f.run((tx) => createMedicalLeave(tx, ...f.args, { startsOn, days: 1 }))
  const strokesOf = async (id: string) =>
    (await f.run((tx) => getMedicalLeavePrint(tx, orgId, f.patient.id, id))).signerStrokes

  // Sin firma guardada: el papel queda con la línea para firmar a mano.
  const before = await emit("2026-10-01")
  expect(await strokesOf(before.id)).toBeNull()

  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(FIRST)))
  const withFirst = await emit("2026-10-02")
  expect(await strokesOf(withFirst.id)).toEqual(FIRST)

  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(SECOND)))
  const withSecond = await emit("2026-10-03")
  expect(await strokesOf(withSecond.id)).toEqual(SECOND)
  // Lo emitido antes no cambió.
  expect(await strokesOf(withFirst.id)).toEqual(FIRST)
  expect(await strokesOf(before.id)).toBeNull()

  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(null)))
  const removed = await emit("2026-10-04")
  expect(await strokesOf(removed.id)).toBeNull()
  expect(await f.run((tx) => currentDrawnSignature(tx, orgId, userId))).toBeNull()
  expect(await strokesOf(withSecond.id)).toEqual(SECOND)

  // Sin el dato, guardar el perfil no toca la firma.
  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(SECOND)))
  await f.run((tx) =>
    setProfessionalProfile(tx, orgId, userId, userId, {
      professionalTitle: "Cirujano dentista",
      registrationBody: "COP",
      registrationNumber: "12345",
    }),
  )
  expect(await f.run((tx) => currentDrawnSignature(tx, orgId, userId))).toEqual(SECOND)
})

it("el PDF dibuja la firma guardada y siempre dice que se firmó electrónicamente", async () => {
  const f = await clinicalFixture()
  const [orgId, userId] = f.args
  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(FIRST)))
  const leave = await f.run((tx) => createMedicalLeave(tx, ...f.args, { startsOn: "2026-10-05", days: 1 }))
  const signedBlock = vi.spyOn(DocumentKit.prototype, "signedBlock")
  const drawStrokes = vi.spyOn(DocumentKit.prototype, "drawStrokes")
  const pdf = await f.run((tx) =>
    renderHealthDocumentPdf(tx, orgId, f.patient.id, "medical_leave", leave.id),
  )
  expect(Buffer.from(pdf.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-")
  expect(signedBlock.mock.calls[0]?.[0]).toMatchObject({ strokes: FIRST })
  expect(drawStrokes).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
})

it("la firma es de la propia persona: nadie la guarda por otra ni la recibe en su perfil", async () => {
  const f = await clinicalFixture()
  const [orgId, userId] = f.args
  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(FIRST)))

  const owner = randomUUID()
  await ownerDb.insert(user).values({ id: owner, name: "Administración", email: `${owner}@example.test` })
  await makeSigner(orgId, owner)
  await expect(
    f.run((tx) => setProfessionalProfile(tx, orgId, owner, userId, profileOf(SECOND))),
  ).rejects.toMatchObject({ code: "SIGNATURE_OWN_ONLY", status: 403 })
  await expect(
    f.run((tx) => setProfessionalProfile(tx, orgId, owner, userId, profileOf(null))),
  ).rejects.toMatchObject({ code: "SIGNATURE_OWN_ONLY" })
  // Administración sí puede corregir los demás datos, y eso no la toca.
  await f.run((tx) =>
    setProfessionalProfile(tx, orgId, owner, userId, {
      professionalTitle: "Cirujano dentista",
      registrationBody: "COP",
      registrationNumber: "99999",
    }),
  )
  expect(await f.run((tx) => currentDrawnSignature(tx, orgId, userId))).toEqual(FIRST)

  expect(await f.run((tx) => getProfessionalProfile(tx, orgId, userId))).not.toHaveProperty("signatureStrokes")
  expect((await f.run((tx) => getOwnProfessionalProfile(tx, orgId, userId))).signatureStrokes).toEqual(FIRST)
})

it("una firma inválida se rechaza junto a su campo y no queda nada guardado", async () => {
  const f = await clinicalFixture()
  const [orgId, userId] = f.args
  for (const bad of [[], [[[10, 10]]], [[[10, 10], [2000, 10]]], "un texto"]) {
    await expect(
      f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(bad))),
    ).rejects.toMatchObject({ fields: { signatureStrokes: expect.any(String) } })
  }
  expect(await f.run((tx) => currentDrawnSignature(tx, orgId, userId))).toBeNull()
})

it("no se reescribe: la aplicación solo agrega firmas, y cada clínica ve las suyas", async () => {
  const f = await clinicalFixture()
  const [orgId, userId] = f.args
  await f.run((tx) => setProfessionalProfile(tx, orgId, userId, userId, profileOf(FIRST)))
  await expect(
    f.run((tx) => tx.update(professionalDrawnSignature).set({ strokes: SECOND })),
  ).rejects.toThrow()
  await expect(f.run((tx) => tx.delete(professionalDrawnSignature))).rejects.toThrow()
  expect(await f.run((tx) => drawnSignatureAt(tx, orgId, userId, new Date()))).toEqual(FIRST)
  // Bajo el contexto de otra clínica, la fila no se ve aunque se pida sin filtro.
  const seen = await withOrgContext(appDb, "org_b", (tx) => tx.select().from(professionalDrawnSignature))
  expect(seen).toEqual([])
})
