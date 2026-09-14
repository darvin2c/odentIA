import { withOrgContext } from "@odentia/db";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  addAnamnesis,
  addClinicalNote,
  addMedication,
  addOdontogramEntries,
  discontinueMedication,
  getOdontogram,
  listAnamnesisVersions,
  voidOdontogramEntry,
} from "./clinical.js";
import { createContact } from "./contacts.js";
import { createPatient, getPatientByContact, nextPatientNumber } from "./patients.js";
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

it("anamnesis versiona 1→2 y el historial no trae answers", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Ana V" }),
  );
  const v1 = await withOrgContext(appDb, "org_a", (tx) =>
    addAnamnesis(tx, "org_a", ACTOR, p.id, { motivoConsulta: "dolor" }),
  );
  expect(v1.version).toBe(1);
  const v2 = await withOrgContext(appDb, "org_a", (tx) =>
    addAnamnesis(tx, "org_a", ACTOR, p.id, { motivoConsulta: "dolor", observaciones: "control" }),
  );
  expect(v2.version).toBe(2);
  const history = await withOrgContext(appDb, "org_a", (tx) => listAnamnesisVersions(tx, "org_a", p.id));
  expect(history).toHaveLength(2);
  expect(history[0]).not.toHaveProperty("answers");
});

it("discontinueMedication dos veces da 409", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Med M" }),
  );
  const med = await withOrgContext(appDb, "org_a", (tx) =>
    addMedication(tx, "org_a", ACTOR, p.id, { name: "Amoxicilina" }),
  );
  await withOrgContext(appDb, "org_a", (tx) => discontinueMedication(tx, "org_a", ACTOR, med.id));
  await expect(
    withOrgContext(appDb, "org_a", (tx) => discontinueMedication(tx, "org_a", ACTOR, med.id)),
  ).rejects.toMatchObject({ status: 409 });
});

it("odontograma: add + void; el estado deriva sin anuladas", async () => {
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Odonto O" }),
  );
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    addOdontogramEntries(tx, "org_a", ACTOR, p.id, { toothNumber: 16, condition: "caries", surfaces: ["oclusal"] }),
  );
  expect(rows).toHaveLength(1);
  await withOrgContext(appDb, "org_a", (tx) => voidOdontogramEntry(tx, "org_a", ACTOR, rows[0]!.id));
  const state = await withOrgContext(appDb, "org_a", (tx) => getOdontogram(tx, "org_a", p.id));
  expect(state.teeth).toEqual({});
  expect(state.history).toHaveLength(1);
  expect(state.history[0]!.status).toBe("anulado");
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
