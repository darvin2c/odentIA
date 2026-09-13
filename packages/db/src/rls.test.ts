// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver docs).
// El servicio `podman-api` lo expone; requiere chmod 777 tras (re)crearlo.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAppDb, createOwnerDb, type Db } from "./client.js";
import { withOrgContext } from "./context.js";

// Imagen propia (infra/dev/postgres): trae pgmq + pg_cron, requeridos por la
// migración (pgmq.create) y el init (rol app + extensiones).
const IMAGE = "dentalagent-postgres:18.6";
const APP_ROLE = "dentalagent_app";
const APP_PASSWORD = "dentalagent_app";

let container: StartedTestContainer;
let ownerDb: Db;
let appDb: Db;

async function insertOrg(db: Db, id: string, slug: string) {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, ${"Clínica " + slug}, ${slug}, now())`,
  );
}

async function insertBranch(db: Db, id: string, orgId: string, name: string) {
  await db.execute(
    sql`insert into "branch" ("id", "organization_id", "name")
        values (${id}::uuid, ${orgId}, ${name})`,
  );
}

async function branchNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`select "name" from "branch" order by "name"`);
  return (rows as unknown as { name: string }[]).map((r) => r.name);
}

beforeAll(async () => {
  // GenericContainer en lugar de PostgreSqlContainer: este último inyecta un
  // healthcheck en el CREATE y Podman lo rechaza (sin systemd en la máquina).
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: APP_PASSWORD,
    })
    // Esperar por log: el mensaje aparece dos veces (initdb temporal y final).
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    // pg_cron exige preload; el init hace CREATE EXTENSION.
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start();
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`;
  ownerDb = createOwnerDb(uri);
  await migrate(ownerDb, { migrationsFolder: "./drizzle" });

  appDb = createAppDb(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  );

  await insertOrg(ownerDb, "org_a", "norte");
  await insertOrg(ownerDb, "org_b", "sur");
  await insertBranch(ownerDb, "11111111-1111-1111-1111-111111111111", "org_a", "Sede Lima");
  await insertBranch(ownerDb, "22222222-2222-2222-2222-222222222222", "org_b", "Sede Sur");
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

it("con contexto de org A solo ve la sucursal A", async () => {
  const names = await withOrgContext(appDb, "org_a", (tx) => branchNames(tx));
  expect(names).toEqual(["Sede Lima"]);
});

it("sin contexto de org, el rol app ve 0 filas", async () => {
  expect(await branchNames(appDb)).toEqual([]);
});

it("el rol owner bypasea RLS y ve todas las sucursales", async () => {
  expect(await branchNames(ownerDb)).toEqual(["Sede Lima", "Sede Sur"]);
});
