import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  addClinicalNote,
  addOdontogramEntries,
  createOdontogramAssessment,
  getOdontogram,
  getPatientHealth,
  listAnamnesisVersions,
  listClinicalNotes,
  listOdontogramAssessments,
  reviewLegacyEntry,
  savePatientHealth,
  voidOdontogramEntry,
} from "./clinical.js"
import { createContact, getContact, updateContact } from "./contacts.js"
import {
  createPatient,
  findPatientDuplicates,
  getPatient,
  listPatients,
  listPatientsByContact,
  nextPatientNumber,
  removePatientContact,
  setPatientContact,
  updatePatient,
} from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-tests"

async function seedUserAndCie(): Promise<void> {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Tests', 'tests@example.com')
        on conflict ("id") do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "cie10_code" ("code", "description") values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')
        on conflict ("code") do nothing`,
  )
}

it("pagina por fecha sin perder microsegundos ni duplicar empates", async () => {
  await seedUserAndCie()
  const patients = []
  for (const suffix of ["A", "B", "C"]) {
    const row = await withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, { displayName: `Cursor preciso ${suffix}` }),
    )
    patients.push(row)
    const timestamp = suffix === "A" ? "2026-01-01T00:00:00.123001Z" : "2026-01-01T00:00:00.123002Z"
    await ownerDb.execute(
      sql`update patient set created_at = ${timestamp}::timestamptz where id = ${row.id}`,
    )
  }
  const ascending = [patients[0]!.id, ...[patients[1]!.id, patients[2]!.id].sort()]
  for (const sort of ["created", "-created"]) {
    const ids: string[] = []
    let cursor: string | undefined
    for (let index = 0; index < 3; index++) {
      const page = await withOrgContext(appDb, "org_a", (tx) =>
        listPatients(tx, "org_a", { q: "Cursor preciso", sort, limit: 1, cursor }),
      )
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
    }
    expect(cursor).toBeUndefined()
    expect(ids).toEqual(sort === "created" ? ascending : [...ascending].reverse())
  }
})

it("crear paciente directo y vinculado; segundo self del mismo contacto da 409", async () => {
  await seedUserAndCie()
  const direct = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "María Pérez",
      docType: "DNI",
      docNumber: "12345678",
    }),
  )
  expect(direct.patientNumber).toBeGreaterThan(0)
  // Alta interna rápida: sin nacimiento conocido ni contacto asociado.
  expect(direct.birthDate).toBeNull()
  const directDetail = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", direct.id),
  )
  expect(directDetail.patient.displayName).toBe("María Pérez")
  // Todo paciente es una persona: el alta sin contacto crea la suya.
  expect(directDetail.contacts).toEqual([
    expect.objectContaining({ relationship: "self", displayName: "María Pérez", isPreferred: true }),
  ])
  expect(directDetail.registration).toMatchObject({ entryPoint: "platform", respondent: "staff" })

  const contact = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Juan Ríos" }),
  )
  const linked = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Juan Ríos",
      contacts: [{ contactId: contact.id, relationship: "self", isPreferred: true }],
    }),
  )
  const byContact = await withOrgContext(appDb, "org_a", (tx) =>
    listPatientsByContact(tx, "org_a", contact.id),
  )
  expect(byContact).toEqual([
    expect.objectContaining({
      id: linked.id,
      displayName: "Juan Ríos",
      relationship: "self",
      isPreferred: true,
    }),
  ])

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, {
        displayName: "Juan Duplicado",
        contacts: [{ contactId: contact.id, relationship: "self", isPreferred: false }],
      }),
    ),
  ).rejects.toMatchObject({ status: 409 })
})

it("María es self de su ficha y guardian de Pedro; el teléfono compartido no bloquea", async () => {
  const maria = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "María Madre" }),
  )
  const fichaMaria = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "María Madre",
      phone: "+51999111222",
      contacts: [{ contactId: maria.id, relationship: "self", isPreferred: true }],
    }),
  )
  const pedro = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Pedro Hijo",
      birthDate: "2020-05-06",
      phone: "+51999111222",
      contacts: [
        { contactId: maria.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true },
      ],
    }),
  )
  // El teléfono compartido no modificó a María ni bloqueó a Pedro.
  const detalleMaria = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", fichaMaria.id),
  )
  expect(detalleMaria.patient.phone).toBe("+51999111222")
  const detallePedro = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", pedro.id),
  )
  expect(detallePedro.contacts).toHaveLength(2)
  expect(detallePedro.contacts).toContainEqual(
    expect.objectContaining({ relationship: "self", displayName: "Pedro Hijo", isPreferred: false }),
  )
  expect(detallePedro.contacts.filter((link) => link.relationship !== "self")).toEqual([
    expect.objectContaining({
      contactId: maria.id,
      displayName: "María Madre",
      relationship: "guardian",
      relationshipDetail: "Madre",
      isPreferred: true,
    }),
  ])
  const vinculadas = await withOrgContext(appDb, "org_a", (tx) =>
    listPatientsByContact(tx, "org_a", maria.id),
  )
  expect(vinculadas).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: fichaMaria.id, relationship: "self" }),
      expect.objectContaining({ id: pedro.id, relationship: "guardian" }),
    ]),
  )
  expect(vinculadas).toHaveLength(2)
})

it("eliminar la relación guardian conserva personas e historial", async () => {
  const tutor = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Tutor Conservado" }),
  )
  const hijo = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Hijo Conservado",
      contacts: [{ contactId: tutor.id, relationship: "guardian", isPreferred: true }],
    }),
  )
  const nota = await withOrgContext(appDb, "org_a", (tx) =>
    addClinicalNote(tx, "org_a", ACTOR, hijo.id, { note: "Control conservado" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    removePatientContact(tx, "org_a", ACTOR, hijo.id, tutor.id),
  )
  const detalle = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", hijo.id),
  )
  // Queda solo su propia persona, que no se puede desvincular.
  expect(detalle.contacts).toEqual([expect.objectContaining({ relationship: "self" })])
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      removePatientContact(tx, "org_a", ACTOR, hijo.id, detalle.contacts[0]?.contactId ?? ""),
    ),
  ).rejects.toMatchObject({ code: "PATIENT_PERSON_REQUIRED", status: 409 })
  // Ni el paciente ni el contacto se borran con la relación.
  expect(detalle.patient.isActive).toBe(true)
  const contactoVivo = await withOrgContext(appDb, "org_a", (tx) =>
    getContact(tx, "org_a", tutor.id),
  )
  expect(contactoVivo.contact.id).toBe(tutor.id)
  const notas = await withOrgContext(appDb, "org_a", (tx) =>
    listClinicalNotes(tx, "org_a", hijo.id, {}),
  )
  expect(notas.items.map((n) => n.id)).toContain(nota.id)
})

it("el preferente conserva a lo sumo uno aunque se marque en concurrencia", async () => {
  const c1 = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Preferente Uno" }),
  )
  const c2 = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Preferente Dos" }),
  )
  const hijo = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Hijo Preferente",
      contacts: [{ contactId: c1.id, relationship: "guardian", isPreferred: true }],
    }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", ACTOR, hijo.id, {
      contactId: c2.id,
      relationship: "family",
      isPreferred: false,
    }),
  )
  const intentos = await Promise.allSettled([
    withOrgContext(appDb, "org_a", (tx) =>
      setPatientContact(tx, "org_a", ACTOR, hijo.id, {
        contactId: c1.id,
        relationship: "guardian",
        isPreferred: true,
      }),
    ),
    withOrgContext(appDb, "org_a", (tx) =>
      setPatientContact(tx, "org_a", ACTOR, hijo.id, {
        contactId: c2.id,
        relationship: "family",
        isPreferred: true,
      }),
    ),
  ])
  expect(intentos.some((r) => r.status === "fulfilled")).toBe(true)
  const detalle = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", hijo.id),
  )
  expect(detalle.contacts.filter((c) => c.isPreferred)).toHaveLength(1)
})

it("un contacto de otra organización jamás se relaciona", async () => {
  const ajeno = await withOrgContext(appDb, "org_b", (tx) =>
    createContact(tx, "org_b", { displayName: "Contacto Ajeno" }),
  )
  const propio = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Paciente Propio" }),
  )
  let estado: number | null = null
  try {
    await withOrgContext(appDb, "org_a", (tx) =>
      setPatientContact(tx, "org_a", ACTOR, propio.id, {
        contactId: ajeno.id,
        relationship: "family",
        isPreferred: false,
      }),
    )
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      const status = error.status
      estado = typeof status === "number" ? status : null
    }
  }
  await expect(
    withOrgContext(appDb, "org_a", (tx) => listPatientsByContact(tx, "org_a", ajeno.id)),
  ).rejects.toMatchObject({ status: 404 })
})

it("duplicados: documento exacto y nombre+nacimiento sugieren sin bloquear a la familia", async () => {
  const base = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Rosa Duplicada",
      birthDate: "1990-02-03",
      docType: "DNI",
      docNumber: "12121212",
      phone: "+51999888777",
    }),
  )
  const porDocumento = await withOrgContext(appDb, "org_a", (tx) =>
    findPatientDuplicates(tx, "org_a", { docType: "DNI", docNumber: "12121212" }),
  )
  expect(porDocumento).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: base.id })]),
  )
  expect(porDocumento.length).toBeLessThanOrEqual(10)
  const porNombre = await withOrgContext(appDb, "org_a", (tx) =>
    findPatientDuplicates(tx, "org_a", {
      displayName: "  rosa   DUPLICADA ",
      birthDate: "1990-02-03",
    }),
  )
  expect(porNombre).toEqual(expect.arrayContaining([expect.objectContaining({ id: base.id })]))
  // Coincidencia débil (mismo teléfono de un familiar): sugiere pero no bloquea.
  const porTelefono = await withOrgContext(appDb, "org_a", (tx) =>
    findPatientDuplicates(tx, "org_a", { phone: "+51999888777" }),
  )
  expect(porTelefono).toEqual(expect.arrayContaining([expect.objectContaining({ id: base.id })]))
  const familiar = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Hija de Rosa",
      phone: "+51999888777",
    }),
  )
  expect(familiar.id).not.toBe(base.id)
})

it("documento duplicado da 409 y el correlativo es por org", async () => {
  const a1 = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Doc A",
      docType: "DNI",
      docNumber: "87654321",
    }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, {
        displayName: "Doc B",
        docType: "DNI",
        docNumber: "87654321",
      }),
    ),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", status: 409 })
  // Misma numeración independiente por org.
  const b1 = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", ACTOR, { displayName: "Org B" }),
  )
  expect(b1.patientNumber).toBe(1)
  expect(a1.patientNumber).toBeGreaterThan(1)
  const n = await withOrgContext(appDb, "org_b", (tx) => nextPatientNumber(tx, "org_b"))
  expect(n).toBe(b1.patientNumber + 1)
})

it("salud guarda el agregado con revisión y versiona la entrevista solo si cambia", async () => {
  await seedUserAndCie()
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Ana V" }),
  )
  const base = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
    allergies: [{ substance: "Penicilina", severity: "severa" as const }],
    conditions: [{ name: "Asma", status: "activa" as const }],
    medications: [{ name: "Salbutamol", frequency: "según necesidad" }],
    anamnesis: { expectedVersion: 0, answers: { antecedentesFamiliares: "Ninguno" } },
  }
  const v1 = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, base),
  )
  expect(v1.revision).toBe(1)
  expect(v1.reviewStatus).toEqual({
    allergies: "recorded",
    conditions: "recorded",
    medications: "recorded",
  })
  expect(v1.latestAnamnesis?.version).toBe(1)
  // Reenvío idéntico con la misma revisión: 409 sin sobrescribir, valores locales intactos.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => savePatientHealth(tx, "org_a", ACTOR, p.id, base)),
  ).rejects.toMatchObject({ code: "STALE_HEALTH_REVISION", status: 409 })
  const kept = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", p.id))
  expect(kept.revision).toBe(1)
  expect(kept.allergies).toHaveLength(1)
  const sameInterview = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, {
      expectedRevision: 1,
      reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
      allergies: [
        { id: v1.allergies[0]!.id, substance: "Penicilina", severity: "severa" as const },
      ],
      conditions: [{ id: v1.conditions[0]!.id, name: "Asma", status: "activa" as const }],
      medications: [
        { id: v1.medications[0]!.id, name: "Salbutamol", frequency: "según necesidad" },
      ],
    }),
  )
  expect(sameInterview.revision).toBe(2)
  expect(sameInterview.latestAnamnesis?.version).toBe(1)
  const history = await withOrgContext(appDb, "org_a", (tx) =>
    listAnamnesisVersions(tx, "org_a", p.id),
  )
  expect(history).toHaveLength(1)
  expect(history[0]).not.toHaveProperty("answers")
})

it("salud revierte todo si una fila es inválida y exige colecciones completas", async () => {
  await seedUserAndCie()
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Salud Atómica" }),
  )
  const valid = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Látex", severity: "leve" as const }],
    conditions: [],
    medications: [],
  }
  const saved = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, valid),
  )
  expect(saved.revision).toBe(1)
  // Segunda fila inválida: no guarda ninguna (atomicidad).
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientHealth(tx, "org_a", ACTOR, p.id, {
        expectedRevision: 1,
        reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
        allergies: [
          { id: saved.allergies[0]!.id, substance: "Látex", severity: "leve" as const },
          { substance: "", severity: "leve" as const },
        ],
        conditions: [],
        medications: [],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const kept = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", p.id))
  expect(kept.revision).toBe(1)
  expect(kept.allergies).toHaveLength(1)
  // Omitir un ID persistido es 400, no borrado silencioso.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientHealth(tx, "org_a", ACTOR, p.id, {
        expectedRevision: 1,
        reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
        allergies: [],
        conditions: [],
        medications: [],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  // Ausencia explícita con filas activas es 400; sin filas, 200.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientHealth(tx, "org_a", ACTOR, p.id, {
        expectedRevision: 1,
        reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
        allergies: [{ id: saved.allergies[0]!.id, substance: "Látex", severity: "leve" as const }],
        conditions: [],
        medications: [],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const denied = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, {
      expectedRevision: 1,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      allergies: [
        {
          id: saved.allergies[0]!.id,
          substance: "Látex",
          severity: "leve" as const,
          isActive: false,
        },
      ],
      conditions: [],
      medications: [],
    }),
  )
  expect(denied.revision).toBe(2)
  expect(denied.reviewStatus.allergies).toBe("none")
})

it("odontograma: add + void; el estado deriva sin anuladas y el original se preserva", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Odonto O" }),
  )
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    }),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe("recorded")
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      voidOdontogramEntry(tx, "org_a", ACTOR, rows[0]!.id, p.id, ""),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const voided = await withOrgContext(appDb, "org_a", (tx) =>
    voidOdontogramEntry(tx, "org_a", ACTOR, rows[0]!.id, p.id, "Error de registro"),
  )
  expect(voided.status).toBe("voided")
  expect(voided.voidReason).toBe("Error de registro")
  expect(voided.voidedAt).not.toBeNull()
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id))
  expect(state.teeth).toEqual({})
  expect(state.history).toHaveLength(1)
  expect(state.history[0]!.status).toBe("voided")
  expect(state.history[0]!.condition).toBe("caries")
  expect(state.history[0]!.surface).toBe("occlusal")
})

it("odontograma: coexisten varias condiciones en la misma pieza", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Coexiste C" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "fracture",
      details: {
        drawing: [
          [
            [0, 0],
            [10, 10],
            [20, 20],
          ],
          [
            [30, 30],
            [40, 40],
            [50, 50],
          ],
          [
            [60, 60],
            [70, 70],
            [80, 80],
          ],
        ],
      },
    }),
  )
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id))
  expect(state.history).toHaveLength(2)
  expect(state.teeth["16"]!.entries).toHaveLength(2)
  expect(state.teeth["16"]!.surfaces).toEqual(["occlusal"])
})

it("odontograma: superficie FDI inválida y buccal en anterior se rechazan", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Superficie S" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
        toothNumber: 99,
        condition: "caries",
        surfaces: [],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
        toothNumber: 11,
        condition: "caries",
        surfaces: ["buccal"],
        details: { variant: "enamel" },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
        toothNumber: 11,
        condition: "caries",
        surfaces: ["facial"],
        details: { variant: "enamel" },
      }),
    ),
  ).resolves.toHaveLength(1)
})

it("odontograma: void cross-tenant y cross-paciente responden 404", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Tenant T" }),
  )
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    }),
  )
  const id = rows[0]!.id
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      voidOdontogramEntry(tx, "org_b", ACTOR, id, p.id, "intento cross-org"),
    ),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      voidOdontogramEntry(
        tx,
        "org_a",
        ACTOR,
        id,
        "00000000-0000-0000-0000-000000000000",
        "otro paciente",
      ),
    ),
  ).rejects.toMatchObject({ status: 404 })
})

it("acta: snapshot inmutable con identidad firmada; bloquear con revisión pendiente", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Acta A" }),
  )
  const base = {
    purpose: "initial",
    specifications: "Odontograma inicial",
    observations: "Sin observaciones",
    signature: [
      [
        [5, 90],
        [20, 70],
        [40, 75],
      ],
    ],
  }
  // Quien firma lo hace con su perfil: sin colegiatura no hay firma.
  const signer = `acta-${crypto.randomUUID()}`
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${signer}, 'Cuenta de Ana', ${`${signer}@example.com`})`,
  )
  await ownerDb.execute(
    sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
        values (${crypto.randomUUID()}, 'org_a', ${signer}, 'dentist', now())`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) => createOdontogramAssessment(tx, "org_a", signer, p.id, base)),
  ).rejects.toMatchObject({ code: "PROFILE_INCOMPLETE" })
  await ownerDb.execute(
    sql`insert into "professional_profile" ("organization_id", "user_id", "signature_name", "professional_title", "registration_body", "registration_number")
        values ('org_a', ${signer}, 'Ana Torres', 'Cirujano dentista', 'COP', '12345')`,
  )
  // Lo que se escriba como examinador no cuenta: firma el perfil.
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    createOdontogramAssessment(tx, "org_a", signer, p.id, {
      ...base,
      examinerName: "Otra persona",
      registrationNumber: "COP 999",
    } as typeof base),
  )
  expect(first).toMatchObject({ examinerName: "Ana Torres", registrationNumber: "COP 12345" })
  expect(first.patientName).toBe("Acta A")
  expect(first.patientNumber).toBeGreaterThan(0)
  expect(first.entries).toEqual([])
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    }),
  )
  const listed = await withOrgContext(appDb, "org_a", (tx) =>
    listOdontogramAssessments(tx, "org_a", p.id),
  )
  expect(listed).toHaveLength(1)
  expect(listed[0]!.entries).toEqual([])
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    createOdontogramAssessment(tx, "org_a", signer, p.id, { ...base, purpose: "new_findings" }),
  )
  expect(second.entries as unknown[]).toHaveLength(1)
  // Sin firma capturada no se sella.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createOdontogramAssessment(tx, "org_a", signer, p.id, { ...base, signature: [] }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("legado: reviewLegacyEntry exige needsReview y anula con motivo", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Legado L" }),
  )
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      reviewLegacyEntry(tx, "org_a", ACTOR, p.id, rows[0]!.id, "no es legado"),
    ),
  ).rejects.toMatchObject({ status: 409 })
  await ownerDb.execute(
    sql`update odontogram_entry set needs_review=true where id=${rows[0]!.id}::uuid`,
  )
  const reviewed = await withOrgContext(appDb, "org_a", (tx) =>
    reviewLegacyEntry(tx, "org_a", ACTOR, p.id, rows[0]!.id, "Hallazgo antiguo sin evidencia"),
  )
  expect(reviewed.status).toBe("voided")
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id))
  expect(state.teeth).toEqual({})
})

it("inmutabilidad real: UPDATE clinical_note con el rol app es rechazado", async () => {
  await seedUserAndCie()
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Inmutable I" }),
  )
  const note = await withOrgContext(appDb, "org_a", (tx) =>
    addClinicalNote(tx, "org_a", ACTOR, p.id, { note: "Evolución inicial" }),
  )
  const err = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(sql`update "clinical_note" set "note" = 'hack' where "id" = ${note.id}::uuid`),
  ).then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string; message?: string }; message?: string },
  )
  expect(err).not.toBeNull()
  // 42501 insufficient_privilege (REVOKE UPDATE a dentalagent_app).
  expect(err?.cause?.code ?? err?.message).toMatch(/42501|permission denied/i)
})
it("persona única: una identidad, protegida del agente y sustituible por el contacto real", async () => {
  const ficha = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Rosa Quispe Mamani",
      docType: "DNI",
      docNumber: "45550001",
      phone: "+51955500011",
    }),
  )
  const persona = async () =>
    (await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", ficha.id))).contacts.find(
      (link) => link.relationship === "self",
    )
  const provisional = await persona()
  if (!provisional) throw new Error("El paciente no recibió su persona")

  // Editar la ficha actualiza a la persona, y editar a la persona actualiza la ficha.
  await withOrgContext(appDb, "org_a", (tx) =>
    updatePatient(tx, "org_a", ACTOR, ficha.id, { displayName: "Rosa Quispe de Ríos" }),
  )
  const trasFicha = await withOrgContext(appDb, "org_a", (tx) =>
    getContact(tx, "org_a", provisional.contactId),
  )
  expect(trasFicha.contact).toMatchObject({
    displayName: "Rosa Quispe de Ríos",
    docType: "DNI",
    docNumber: "45550001",
  })
  await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", provisional.contactId, { birthDate: "1972-03-04", sex: "F" }),
  )
  const trasPersona = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", ficha.id))
  expect(trasPersona.patient).toMatchObject({ birthDate: "1972-03-04", sex: "F" })

  // El agente no cambia la identidad de quien ya es paciente; sí sus etiquetas.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      updateContact(
        tx,
        "org_a",
        provisional.contactId,
        { displayName: "Rosita" },
        { userId: null, origin: "agent" },
      ),
    ),
  ).rejects.toMatchObject({ code: "PATIENT_IDENTITY_PROTECTED", status: 409 })
  await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(
      tx,
      "org_a",
      provisional.contactId,
      { tags: ["interesado-ortodoncia"] },
      { userId: null, origin: "agent" },
    ),
  )

  // Un documento es de una sola persona.
  const otra = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Otra Persona" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      updateContact(tx, "org_a", otra.id, { docType: "DNI", docNumber: "45550001" }),
    ),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", status: 409 })

  // Rosa escribe por WhatsApp desde un contacto nuevo: identificarla con él
  // sustituye a la persona provisional sin dejar dos identidades.
  const whatsapp = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Rosita 🌸", phone: "+51911222333" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", ACTOR, ficha.id, {
      contactId: whatsapp.id,
      relationship: "self",
      isPreferred: true,
    }),
  )
  const definitiva = await persona()
  expect(definitiva).toMatchObject({ contactId: whatsapp.id, displayName: "Rosa Quispe de Ríos" })
  // La persona provisional no deja rastro: nada más la referenciaba.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", provisional.contactId)),
  ).rejects.toMatchObject({ status: 404 })
  const nuevo = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", whatsapp.id))
  expect(nuevo.contact).toMatchObject({ docType: "DNI", docNumber: "45550001" })
  expect(nuevo.contact.notes).toContain("Teléfono anterior del contacto: +51911222333")

  // Con actividad propia ya no es provisional: no se fusiona en silencio.
  const tercero = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Tercero" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", ACTOR, ficha.id, {
      contactId: tercero.id,
      relationship: "family",
      isPreferred: false,
    }),
  )
  await ownerDb.execute(
    sql`insert into task (organization_id, contact_id, title, created_by) values ('org_a', ${whatsapp.id}, 'Llamar', ${ACTOR})`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      setPatientContact(tx, "org_a", ACTOR, ficha.id, {
        contactId: tercero.id,
        relationship: "self",
        isPreferred: false,
      }),
    ),
  ).rejects.toMatchObject({ code: "PATIENT_PERSON_IN_USE", status: 409 })
  // La propia persona no se degrada a otro vínculo.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      setPatientContact(tx, "org_a", ACTOR, ficha.id, {
        contactId: whatsapp.id,
        relationship: "family",
        isPreferred: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "PATIENT_PERSON_REQUIRED", status: 409 })
})
