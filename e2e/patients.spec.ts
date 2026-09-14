import { expect, test, type Page } from "@playwright/test";
import { latestLinkFor } from "./mailpit";

const API = "https://api.odentia.localhost";
const run = Date.now().toString(36);

const userA = { name: "Denta A", email: `denta-a-${run}@test.dev`, password: "secreto-123" };
const userB = { name: "Denta B", email: `denta-b-${run}@test.dev`, password: "secreto-123" };
const orgA = { name: "Clínica A", slug: `clinica-pa-${run}` };
const orgB = { name: "Clínica B", slug: `clinica-pb-${run}` };

const tenant = (slug: string, path: string) => `https://${slug}.odentia.localhost${path}`;

const hasFiber = () => {
  for (const el of [document.documentElement, document.body, ...document.body.children]) {
    if (el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))) return true;
  }
  return false;
};

async function waitForHydration(page: Page) {
  for (;;) {
    await page.waitForFunction(hasFiber, null, { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const stable = await page.evaluate(hasFiber).catch(() => false);
    if (stable) return;
  }
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  await waitForHydration(page);
}

async function register(page: Page, user: typeof userA) {
  await gotoHydrated(page, "/register");
  await page.getByLabel("Nombre").fill(user.name);
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña").fill(user.password);
  await page.getByRole("button", { name: "Registrarme" }).click();
  await expect(page).toHaveURL(/verify-email-sent/);
}

async function verifyEmail(page: Page, email: string) {
  const link = await latestLinkFor(email, "Verifica tu correo");
  await page.goto(link);
}

async function login(page: Page, user: typeof userA) {
  await gotoHydrated(page, "/login");
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña").fill(user.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

async function onboard(page: Page, org: typeof orgA) {
  await expect(page).toHaveURL(/onboarding/);
  await page.getByLabel("Nombre de la organización").fill(org.name);
  await page.getByLabel("Slug (subdominio)").fill(org.slug);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByLabel("Razón social").fill(`${org.name} S.A.C.`);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByLabel("Nombre de la sucursal").fill("Sede Central");
  await page.getByRole("button", { name: "Crear organización" }).click();
  await expect(page).toHaveURL(new RegExp(`^https://${org.slug}\\.odentia\\.localhost/branches`));
}

// Llamadas API desde el navegador (*.odentia.localhost no resuelve en Node/WSL).
async function api<T>(page: Page, method: string, path: string, slug: string, body?: unknown) {
  return page.evaluate(
    async ({ apiBase, method, path, slug, body }) => {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-odentia-org": slug },
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as T };
    },
    { apiBase: API, method, path, slug, body },
  );
}

test("pacientes: ficha clínica, alertas, nota CIE-10, odontograma y aislamiento", async ({ browser }) => {
  test.setTimeout(600_000);
  const contextA = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageA = await contextA.newPage();
  await register(pageA, userA);
  await verifyEmail(pageA, userA.email);
  await login(pageA, userA);
  await onboard(pageA, orgA);

  // Crear contacto y verificar la sección Paciente en su detalle.
  const contact = await api<{ data: { id: string } }>(pageA, "POST", "/api/contacts", orgA.slug, {
    displayName: "María Pérez",
  });
  expect(contact.status).toBe(201);
  const contactId = contact.body.data.id;

  await gotoHydrated(pageA, tenant(orgA.slug, `/contacts/${contactId}`));
  await expect(pageA.getByRole("button", { name: "Convertir en paciente" })).toBeVisible({ timeout: 15_000 });

  // Convertir en paciente con DNI.
  const patient = await api<{ data: { id: string; patientNumber: number } }>(
    pageA,
    "POST",
    "/api/patients",
    orgA.slug,
    { contactId, docType: "DNI", docNumber: "12345678" },
  );
  expect(patient.status).toBe(201);
  const patientId = patient.body.data.id;
  expect(patient.body.data.patientNumber).toBe(1);

  // La ficha muestra HC-000001.
  await gotoHydrated(pageA, tenant(orgA.slug, `/patients/${patientId}`));
  await expect(pageA.getByText("HC-000001").first()).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText("María Pérez").first()).toBeVisible();

  // Alta de alergia severa → chip rojo visible en Resumen.
  const allergy = await api(pageA, "POST", `/api/patients/${patientId}/allergies`, orgA.slug, {
    substance: "Penicilina",
    severity: "severa",
  });
  expect(allergy.status).toBe(201);
  await pageA.reload();
  await waitForHydration(pageA);
  await expect(pageA.getByText("Penicilina").first()).toBeVisible({ timeout: 15_000 });

  // Nota de evolución con diagnóstico CIE-10.
  const note = await api(pageA, "POST", `/api/patients/${patientId}/notes`, orgA.slug, {
    note: "Se indica endodoncia",
    diagnosisCode: "K04.0",
  });
  expect(note.status).toBe(201);
  await pageA.getByRole("button", { name: "Evoluciones" }).click();
  await expect(pageA.getByText("Se indica endodoncia").first()).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText("K04.0").first()).toBeVisible();

  // Odontograma: pieza 16 con caries en oclusal; persiste tras recargar.
  const entry = await api(pageA, "POST", `/api/patients/${patientId}/odontogram/entries`, orgA.slug, {
    toothNumber: 16,
    condition: "caries",
    surfaces: ["oclusal"],
  });
  expect(entry.status).toBe(201);
  await pageA.getByRole("button", { name: "Odontograma" }).click();
  await expect(pageA.getByText("16").first()).toBeVisible({ timeout: 15_000 });
  await pageA.reload();
  await waitForHydration(pageA);
  await pageA.getByRole("button", { name: "Odontograma" }).click();
  const odonto = await api<{ data: { teeth: Record<string, unknown> } }>(
    pageA,
    "GET",
    `/api/patients/${patientId}/odontogram`,
    orgA.slug,
  );
  expect(Object.keys(odonto.body.data.teeth)).toContain("16");

  // Aislamiento: org B no ve el paciente (lista vacía + 404).
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageB = await contextB.newPage();
  await register(pageB, userB);
  await verifyEmail(pageB, userB.email);
  await login(pageB, userB);
  await onboard(pageB, orgB);
  const listB = await api<{ data: unknown[] }>(pageB, "GET", "/api/patients", orgB.slug);
  expect(listB.body.data).toEqual([]);
  const cross = await api(pageB, "GET", `/api/patients/${patientId}`, orgB.slug);
  expect(cross.status).toBe(404);

  await contextA.close();
  await contextB.close();
});
