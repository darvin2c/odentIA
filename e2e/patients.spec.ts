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
  const [first, ...rest] = user.name.split(" ");
  await page.getByLabel("Nombre").fill(first);
  await page.getByLabel("Apellidos").fill(rest.join(" "));
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

  // La ficha muestra el número de historia clínica asignado.
  await gotoHydrated(pageA, tenant(orgA.slug, `/patients/${patientId}`));
  await expect(pageA.getByText(/HC-\d{6}/).first()).toBeVisible({ timeout: 15_000 });
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

  // Registrar una nota desde el diálogo real de Historia.
  await pageA.getByRole("tab", { name: "Historia", exact: true }).click();
  await pageA.getByRole("button", { name: "Nota rápida", exact: true }).click();
  const noteDialog = pageA.getByRole("dialog", { name: "Nota rápida" });
  await noteDialog.getByLabel("Nota clínica").fill("Se indica endodoncia");
  await noteDialog.getByLabel("Diagnóstico CIE-10").fill("K04.0");
  // El popup del Combobox se portala fuera del diálogo: se busca a nivel de página.
  await pageA.getByRole("option", { name: /K04\.0\s+Pulpitis/ }).click();
  await noteDialog.getByRole("button", { name: "Guardar nota" }).click();
  await expect(noteDialog).not.toBeVisible();
  await expect(pageA.getByText("Se indica endodoncia").first()).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText("K04.0").first()).toBeVisible();

  // Odontograma: pieza 16 con caries en oclusal; persiste tras recargar.
  const entry = await api(pageA, "POST", `/api/patients/${patientId}/odontogram/entries`, orgA.slug, {
    toothNumber: 16,
    condition: "caries",
    surfaces: ["oclusal"],
  });
  expect(entry.status).toBe(201);
  await pageA.getByRole("tab", { name: "Odontograma", exact: true }).click();
  await expect(pageA.getByRole("button", { name: /^Pieza 16: Caries \(Oclusal\)/ })).toBeVisible({ timeout: 15_000 });
  await pageA.reload();
  await waitForHydration(pageA);
  await pageA.getByRole("tab", { name: "Odontograma", exact: true }).click();
  await expect(pageA.getByRole("button", { name: /^Pieza 16: Caries \(Oclusal\)/ })).toBeVisible();

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

test("paciente plus: wizard, avatar, atención, plan", async ({ page }) => {
  const user = { name: "Denta Plus", email: `denta-plus-${run}@test.dev`, password: "secreto-123" };
  const org = { name: "Clínica Plus", slug: `clinica-plus-${run}` };
  await register(page, user);
  await verifyEmail(page, user.email);
  await login(page, user);
  await onboard(page, org);

  await gotoHydrated(page, tenant(org.slug, "/patients/new"));
  await page.getByLabel("Nombre del paciente").fill("Lucía Quispe");
  await page.getByRole("combobox", { name: "Tipo de documento" }).click();
  await page.getByRole("option", { name: "DNI", exact: true }).click();
  await page.getByLabel("Número de documento").fill("87654321");
  await page.getByLabel("Teléfono", { exact: true }).fill("999432198");
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await page.getByLabel("Dirección", { exact: true }).fill("Av. Salud 123");
  await page.getByRole("button", { name: "Registrar paciente", exact: true }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}\/triaje$/);
  const patientId = new URL(page.url()).pathname.split("/").at(-2)!;
  await page.getByRole("button", { name: "Agregar alergia" }).click();
  await page.getByLabel("Sustancia").fill("Látex");
  await page.getByRole("combobox", { name: "Severidad" }).click();
  await page.getByRole("option", { name: "Severa", exact: true }).click();
  await page.getByLabel("Motivo de consulta").fill("Dolor en molar inferior");
  await page.getByRole("button", { name: "Guardar triaje", exact: true }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}(?:\?|$)/);
  await expect(page.getByText(/HC-\d{6}/).first()).toBeVisible();
  await expect(page.getByText("Alergia: Látex (severa)", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Historia", exact: true }).click();
  await expect(page.getByText("Dolor en molar inferior", { exact: true })).toBeVisible();

  const uploaded = await page.evaluate(async ({ apiBase, patientId, slug }) => {
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0d9488";
    context.fillRect(0, 0, 64, 64);
    const form = new FormData();
    form.append("file", await canvas.convertToBlob({ type: "image/png" }), "avatar.png");
    const response = await fetch(`${apiBase}/api/patients/${patientId}/avatar`, {
      method: "POST",
      credentials: "include",
      headers: { "x-odentia-org": slug },
      body: form,
    });
    return response.status;
  }, { apiBase: API, patientId, slug: org.slug });
  expect(uploaded).toBe(201);
  await page.reload();
  await waitForHydration(page);
  await expect(page.locator("header").getByRole("img", { name: "Foto de Lucía Quispe" })).toBeVisible();

  const plan = await api<{ data: { id: string } }>(page, "POST", `/api/patients/${patientId}/plan/items`, org.slug, {
    title: "Endodoncia de molar",
    toothNumber: 36,
    diagnosisCode: "K04.0",
    priceCents: 25000,
    currency: "PEN",
  });
  expect(plan.status).toBe(201);
  const encounter = await api<{ data: { id: string } }>(page, "POST", `/api/patients/${patientId}/encounters`, org.slug, {
    reason: "Tratamiento endodóntico",
  });
  expect(encounter.status).toBe(201);
  const encounterPath = `/api/patients/${patientId}/encounters/${encounter.body.data.id}`;

  // Regresión: guardar sin cambios no debe bloquear el siguiente autoguardado.
  await gotoHydrated(page, tenant(org.slug, `/patients/${patientId}/encounters/${encounter.body.data.id}`));
  const saveDraft = page.getByRole("button", { name: "Guardar borrador", exact: true });
  await saveDraft.click();
  await expect(saveDraft).toBeEnabled();
  const saved = page.waitForResponse((response) =>
    response.url() === `${API}${encounterPath}` && response.request().method() === "PATCH",
  );
  await page.getByLabel("Evolución (máx. 10000)").fill("Tratamiento realizado sin complicaciones");
  await saved;
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByLabel("Evolución (máx. 10000)")).toHaveValue("Tratamiento realizado sin complicaciones");

  const procedure = await api(page, "POST", `${encounterPath}/procedures`, org.slug, {
    description: "Endodoncia de molar completada",
    toothNumber: 36,
    diagnosisCode: "K04.0",
    planItemId: plan.body.data.id,
  });
  expect(procedure.status).toBe(201);
  const finalized = await api(page, "POST", `${encounterPath}/finalize`, org.slug, {});
  expect(finalized.status).toBe(200);

  await gotoHydrated(page, tenant(org.slug, `/patients/${patientId}?tab=historia`));
  await expect(page.getByText("Tratamiento endodóntico", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Expandir", exact: true }).click();
  await expect(page.getByText("Endodoncia de molar completada", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Tratamiento realizado sin complicaciones", { exact: true }).first()).toBeVisible();

  // Agrupación por tratamiento: secciones por atención + generales.
  await page.getByRole("button", { name: "Tratamiento", exact: true }).click();
  await expect(page.getByRole("heading").filter({ hasText: /^Atención / }).first()).toBeVisible();
  await expect(page.getByText("Generales", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Día", exact: true }).click();
  await expect(page.getByText("Generales", { exact: true })).toBeHidden();

  // Subida de imagen desde la UI: drawer con dropzone y galería con Attachment.
  await page.getByRole("tab", { name: "Imágenes", exact: true }).click();
  await page.getByRole("button", { name: "Subir imagen o documento", exact: true }).click();
  const uploadDrawer = page.getByRole("dialog", { name: "Subir imagen o documento" });
  await uploadDrawer.locator('input[type="file"]').setInputFiles({
    name: "rx-control.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await uploadDrawer.getByLabel("Etiqueta").fill("RX de control");
  await uploadDrawer.getByRole("button", { name: "Subir", exact: true }).click();
  await expect(uploadDrawer).toBeHidden();
  await expect(page.getByText("RX de control", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Plan", exact: true }).click();
  const item = page.getByRole("row").filter({ hasText: "Endodoncia de molar" });
  await expect(item.getByText("Realizado", { exact: true })).toBeVisible();
});
