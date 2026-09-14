process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { createAppDb, createOwnerDb, withOrgContext, type Db } from "@odentia/db";
import { createPatient, secretsKeyFromEnv } from "@odentia/services";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Hono, type Next } from "hono";
import type { Context } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createCie10Route } from "./cie10.js";
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
  app.route("/cie10", createCie10Route(deps));
  return app;
}

let patientId = "";

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

it("pacientes: POST 201 y GET 200", async () => {
  const app = buildApp("member");
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "María Pérez", docType: "DNI", docNumber: "12345678" }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { data: { id: string; patientNumber: number } };
  expect(body.data.patientNumber).toBe(1);
  patientId = body.data.id;

  const list = await app.request("/patients", { method: "GET" });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as { data: { id: string }[] };
  expect(listed.data.map((p) => p.id)).toContain(patientId);

  const detail = await app.request(`/patients/${patientId}`, { method: "GET" });
  expect(detail.status).toBe(200);
});

it("cross-org: paciente de B responde 404 en A", async () => {
  const other = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", "u-1", { displayName: "Paciente B" }),
  );
  const app = buildApp("member");
  const res = await app.request(`/patients/${other.id}`, { method: "GET" });
  expect(res.status).toBe(404);
});

it("POST /:id/notes como member responde 201 (sin gate canWrite)", async () => {
  const app = buildApp("member");
  const res = await app.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Se indica endodoncia", diagnosisCode: "K04.0" }),
  });
  expect(res.status).toBe(201);
});

it("GET /cie10?q=caries devuelve resultados", async () => {
  const app = buildApp("member");
  const res = await app.request("/cie10?q=caries", { method: "GET" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { code: string }[] };
  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data[0]!.code).toBe("K02.1");
});

it("anamnesis con clave desconocida responde 400 (strict)", async () => {
  const app = buildApp("member");
  const res = await app.request(`/patients/${patientId}/anamnesis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { claveDesconocida: "x" } }),
  });
  expect(res.status).toBe(400);
});

it("odontograma con pieza inválida responde 400", async () => {
  const app = buildApp("member");
  const res = await app.request(`/patients/${patientId}/odontogram/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toothNumber: 99, condition: "caries", surfaces: [] }),
  });
  expect(res.status).toBe(400);
});
