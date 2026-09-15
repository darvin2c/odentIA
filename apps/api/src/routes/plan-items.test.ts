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

interface PlanItem {
  id: string;
  title: string;
  detail: string | null;
  toothNumber: number | null;
  diagnosisCode: string | null;
  priceCents: number | null;
  currency: string;
  status: string;
  encounterId: string | null;
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createFreshPatient(app: Hono, name: string): Promise<string> {
  const res = await postJson(app, "/patients", { displayName: `${name} ${crypto.randomUUID()}` });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function addItem(app: Hono, patientId: string, item: Record<string, unknown>): Promise<PlanItem> {
  const res = await postJson(app, `/patients/${patientId}/plan/items`, item);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: PlanItem };
  return body.data;
}

it("plan: POST 201 con campos completos y GET lista {data}", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Add");
  const item = await addItem(app, patientId, {
    title: "Corona cerámica",
    detail: "Corona en pieza 36",
    toothNumber: 36,
    diagnosisCode: "K02.1",
    priceCents: 12500,
  });
  expect(item.title).toBe("Corona cerámica");
  expect(item.detail).toBe("Corona en pieza 36");
  expect(item.toothNumber).toBe(36);
  expect(item.diagnosisCode).toBe("K02.1");
  expect(item.priceCents).toBe(12500);
  expect(item.status).toBe("pendiente");
  expect(item.currency).toBe("PEN");
  expect(item.encounterId).toBeNull();

  const list = await app.request(`/patients/${patientId}/plan`, { method: "GET" });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as { data: PlanItem[] };
  expect(listed.data.map((row) => row.id)).toContain(item.id);
});

it("plan: PATCH actualiza title/detail/price/tooth/diagnosis", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Update");
  const item = await addItem(app, patientId, {
    title: "Restauración",
    detail: "Detalle inicial",
    toothNumber: 36,
    diagnosisCode: "K02.1",
    priceCents: 5000,
  });

  const res = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    title: "Restauración compuesta",
    detail: "Detalle editado",
    priceCents: 7500,
    toothNumber: 37,
    diagnosisCode: "K04.0",
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as { data: PlanItem };
  expect(updated.data.title).toBe("Restauración compuesta");
  expect(updated.data.detail).toBe("Detalle editado");
  expect(updated.data.priceCents).toBe(7500);
  expect(updated.data.toothNumber).toBe(37);
  expect(updated.data.diagnosisCode).toBe("K04.0");
  expect(updated.data.status).toBe("pendiente");
});

it("plan: programado limpia encounterId y sigue editable", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Programado");
  const item = await addItem(app, patientId, { title: "Endodoncia", priceCents: 8000 });

  const scheduled = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    status: "programado",
  });
  expect(scheduled.status).toBe(200);
  const scheduledBody = (await scheduled.json()) as { data: PlanItem };
  expect(scheduledBody.data.status).toBe("programado");
  expect(scheduledBody.data.encounterId).toBeNull();

  const edited = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    title: "Endodoncia reprogramada",
  });
  expect(edited.status).toBe(200);
  const editedBody = (await edited.json()) as { data: PlanItem };
  expect(editedBody.data.title).toBe("Endodoncia reprogramada");
});

it("plan: realizado manual escribe encounterId null", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Manual");
  const item = await addItem(app, patientId, { title: "Extracción simple" });

  const res = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    status: "realizado",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: PlanItem };
  expect(body.data.status).toBe("realizado");
  expect(body.data.encounterId).toBeNull();
});

it("plan: contenido en realizado/cancelado responde 409 ITEM_CLOSED", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Cerrado");
  const done = await addItem(app, patientId, { title: "Ítem realizado" });
  const undone = await addItem(app, patientId, { title: "Ítem cancelado" });

  expect((await patchJson(app, `/patients/${patientId}/plan/items/${done.id}`, { status: "realizado" })).status).toBe(200);
  expect((await patchJson(app, `/patients/${patientId}/plan/items/${undone.id}`, { status: "cancelado" })).status).toBe(200);

  const editDone = await patchJson(app, `/patients/${patientId}/plan/items/${done.id}`, { title: "Cambio tardío" });
  expect(editDone.status).toBe(409);
  const editDoneBody = (await editDone.json()) as { error: { code: string } };
  expect(editDoneBody.error.code).toBe("ITEM_CLOSED");

  const editUndone = await patchJson(app, `/patients/${patientId}/plan/items/${undone.id}`, { detail: "Cambio tardío" });
  expect(editUndone.status).toBe(409);
  const editUndoneBody = (await editUndone.json()) as { error: { code: string } };
  expect(editUndoneBody.error.code).toBe("ITEM_CLOSED");
});

it("plan: reabrir a pendiente permite editar contenido", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Reabierto");
  const item = await addItem(app, patientId, { title: "Puente provisional" });

  const closed = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, { status: "realizado" });
  expect(closed.status).toBe(200);

  const reopened = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, { status: "pendiente" });
  expect(reopened.status).toBe(200);
  const reopenedBody = (await reopened.json()) as { data: PlanItem };
  expect(reopenedBody.data.status).toBe("pendiente");

  const edited = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, { title: "Puente definitivo" });
  expect(edited.status).toBe(200);
  const editedBody = (await edited.json()) as { data: PlanItem };
  expect(editedBody.data.title).toBe("Puente definitivo");
});

it("plan: currency se congela al crear", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Moneda");
  const item = await addItem(app, patientId, { title: "Implante", priceCents: 50000, currency: "USD" });
  expect(item.currency).toBe("USD");

  const res = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    title: "Implante titanio",
    currency: "PEN",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: PlanItem };
  expect(body.data.title).toBe("Implante titanio");
  expect(body.data.currency).toBe("USD");
});

it("plan: FDI inválida, cents negativo/fraccional, CIE10 inexistente y currency minúscula responden 400", async () => {
  const app = buildApp("member");
  const patientId = await createFreshPatient(app, "Plan Inválido");
  const cases: Record<string, unknown>[] = [
    { title: "FDI mala", toothNumber: 99 },
    { title: "Precio negativo", priceCents: -100 },
    { title: "Precio fraccional", priceCents: 10.5 },
    { title: "CIE10 inexistente", diagnosisCode: "Z99.9" },
    { title: "Moneda minúscula", currency: "pen" },
  ];
  for (const item of cases) {
    const res = await postJson(app, `/patients/${patientId}/plan/items`, item);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  }
});

it("plan: ítem de otro paciente responde 404", async () => {
  const app = buildApp("member");
  const patientA = await createFreshPatient(app, "Plan Paciente A");
  const patientB = await createFreshPatient(app, "Plan Paciente B");
  const item = await addItem(app, patientA, { title: "Ítem ajeno" });

  const res = await patchJson(app, `/patients/${patientB}/plan/items/${item.id}`, { title: "Intruso" });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("NOT_FOUND");

  const list = await app.request(`/patients/${patientB}/plan`, { method: "GET" });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as { data: PlanItem[] };
  expect(listed.data.map((row) => row.id)).not.toContain(item.id);
});

it("plan: summary separa totales por moneda sin sumar distinto dinero", async () => {
  const app = buildApp("member");
  const mixed = await createFreshPatient(app, "Plan Mixto");
  await addItem(app, mixed, { title: "Limpieza", priceCents: 1000 });
  await addItem(app, mixed, { title: "Ortodoncia", priceCents: 2500, currency: "USD" });

  const res = await app.request(`/patients/${mixed}/summary`, { method: "GET" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      planPending: {
        count: number;
        totalCents: number | null;
        currency: string | null;
        totals: { currency: string; count: number; totalCents: number }[];
      };
    };
  };
  expect(body.data.planPending.count).toBe(2);
  expect(body.data.planPending.totalCents).toBeNull();
  expect(body.data.planPending.currency).toBeNull();
  expect(body.data.planPending.totals).toEqual([
    { currency: "PEN", count: 1, totalCents: 1000 },
    { currency: "USD", count: 1, totalCents: 2500 },
  ]);

  const single = await createFreshPatient(app, "Plan Una Moneda");
  await addItem(app, single, { title: "Uno", priceCents: 1000 });
  await addItem(app, single, { title: "Dos", priceCents: 2000 });
  const singleRes = await app.request(`/patients/${single}/summary`, { method: "GET" });
  expect(singleRes.status).toBe(200);
  const singleBody = (await singleRes.json()) as {
    data: {
      planPending: {
        count: number;
        totalCents: number | null;
        currency: string | null;
        totals: { currency: string; count: number; totalCents: number }[];
      };
    };
  };
  expect(singleBody.data.planPending.totalCents).toBe(3000);
  expect(singleBody.data.planPending.currency).toBe("PEN");
  expect(singleBody.data.planPending.totals).toEqual([{ currency: "PEN", count: 2, totalCents: 3000 }]);
});
