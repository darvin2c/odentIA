process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { createAppDb, createOwnerDb, type Db } from "@odentia/db";
import { secretsKeyFromEnv } from "@odentia/services";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Hono, type Next } from "hono";
import type { Context } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createPatientsRoute } from "./patients.js";
import type { CrmDeps } from "./helpers.js";

const IMAGE = "dentalagent-postgres:18.6";
const KEY = secretsKeyFromEnv("ee".repeat(32));

let container: StartedTestContainer;
let ownerDb: Db;
let appDb: Db;

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado");
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado");
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado");
  },
  putPatientAvatar: async ({ orgId, patientId, bytes, contentType, ext }: { orgId: string; patientId: string; bytes: Uint8Array; contentType: string; ext: string }) => ({
    objectKey: `patients/${orgId}/${patientId}/avatar/${crypto.randomUUID()}.${ext}`,
    mimeType: contentType, filename: `avatar.${ext}`, size: bytes.byteLength,
  }),
};

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_a");
    c.set("userId", "u-1");
    c.set("memberRole", role);
    await next();
  };
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  };
  const app = new Hono();
  app.use("*", stubOrg(role));
  app.route("/patients", createPatientsRoute(deps));
  return app;
}

interface EncounterRow {
  id: string;
  status: string;
  reason: string | null;
}

interface EncounterDetailBody {
  data: {
    encounter: EncounterRow;
    teeth: number[];
    procedures: Array<{ id: string; planItemId: string | null }>;
    notes: Array<{ id: string }>;
    odontogramEntries: Array<{ id: string }>;
    documents: Array<{ id: string }>;
    addenda: Array<{ id: string; kind: string; note: string }>;
  };
}

interface PlanItemRow {
  id: string;
  status: string;
  encounterId: string | null;
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function createFreshPatient(app: Hono, name: string): Promise<string> {
  const res = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: `${name} ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function postEncounter(app: Hono, patientId: string, payload: Record<string, unknown>) {
  return app.request(`/patients/${patientId}/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start();
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`;
  ownerDb = createOwnerDb(uri);
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" });
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  );
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  );
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_b', 'Clínica Sur', 'sur', now())`,
  );
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev') on conflict do nothing`,
  );
  await ownerDb.execute(
    sql`insert into "cie10_code" ("code", "description") values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')
        on conflict ("code") do nothing`,
  );
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

it("encounters: POST borrador 201 y segundo borrador 409 DRAFT_OPEN", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Unico");

  const first = await postEncounter(app, patientId, { reason: "Dolor molar" });
  expect(first.status).toBe(201);
  const firstBody = (await first.json()) as { data: EncounterRow };
  expect(firstBody.data.status).toBe("borrador");

  const second = await postEncounter(app, patientId, { reason: "Otro motivo" });
  expect(second.status).toBe(409);
  const err = (await second.json()) as ErrorBody;
  expect(err.error.code).toBe("DRAFT_OPEN");
});

it("encounters: POST simultáneos resuelven uno 201 y otro 409 DRAFT_OPEN", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Carrera");

  const [a, b] = await Promise.all([
    postEncounter(app, patientId, { reason: "Carrera A" }),
    postEncounter(app, patientId, { reason: "Carrera B" }),
  ]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([201, 409]);
  const loser = a.status === 409 ? a : b;
  const err = (await loser.json()) as ErrorBody;
  expect(err.error.code).toBe("DRAFT_OPEN");
});

it("encounters: PATCH reason/teeth reemplaza y el detalle lo refleja", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Edicion");

  const created = await postEncounter(app, patientId, { reason: "Motivo inicial", teeth: [11] });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { data: EncounterRow };
  const encounterId = createdBody.data.id;

  const patched = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Motivo corregido", teeth: [36] }),
  });
  expect(patched.status).toBe(200);
  const patchedBody = (await patched.json()) as { data: EncounterRow };
  expect(patchedBody.data.reason).toBe("Motivo corregido");

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`);
  expect(detail.status).toBe(200);
  const detailBody = (await detail.json()) as EncounterDetailBody;
  expect(detailBody.data.encounter.reason).toBe("Motivo corregido");
  expect(detailBody.data.teeth).toEqual([36]);
});

it("encounters: finalize 200 y luego PATCH/procedure/nota/odontograma vinculados responden 409 FINALIZED", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Cierre");

  const created = await postEncounter(app, patientId, { reason: "Cierre" });
  const createdBody = (await created.json()) as { data: EncounterRow };
  const encounterId = createdBody.data.id;

  const finalized = await app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, {
    method: "POST",
  });
  expect(finalized.status).toBe(200);
  const finalizedBody = (await finalized.json()) as { data: EncounterRow };
  expect(finalizedBody.data.status).toBe("finalizada");

  const patch = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Edición tardía" }),
  });
  expect(patch.status).toBe(409);
  expect(((await patch.json()) as ErrorBody).error.code).toBe("FINALIZED");

  const proc = await app.request(`/patients/${patientId}/encounters/${encounterId}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Obturación tardía" }),
  });
  expect(proc.status).toBe(409);
  expect(((await proc.json()) as ErrorBody).error.code).toBe("FINALIZED");

  const note = await app.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Nota vinculada tardía", encounterId }),
  });
  expect(note.status).toBe(409);
  expect(((await note.json()) as ErrorBody).error.code).toBe("FINALIZED");

  const odonto = await app.request(`/patients/${patientId}/odontogram/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toothNumber: 36, condition: "caries", encounterId }),
  });
  expect(odonto.status).toBe(409);
  expect(((await odonto.json()) as ErrorBody).error.code).toBe("FINALIZED");
});

it("encounters: adenda en borrador 409 NOT_FINALIZED; tras finalizar 201 kind adenda visible en detalle", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Adenda");

  const created = await postEncounter(app, patientId, { reason: "Con adenda" });
  const createdBody = (await created.json()) as { data: EncounterRow };
  const encounterId = createdBody.data.id;

  const early = await app.request(`/patients/${patientId}/encounters/${encounterId}/addenda`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Adenda prematura" }),
  });
  expect(early.status).toBe(409);
  expect(((await early.json()) as ErrorBody).error.code).toBe("NOT_FINALIZED");

  const finalized = await app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, {
    method: "POST",
  });
  expect(finalized.status).toBe(200);

  const added = await app.request(`/patients/${patientId}/encounters/${encounterId}/addenda`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Corrección posterior" }),
  });
  expect(added.status).toBe(201);
  const addedBody = (await added.json()) as { data: { kind: string; note: string } };
  expect(addedBody.data.kind).toBe("adenda");

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`);
  const detailBody = (await detail.json()) as EncounterDetailBody;
  expect(detailBody.data.addenda.map((n) => n.note)).toContain("Corrección posterior");
  expect(detailBody.data.addenda.every((n) => n.kind === "adenda")).toBe(true);
});

it("encounters: procedure con planItemId deja el plan realizado con el mismo encounterId", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Plan");

  const created = await postEncounter(app, patientId, { reason: "Cierra plan" });
  const createdBody = (await created.json()) as { data: EncounterRow };
  const encounterId = createdBody.data.id;

  const itemRes = await app.request(`/patients/${patientId}/plan/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Corona 36" }),
  });
  expect(itemRes.status).toBe(201);
  const itemBody = (await itemRes.json()) as { data: PlanItemRow };
  const itemId = itemBody.data.id;

  const proc = await app.request(`/patients/${patientId}/encounters/${encounterId}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Corona 36", toothNumber: 36, planItemId: itemId }),
  });
  expect(proc.status).toBe(201);

  const plan = await app.request(`/patients/${patientId}/plan`);
  expect(plan.status).toBe(200);
  const planBody = (await plan.json()) as { data: PlanItemRow[] };
  const updated = planBody.data.find((row) => row.id === itemId);
  expect(updated?.status).toBe("realizado");
  expect(updated?.encounterId).toBe(encounterId);

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`);
  const detailBody = (await detail.json()) as EncounterDetailBody;
  expect(detailBody.data.procedures.some((p) => p.planItemId === itemId)).toBe(true);
});

it("encounters: referencias de otro paciente del mismo org responden 404 sin efectos", async () => {
  const app = buildApp("member");
  const patientA = await createFreshPatient(app, "Paciente A");
  const patientB = await createFreshPatient(app, "Paciente B");

  const createdA = await postEncounter(app, patientA, { reason: "De A" });
  const bodyA = (await createdA.json()) as { data: EncounterRow };
  const encounterA = bodyA.data.id;

  const itemB = await app.request(`/patients/${patientB}/plan/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Plan de B" }),
  });
  const itemBBody = (await itemB.json()) as { data: PlanItemRow };

  const crossGet = await app.request(`/patients/${patientB}/encounters/${encounterA}`);
  expect(crossGet.status).toBe(404);
  expect(((await crossGet.json()) as ErrorBody).error.code).toBe("NOT_FOUND");

  const crossProc = await app.request(`/patients/${patientB}/encounters/${encounterA}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Cruce de paciente" }),
  });
  expect(crossProc.status).toBe(404);
  expect(((await crossProc.json()) as ErrorBody).error.code).toBe("NOT_FOUND");

  const crossPlan = await app.request(`/patients/${patientA}/encounters/${encounterA}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Cruce de plan", planItemId: itemBBody.data.id }),
  });
  expect(crossPlan.status).toBe(404);
  expect(((await crossPlan.json()) as ErrorBody).error.code).toBe("NOT_FOUND");

  const detailA = (await (await app.request(`/patients/${patientA}/encounters/${encounterA}`)).json()) as EncounterDetailBody;
  expect(detailA.data.procedures).toEqual([]);

  const planB = (await (await app.request(`/patients/${patientB}/plan`)).json()) as { data: PlanItemRow[] };
  expect(planB.data.find((row) => row.id === itemBBody.data.id)?.status).toBe("pendiente");
});

it("encounters: finalize frente a PATCH concurrentes se serializa sin mutación cerrada", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Borrador Concurrente");

  const created = await postEncounter(app, patientId, { reason: "Concurrente" });
  const createdBody = (await created.json()) as { data: EncounterRow };
  const encounterId = createdBody.data.id;

  const [patchRes, finalizeRes] = await Promise.all([
    app.request(`/patients/${patientId}/encounters/${encounterId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Edición concurrente" }),
    }),
    app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, { method: "POST" }),
  ]);

  expect(finalizeRes.status).toBe(200);
  expect([200, 409]).toContain(patchRes.status);
  if (patchRes.status === 409) {
    expect(((await patchRes.json()) as ErrorBody).error.code).toBe("FINALIZED");
  }

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`);
  expect(detail.status).toBe(200);
  const detailBody = (await detail.json()) as EncounterDetailBody;
  expect(detailBody.data.encounter.status).toBe("finalizada");
});
