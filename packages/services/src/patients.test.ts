import { withOrgContext } from "@odentia/db";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  addClinicalNote,
  addOdontogramEntries,
  createOdontogramAssessment,
  getOdontogram,
  getPatientHealth,
  listAnamnesisVersions,
  listOdontogramAssessments,
  reviewLegacyEntry,
  savePatientHealth,
  voidOdontogramEntry,
} from "./clinical.js";
import { createContact } from "./contacts.js";
import { createPatient, getPatientByContact, listPatients, nextPatientNumber } from "./patients.js";
import { appDb, ownerDb, setupTestDb } from "./test-setup.js";

setupTestDb();

const ACTOR = "u-tests";

async function seedUserAndCie(): Promise<void> {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Tests', 'tests@example.com')
        on conflict ("id") do nothing`,
  );
  await ownerDb.execute(
    sql`insert into "cie10_code" ("code", "description") values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')
        on conflict ("code") do nothing`,
  );
}

it("pagina por fecha sin perder microsegundos ni duplicar empates", async () => {
  await seedUserAndCie();
  const patients = [];
  for (const suffix of ["A", "B", "C"]) {
    const row = await withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, { displayName: `Cursor preciso ${suffix}` }),
    );
    patients.push(row);
    const timestamp = suffix === "A" ? "2026-01-01T00:00:00.123001Z" : "2026-01-01T00:00:00.123002Z";
    await ownerDb.execute(sql`update patient set created_at = ${timestamp}::timestamptz where id = ${row.id}`);
  }
  const ascending = [patients[0]!.id, ...[patients[1]!.id, patients[2]!.id].sort()];
  for (const sort of ["created", "-created"]) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 3; index++) {
      const page = await withOrgContext(appDb, "org_a", (tx) =>
        listPatients(tx, "org_a", { q: "Cursor preciso", sort, limit: 1, cursor }),
      );
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(ids).toEqual(sort === "created" ? ascending : [...ascending].reverse());
  }
});

it("crear paciente directo y por promoción; doble promoción da 409", async () => {
  await seedUserAndCie();
  const direct = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "María Pérez", docType: "DNI", docNumber: "12345678" }),
  );
  expect(direct.patientNumber).toBeGreaterThan(0);

  const contact = await withOrgContext(appDb, "org_a", (tx) => createContact(tx, "org_a", { displayName: "Juan Ríos" }));
  const promoted = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { contactId: contact.id }),
  );
  expect(promoted.contactId).toBe(contact.id);
  const byContact = await withOrgContext(appDb, "org_a", (tx) => getPatientByContact(tx, "org_a", contact.id));
  expect(byContact?.id).toBe(promoted.id);

  await expect(
    withOrgContext(appDb, "org_a", (tx) => createPatient(tx, "org_a", ACTOR, { contactId: contact.id })),
  ).rejects.toMatchObject({ status: 409 });
});

it("documento duplicado da 409 y el correlativo es por org", async () => {
  const a1 = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Doc A", docType: "DNI", docNumber: "87654321" }),
  );
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, { displayName: "Doc B", docType: "DNI", docNumber: "87654321" }),
    ),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", status: 409 });
  // Misma numeración independiente por org.
  const b1 = await withOrgContext(appDb, "org_b", (tx) => createPatient(tx, "org_b", ACTOR, { displayName: "Org B" }));
  expect(b1.patientNumber).toBe(1);
  expect(a1.patientNumber).toBeGreaterThan(1);
  const n = await withOrgContext(appDb, "org_b", (tx) => nextPatientNumber(tx, "org_b"));
  expect(n).toBe(b1.patientNumber + 1);
});

it("salud guarda el agregado con revisión y versiona la entrevista solo si cambia", async () => {
  await seedUserAndCie();
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Ana V" }),
  );
  const base = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
    allergies: [{ substance: "Penicilina", severity: "severa" as const }],
    conditions: [{ name: "Asma", status: "activa" as const }],
    medications: [{ name: "Salbutamol", frequency: "según necesidad" }],
    anamnesis: { expectedVersion: 0, answers: { antecedentesFamiliares: "Ninguno" } },
  };
  const v1 = await withOrgContext(appDb, "org_a", (tx) => savePatientHealth(tx, "org_a", ACTOR, p.id, base));
  expect(v1.revision).toBe(1);
  expect(v1.reviewStatus).toEqual({ allergies: "recorded", conditions: "recorded", medications: "recorded" });
  expect(v1.latestAnamnesis?.version).toBe(1);
  // Reenvío idéntico con la misma revisión: 409 sin sobrescribir, valores locales intactos.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => savePatientHealth(tx, "org_a", ACTOR, p.id, base)),
  ).rejects.toMatchObject({ code: "STALE_HEALTH_REVISION", status: 409 });
  const kept = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", p.id));
  expect(kept.revision).toBe(1);
  expect(kept.allergies).toHaveLength(1);
  const sameInterview = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, {
      expectedRevision: 1,
      reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
      allergies: [{ id: v1.allergies[0]!.id, substance: "Penicilina", severity: "severa" as const }],
      conditions: [{ id: v1.conditions[0]!.id, name: "Asma", status: "activa" as const }],
      medications: [{ id: v1.medications[0]!.id, name: "Salbutamol", frequency: "según necesidad" }],
    }),
  );
  expect(sameInterview.revision).toBe(2);
  expect(sameInterview.latestAnamnesis?.version).toBe(1);
  const history = await withOrgContext(appDb, "org_a", (tx) => listAnamnesisVersions(tx, "org_a", p.id));
  expect(history).toHaveLength(1);
  expect(history[0]).not.toHaveProperty("answers");
});

it("salud revierte todo si una fila es inválida y exige colecciones completas", async () => {
  await seedUserAndCie();
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Salud Atómica" }),
  );
  const valid = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Látex", severity: "leve" as const }],
    conditions: [],
    medications: [],
  };
  const saved = await withOrgContext(appDb, "org_a", (tx) => savePatientHealth(tx, "org_a", ACTOR, p.id, valid));
  expect(saved.revision).toBe(1);
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
  ).rejects.toMatchObject({ status: 400 });
  const kept = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", p.id));
  expect(kept.revision).toBe(1);
  expect(kept.allergies).toHaveLength(1);
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
  ).rejects.toMatchObject({ status: 400 });
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
  ).rejects.toMatchObject({ status: 400 });
  const denied = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, p.id, {
      expectedRevision: 1,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      allergies: [{ id: saved.allergies[0]!.id, substance: "Látex", severity: "leve" as const, isActive: false }],
      conditions: [],
      medications: [],
    }),
  );
  expect(denied.revision).toBe(2);
  expect(denied.reviewStatus.allergies).toBe("none");
});

it("odontograma: add + void; el estado deriva sin anuladas y el original se preserva", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Odonto O" }),
  );
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["occlusal"], details: { variant: "enamel" } }),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("recorded");
  await expect(
    withOrgContext(appDb, "org_a", (tx) => voidOdontogramEntry(tx, "org_a", ACTOR, rows[0]!.id, p.id, "")),
  ).rejects.toMatchObject({ status: 400 });
  const voided = await withOrgContext(appDb, "org_a", (tx) =>
    voidOdontogramEntry(tx, "org_a", ACTOR, rows[0]!.id, p.id, "Error de registro"),
  );
  expect(voided.status).toBe("voided");
  expect(voided.voidReason).toBe("Error de registro");
  expect(voided.voidedAt).not.toBeNull();
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id));
  expect(state.teeth).toEqual({});
  expect(state.history).toHaveLength(1);
  expect(state.history[0]!.status).toBe("voided");
  expect(state.history[0]!.condition).toBe("caries");
  expect(state.history[0]!.surface).toBe("occlusal");
});

it("odontograma: coexisten varias condiciones en la misma pieza", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Coexiste C" }),
  );
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["occlusal"], details: { variant: "enamel" } }),
  );
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, {
      toothNumber: 16, condition: "fracture", details: { drawing: [[[0, 0], [10, 10], [20, 20]], [[30, 30], [40, 40], [50, 50]], [[60, 60], [70, 70], [80, 80]]] },
    }),
  );
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id));
  expect(state.history).toHaveLength(2);
  expect(state.teeth["16"]!.entries).toHaveLength(2);
  expect(state.teeth["16"]!.surfaces).toEqual(["occlusal"]);
});

it("odontograma: superficie FDI inválida y buccal en anterior se rechazan", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Superficie S" }),
  );
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 99, condition: "caries", surfaces: [] }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 11, condition: "caries", surfaces: ["buccal"], details: { variant: "enamel" } }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 11, condition: "caries", surfaces: ["facial"], details: { variant: "enamel" } }),
    ),
  ).resolves.toHaveLength(1);
});

it("odontograma: void cross-tenant y cross-paciente responden 404", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Tenant T" }),
  );
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["occlusal"], details: { variant: "enamel" } }),
  );
  const id = rows[0]!.id;
  await expect(
    withOrgContext(appDb, "org_b", (tx) => voidOdontogramEntry(tx, "org_b", ACTOR, id, p.id, "intento cross-org")),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    withOrgContext(appDb, "org_a", (tx) => voidOdontogramEntry(tx, "org_a", ACTOR, id, "00000000-0000-0000-0000-000000000000", "otro paciente")),
  ).rejects.toMatchObject({ status: 404 });
});

it("acta: snapshot inmutable con identidad firmada; bloquear con revisión pendiente", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Acta A" }),
  );
  const base = {
    purpose: "initial",
    specifications: "Odontograma inicial",
    observations: "Sin observaciones",
    examinerName: "Doctora Tests",
    registrationNumber: "COP 999",
    signature: [[[5, 90], [20, 70], [40, 75]]],
  };
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    createOdontogramAssessment(tx, "org_a", ACTOR, p.id, base),
  );
  expect(first.patientName).toBe("Acta A");
  expect(first.patientNumber).toBeGreaterThan(0);
  expect(first.entries).toEqual([]);
  await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["occlusal"], details: { variant: "enamel" } }),
  );
  const listed = await withOrgContext(appDb, "org_a", (tx) => listOdontogramAssessments(tx, "org_a", p.id));
  expect(listed).toHaveLength(1);
  expect(listed[0]!.entries).toEqual([]);
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    createOdontogramAssessment(tx, "org_a", ACTOR, p.id, { ...base, purpose: "new_findings" }),
  );
  expect((second.entries as unknown[])).toHaveLength(1);
  // Sin firma capturada no se sella.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => createOdontogramAssessment(tx, "org_a", ACTOR, p.id, { ...base, signature: [] })),
  ).rejects.toMatchObject({ status: 400 });
});

it("legado: reviewLegacyEntry exige needsReview y anula con motivo", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Legado L" }),
  );
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["occlusal"], details: { variant: "enamel" } }),
  );
  await expect(
    withOrgContext(appDb, "org_a", (tx) => reviewLegacyEntry(tx, "org_a", ACTOR, p.id, rows[0]!.id, "no es legado")),
  ).rejects.toMatchObject({ status: 409 });
  await ownerDb.execute(sql`update odontogram_entry set needs_review=true where id=${rows[0]!.id}::uuid`);
  const reviewed = await withOrgContext(appDb, "org_a", (tx) =>
    reviewLegacyEntry(tx, "org_a", ACTOR, p.id, rows[0]!.id, "Hallazgo antiguo sin evidencia"),
  );
  expect(reviewed.status).toBe("voided");
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id));
  expect(state.teeth).toEqual({});
});

it("inmutabilidad real: UPDATE clinical_note con el rol app es rechazado", async () => {
  await seedUserAndCie();
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Inmutable I" }),
  );
  const note = await withOrgContext(appDb, "org_a", (tx) =>
    addClinicalNote(tx, "org_a", ACTOR, p.id, { note: "Evolución inicial", diagnosisCode: "K04.0" }),
  );
  const err = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(sql`update "clinical_note" set "note" = 'hack' where "id" = ${note.id}::uuid`),
  ).then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string; message?: string }; message?: string },
  );
  expect(err).not.toBeNull();
  // 42501 insufficient_privilege (REVOKE UPDATE a dentalagent_app).
  expect(err?.cause?.code ?? err?.message).toMatch(/42501|permission denied/i);
});
