import { patient, patientAllergy } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  addPatientAllergy,
  allergyReviewDue,
  codePatientAllergy,
  markAllergiesReviewed,
  removePatientAllergy,
  restorePatientAllergy,
} from "./allergies.js"
import { addDeclaredAllergies, getPatientHealth, savePatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

describe("alergias una por una (tablero 7)", () => {
  it("agrega con la sustancia de la lista o escrita, sin repetir la que ya está", async () => {
    const f = await clinicalFixture()
    const [org, actor, patientId] = f.args
    // Elegida de la lista: el nombre y el tipo salen de ahí.
    const listed = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, {
        substanceSystem: "atc",
        substanceCode: "J01C",
        severity: "severa",
      }),
    )
    expect(listed).toMatchObject({
      substance: "Penicilinas (grupo)",
      substanceSystem: "atc",
      substanceCode: "J01C",
      category: "medicamento",
      severity: "severa",
      source: "equipo",
      createdBy: actor,
    })
    // Escrita igual que una de la lista: queda con su código.
    const written = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "LÁTEX", severity: "leve" }),
    )
    expect(written).toMatchObject({
      substanceSystem: "odentia",
      substanceCode: "latex",
      substance: "Látex",
    })
    // Lo que no es exactamente una de la lista queda sin codificar y sin gravedad, «desconocida».
    const free = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "amoxi" }),
    )
    expect(free).toMatchObject({ substance: "amoxi", substanceCode: null, severity: "desconocida" })
    // La misma otra vez, escrita de otra forma, no se repite.
    await expect(
      f.run((tx) => addPatientAllergy(tx, org, actor, patientId, { substance: "penicilina" })),
    ).rejects.toMatchObject({ code: "ALLERGY_EXISTS", status: 409 })
    await expect(
      f.run((tx) =>
        addPatientAllergy(tx, org, actor, patientId, {
          substanceSystem: "atc",
          substanceCode: "NO_EXISTE",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      f.run((tx) =>
        addPatientAllergy(tx, org, actor, patientId, { substance: "Maní", severity: "grave" }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    // Cada una avanza la revisión del agregado, deja el grupo registrado y cuenta como revisión.
    const health = await f.run((tx) => getPatientHealth(tx, org, patientId))
    expect(health.revision).toBe(3)
    expect(health.reviewStatus.allergies).toBe("recorded")
    expect(health.allergiesReviewedBy).toBe(actor)
    expect(health.allergyReviewDue).toBe(false)
  })

  it("quitar pide motivo, no borra y se deshace", async () => {
    const f = await clinicalFixture()
    const [org, actor, patientId] = f.args
    const latex = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "Látex", severity: "leve" }),
    )
    await expect(
      f.run((tx) => removePatientAllergy(tx, org, actor, patientId, latex.id, "porque si")),
    ).rejects.toMatchObject({ status: 400 })
    const removed = await f.run((tx) =>
      removePatientAllergy(tx, org, actor, patientId, latex.id, "otra_cosa"),
    )
    expect(removed).toMatchObject({ isActive: false, removedReason: "otra_cosa", removedBy: actor })
    expect(removed.removedAt).toBeInstanceOf(Date)
    await expect(
      f.run((tx) => removePatientAllergy(tx, org, actor, patientId, latex.id, "error")),
    ).rejects.toMatchObject({ code: "ALLERGY_ALREADY_REMOVED" })
    // Sigue guardada: está entre las de la ficha, quitada.
    const health = await f.run((tx) => getPatientHealth(tx, org, patientId))
    expect(health.allergies.map((row) => [row.substance, row.isActive])).toEqual([["Látex", false]])
    // Volver a ponerla deja todo como antes.
    const restored = await f.run((tx) => restorePatientAllergy(tx, org, actor, patientId, latex.id))
    expect(restored).toMatchObject({
      isActive: true,
      removedReason: null,
      removedAt: null,
      removedBy: null,
    })
    // Con otra igual vigente no se vuelve a poner.
    await f.run((tx) => removePatientAllergy(tx, org, actor, patientId, latex.id, "ya_no"))
    await f.run((tx) => addPatientAllergy(tx, org, actor, patientId, { substance: "látex" }))
    await expect(
      f.run((tx) => restorePatientAllergy(tx, org, actor, patientId, latex.id)),
    ).rejects.toMatchObject({
      code: "ALLERGY_EXISTS",
    })
  })

  it("«Elegir de la lista» agrega el código y conserva lo escrito", async () => {
    const f = await clinicalFixture()
    const [org, actor, patientId] = f.args
    const free = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "amoxi", severity: "moderada" }),
    )
    const coded = await f.run((tx) =>
      codePatientAllergy(tx, org, actor, patientId, free.id, {
        substanceSystem: "atc",
        substanceCode: "J01CA04",
      }),
    )
    expect(coded).toMatchObject({
      substance: "amoxi",
      substanceSystem: "atc",
      substanceCode: "J01CA04",
      category: "medicamento",
    })
    await expect(
      f.run((tx) =>
        codePatientAllergy(tx, org, actor, patientId, free.id, {
          substanceSystem: "atc",
          substanceCode: "J01C",
        }),
      ),
    ).rejects.toMatchObject({ code: "ALLERGY_ALREADY_CODED" })
    // Si ya hay otra vigente con ese código, se dice que está repetida.
    const other = await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "penic", severity: "leve" }),
    )
    await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, {
        substanceSystem: "atc",
        substanceCode: "J01C",
      }),
    )
    await expect(
      f.run((tx) =>
        codePatientAllergy(tx, org, actor, patientId, other.id, {
          substanceSystem: "atc",
          substanceCode: "J01C",
        }),
      ),
    ).rejects.toMatchObject({ code: "ALLERGY_EXISTS" })
  })

  it("«Sin cambios» deja quién y cuándo; sin ninguna vigente, que no tiene", async () => {
    const f = await clinicalFixture()
    const [org, actor, patientId] = f.args
    expect((await f.run((tx) => getPatientHealth(tx, org, patientId))).allergyReviewDue).toBe(true)
    await f.run((tx) => markAllergiesReviewed(tx, org, actor, patientId))
    const none = await f.run((tx) => getPatientHealth(tx, org, patientId))
    expect(none).toMatchObject({ allergiesReviewedBy: actor, allergyReviewDue: false })
    expect(none.reviewStatus.allergies).toBe("none")
    // Pasados 6 meses vuelve a tocar preguntarle.
    await ownerDb
      .update(patient)
      .set({ allergiesReviewedAt: sql`now() - interval '7 months'` })
      .where(eq(patient.id, patientId))
    expect((await f.run((tx) => getPatientHealth(tx, org, patientId))).allergyReviewDue).toBe(true)
    await f.run((tx) => addPatientAllergy(tx, org, actor, patientId, { substance: "Látex" }))
    await f.run((tx) => markAllergiesReviewed(tx, org, actor, patientId))
    expect((await f.run((tx) => getPatientHealth(tx, org, patientId))).reviewStatus.allergies).toBe(
      "recorded",
    )
  })

  it("cuenta los seis meses por calendario", () => {
    const reviewed = new Date("2026-04-20T15:00:00Z")
    expect(allergyReviewDue(null)).toBe(true)
    expect(allergyReviewDue(reviewed, new Date("2026-10-19T15:00:00Z"))).toBe(false)
    expect(allergyReviewDue(reviewed, new Date("2026-10-20T15:00:00Z"))).toBe(true)
  })

  it("guardar Antecedentes sin alergias no las toca; lo declarado entra a nombre del paciente", async () => {
    const f = await clinicalFixture()
    const [org, actor, patientId] = f.args
    await f.run((tx) =>
      addPatientAllergy(tx, org, actor, patientId, { substance: "Penicilina", severity: "severa" }),
    )
    const before = await f.run((tx) => getPatientHealth(tx, org, patientId))
    // Sin enviar alergias, aunque haya una guardada, y aunque diga «unknown»: el grupo queda como estaba.
    const saved = await f.run((tx) =>
      savePatientHealth(tx, org, actor, patientId, {
        expectedRevision: before.revision,
        reviewStatus: { allergies: "unknown", conditions: "none", medications: "recorded" },
        conditions: [],
        medications: [
          {
            name: "Cozaar",
            genericName: "losartán",
            doseValue: 50,
            doseUnit: "mg",
            frequencyCode: "cada_24_h",
          },
        ],
      }),
    )
    expect(saved.allergies).toEqual(before.allergies)
    expect(saved.reviewStatus.allergies).toBe("recorded")
    // La medicación habitual queda con su ATC y sus palabras.
    expect(saved.medications[0]).toMatchObject({
      atcCode: "C09CA01",
      dose: "50 mg",
      doseUnit: "mg",
      frequency: "Cada 24 horas",
      frequencyCode: "cada_24_h",
    })
    await expect(
      f.run((tx) =>
        savePatientHealth(tx, org, actor, patientId, {
          expectedRevision: saved.revision,
          reviewStatus: { allergies: "recorded", conditions: "none", medications: "recorded" },
          conditions: [],
          medications: [{ name: "Algo", doseValue: 2 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    // Lo que el paciente declaró en un cuestionario queda suyo y con su código.
    await f.run((tx) =>
      addDeclaredAllergies(tx, org, actor, patientId, [{ substance: "Aspirina", reaction: null }], {
        entity: "clinical_form_response",
        entityId: "f-1",
      }),
    )
    const [declared] = await ownerDb
      .select()
      .from(patientAllergy)
      .where(eq(patientAllergy.substance, "Aspirina"))
    expect(declared).toMatchObject({
      source: "paciente",
      substanceSystem: "atc",
      substanceCode: "N02BA01",
    })
  })
})
