/**
 * Configuración › Protección de datos (ADR 0080): el registro se arma solo con
 * lo que la clínica usa. Un canal conectado suma a su proveedor; los pedidos
 * del año se cuentan; el PDF sale con lo mismo.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getDataProtectionView, renderDataProtectionPdf } from "./data-protection.js"
import { loadDocumentClinic } from "./document-clinic.js"
import { createDataRequest } from "./data-requests.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { setTestPatientIdentity } from "./test-patient.js"

setupTestDb()

it("lista lo que la clínica usa, lo que odentIA usa siempre y los pedidos del año, y lo mismo sale en el PDF", async () => {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  await setTestPatientIdentity(ownerDb, f.patient.id, { birthDate: "1990-05-14" })

  const before = await run((tx) => getDataProtectionView(tx, "org_a"))
  expect(before.processors.always.map((p) => p.id)).toEqual(
    expect.arrayContaining(["servidor", "cloudflare", "correo", "geoapify"]),
  )
  expect(before.activities.map((a) => a.id)).toEqual(expect.arrayContaining(["atender", "citas", "cobrar", "novedades"]))

  await ownerDb.insert(channelConnection).values({
    organizationId: "org_a",
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WhatsApp de la clínica",
    externalId: `wa-${randomUUID()}`,
    configEncrypted: "prueba",
    webhookSecret: "prueba",
    status: "active",
  })
  await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, f.patient.id, {
      kind: "copia",
      requesterContactId: f.patient.personId,
      channel: "clinica",
    }),
  )
  const view = await run((tx) => getDataProtectionView(tx, "org_a"))
  const meta = view.processors.inUse.find((p) => p.id === "meta")
  expect(meta).toMatchObject({ name: "WhatsApp (Meta)", country: "Estados Unidos" })
  expect(meta?.detail).toMatch(/^conectado el /)
  expect(view.processors.notUsed).not.toContain("WhatsApp")
  expect(view.processors.notUsed).toContain("Telegram")
  // Con un canal conectado, conversar con ella es una actividad más.
  expect(view.activities.map((a) => a.id)).toContain("conversar")
  expect(view.requests.received).toBe(before.requests.received + 1)
  expect(view.requests.pending).toBe(before.requests.pending + 1)

  const pdf = await renderDataProtectionPdf(view, await run((tx) => loadDocumentClinic(tx, "org_a")))
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
})
