/**
 * Kairós vigila el alta (ADR 0187), de punta a punta en pantalla: un correo a
 * soporte@ de la propietaria de una clínica en alta trae un CSV; tras una
 * pasada de Kairós, Hoy de Administración pregunta «¿Es la carga de datos?»,
 * «Sí, es la carga» lo marca, Documentos dice cuándo se borra y la ficha ›
 * Alta da por hecho «Datos recibidos». El Embudo › Alta pone la clínica en la
 * columna que dice el servidor, con lo que falta y a quién le toca. «No
 * aplica» se marca con su motivo (solo con el teclado) y se quita. Soporte no
 * ve «Primer pago» ni «Pagó», ni la posible carga ni las tareas solo de
 * Administración, y el servidor le niega marcar la carga. A 390 px el Embudo ›
 * Alta y Hoy no se desbordan de lado.
 *
 * El correo llega como lo manda el worker de Cloudflare (firmado con la clave
 * de pruebas del entorno): no acredita el Email Routing real.
 */
import { createHmac, randomUUID } from "node:crypto"
import { saasClient, saasClientFile, saasTask } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { ADMIN, accountClient, enterAdmin } from "./admin"
import { API } from "./env"
import { api, expect, test } from "./fixtures"

const limaToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())

/** Que la página no se recorra de lado: lo ancho va dentro de su propio desplazamiento. */
async function expectNoSideScroll(page: Page, what: string): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  expect(scroll, `${what}: ancho de la página ${scroll} > ${inner}`).toBeLessThanOrEqual(inner)
}

type AltaBoardBody = {
  data: {
    columns: {
      key: string
      cards: {
        clientId: string
        missing: { words: string } | null
        who: { kind: string; person: { name: string } | null } | null
      }[]
    }[]
  }
}

const COLUMN_TITLES: Record<string, string> = {
  bienvenida: "Bienvenida",
  sus_datos: "Sus datos",
  arranque: "Arranque",
  primer_pago: "Primer pago",
  pago: "Pagó",
}

test("Alta: la posible carga por correo, el Embudo › Alta, «No aplica» con teclado y Soporte sin lo de Administración", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(300_000)
  const { page, user } = owner
  const shot = (p: Page, name: string) =>
    p.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1366, height: 900 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await enterAdmin(page, user.password)

  // --- La clínica en alta: su cuenta, su cliente (de esta persona) y su propietaria ----------
  const tag = randomUUID().slice(0, 6)
  const clinic = await createOwner(`alta${tag}`)
  const clientId = await accountClient(fixtureDb, {
    org: clinic.org,
    product: "dental",
    contact: { name: clinic.user.name, email: clinic.user.email, userId: clinic.user.id },
  })
  await fixtureDb
    .update(saasClient)
    .set({ ownerUserId: user.id })
    .where(eq(saasClient.id, clientId))
  // Una tarea solo de Administración, para ver que Soporte no la recibe.
  const adminTask = `Revisar su contrato ${tag}`
  await fixtureDb.insert(saasTask).values({
    clientId,
    kind: "llamar",
    title: adminTask,
    dueOn: limaToday(),
    assigneeUserId: user.id,
    adminOnly: true,
  })

  // --- Llega el correo a soporte@ con su CSV, firmado como lo firma el worker ---------------
  const filename = `pacientes-${tag}.csv`
  const raw = JSON.stringify({
    mailbox: "soporte",
    product: "dental",
    messageId: `<alta-${tag}@test.dev>`,
    from: clinic.user.email,
    fromName: clinic.user.name,
    to: `soporte@${process.env.E2E_BASE_DOMAIN}`,
    subject: "Les mando nuestros pacientes",
    text: "Hola, adjunto la lista de pacientes de la clínica.",
    receivedAt: new Date().toISOString(),
    attachments: [
      {
        filename,
        contentType: "text/csv",
        base64: Buffer.from("nombre,telefono\nPaciente Ficticio,900000000\n").toString("base64"),
      },
    ],
    senderVerified: true,
  })
  const secret = process.env.INBOUND_EMAIL_SECRET ?? ""
  expect(secret, "el entorno trae INBOUND_EMAIL_SECRET").not.toBe("")
  const timestamp = Math.floor(Date.now() / 1000)
  // Desde el origen de la API en el navegador (Node no resuelve los *.localhost del entorno en
  // Windows): una petición sin cookie ni Origin ajeno, como la del worker.
  const sender = await clinic.context.newPage()
  await sender.goto(`${API}/health`)
  const received = await sender.evaluate(
    async ({ raw, headers }) => {
      const response = await fetch("/api/inbound/email", {
        method: "POST",
        credentials: "omit",
        headers,
        body: raw,
      })
      return { status: response.status, text: await response.text() }
    },
    {
      raw,
      headers: {
        "content-type": "application/json",
        "x-sallca-timestamp": String(timestamp),
        "x-sallca-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex")}`,
      },
    },
  )
  await sender.close()
  expect(received.status, received.text).toBe(201)
  const [file] = await fixtureDb
    .select({ id: saasClientFile.id, kind: saasClientFile.kind })
    .from(saasClientFile)
    .where(and(eq(saasClientFile.clientId, clientId), eq(saasClientFile.filename, filename)))
  expect(file?.kind, "el adjunto quedó en el cliente, todavía como correo").toBe("correo")
  const fileId = file?.id ?? ""

  // --- Una pasada de Kairós, como la pide Administración ------------------------------------
  await page.goto(`${ADMIN}/kairos`)
  await page.getByRole("button", { name: "Correr ahora" }).click()
  await expect(page.getByText("Kairós revisó todo", { exact: false })).toBeVisible()

  // --- Hoy de Administración: «¿Es la carga de datos?» y su tarea -----------------------------
  const question = `¿Es la carga de datos? ${filename}`
  await page.goto(`${ADMIN}/?tareas=todas`)
  await expect(page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  const ask = page.getByRole("listitem").filter({ hasText: question })
  await expect(ask).toBeVisible()
  await expect(ask.getByRole("button", { name: "Sí, es la carga", exact: true })).toBeVisible()
  await expect(page.getByText(adminTask)).toBeVisible()
  await shot(page, "hoy-1366")

  // --- Soporte: sin la posible carga, sin la tarea de Administración ni el marcarla ---------
  const support = await createOwner("soporte")
  await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
  await support.page.setViewportSize({ width: 1366, height: 900 })
  await enterAdmin(support.page, support.user.password)
  await support.page.goto(`${ADMIN}/?tareas=todas`)
  await expect(support.page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  await expect(support.page.getByRole("heading", { name: "Las tareas de hoy" })).toBeVisible()
  await expect(support.page.getByText(question)).toHaveCount(0)
  await expect(support.page.getByText(adminTask)).toHaveCount(0)
  await shot(support.page, "soporte-hoy-1366")
  const supportToday = await api<{ data: unknown }>(
    support.page,
    "GET",
    "/api/admin/kairos/today?who=todas",
    undefined,
  )
  expect(supportToday.status).toBe(200)
  expect(JSON.stringify(supportToday.body)).not.toContain(fileId)
  expect(JSON.stringify(supportToday.body)).not.toContain(adminTask)
  const denied = await api(
    support.page,
    "POST",
    `/api/admin/clients/files/${fileId}/carga`,
    undefined,
    {},
  )
  expect(denied.status).toBe(403)
  // El Embudo › Alta de Soporte: sin «Primer pago» ni «Pagó», ni en pantalla ni en la API.
  await support.page.goto(`${ADMIN}/pipeline?pestana=alta`)
  const supportBoard = support.page.getByRole("region", { name: "Tablero del alta" })
  await expect(supportBoard.getByRole("heading", { name: /^Bienvenida/ })).toBeVisible()
  await expect(supportBoard.getByRole("heading", { name: /^Primer pago/ })).toHaveCount(0)
  await expect(supportBoard.getByRole("heading", { name: /^Pagó/ })).toHaveCount(0)
  await shot(support.page, "soporte-embudo-alta-1366")
  const supportAlta = await api<AltaBoardBody>(
    support.page,
    "GET",
    "/api/admin/clients/pipeline/alta",
    undefined,
  )
  expect(supportAlta.status).toBe(200)
  expect(supportAlta.body.data.columns.map((c) => c.key)).not.toContain("primer_pago")
  expect(supportAlta.body.data.columns.map((c) => c.key)).not.toContain("pago")

  // --- Administración la marca desde Hoy ----------------------------------------------------
  await page.bringToFront()
  await page.reload()
  await page
    .getByRole("listitem")
    .filter({ hasText: question })
    .getByRole("button", { name: "Sí, es la carga", exact: true })
    .click()
  await expect(page.getByText(`${filename} es la carga de datos`, { exact: false })).toBeVisible()
  await expect(page.getByText(question)).toHaveCount(0)

  // --- Documentos: ya es lo que mandó la clínica, con el día en que se borra ----------------
  await page.goto(`${ADMIN}/clients/${clientId}?tab=documentos`)
  const docs = page.getByRole("region", { name: "Documentos" })
  const row = docs.getByRole("listitem").filter({ hasText: filename })
  await expect(row).toContainText("se borra el")
  await expect(row.getByRole("button", { name: "Es la carga de datos" })).toHaveCount(0)
  await shot(page, "documentos-1366")

  // --- Ficha › Alta: «Datos recibidos» hecho -------------------------------------------------
  await page.goto(`${ADMIN}/clients/${clientId}?tab=alta`)
  const steps = page.getByRole("list").filter({ hasText: "Datos recibidos" })
  await expect(steps.getByRole("listitem").filter({ hasText: "Datos recibidos" })).toContainText(
    "Datos recibidos: hecho",
  )
  await shot(page, "ficha-alta-1366")

  // --- «No aplica» en «Equipo dentro», solo con el teclado, y se quita -----------------------
  const equipo = steps.getByRole("listitem").filter({ hasText: "Equipo dentro" })
  await expect(equipo).toContainText("Equipo dentro: falta")
  await equipo.getByRole("button", { name: "Marcar “Equipo dentro” como no aplica" }).focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("alertdialog", { name: "Equipo dentro: no aplica" })
  await expect(dialog).toBeVisible()
  const focusedId = () => page.evaluate(() => document.activeElement?.id ?? "")
  for (let i = 0; i < 8 && (await focusedId()) !== "alta-no-aplica"; i++)
    await page.keyboard.press("Tab")
  expect(await focusedId(), "el motivo se alcanza con Tab").toBe("alta-no-aplica")
  await page.keyboard.press("ControlOrMeta+a")
  const reason = `Trabaja sola, sin equipo ${tag}`
  await page.keyboard.type(reason)
  const confirm = dialog.getByRole("button", { name: "Marcar «No aplica»" })
  for (let i = 0; i < 8; i++) {
    if (await confirm.evaluate((el) => el === document.activeElement)) break
    await page.keyboard.press("Tab")
  }
  await expect(confirm).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(
    page.getByText("Equipo dentro: no aplica. Ya no cuenta entre los pasos."),
  ).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await expect(equipo).toContainText("Equipo dentro: no aplica")
  await expect(equipo).toContainText(reason)
  await shot(page, "ficha-alta-no-aplica-1366")
  await equipo.getByRole("button", { name: "Quitar «No aplica» de “Equipo dentro”" }).click()
  await expect(page.getByText("Equipo dentro: vuelve a contar entre los pasos.")).toBeVisible()
  await expect(equipo).toContainText("Equipo dentro: falta")

  // --- Embudo › Alta (Tablero y Lista): la columna, lo que falta y quién --------------------
  const alta = await api<AltaBoardBody>(page, "GET", "/api/admin/clients/pipeline/alta", undefined)
  expect(alta.status).toBe(200)
  const column = alta.body.data.columns.find((c) =>
    c.cards.some((card) => card.clientId === clientId),
  )
  const card = column?.cards.find((each) => each.clientId === clientId)
  expect(column, "la clínica está en el alta").toBeTruthy()
  expect(column?.key).not.toBe("pago")
  expect(card?.missing, "le falta un paso").toBeTruthy()
  const title = COLUMN_TITLES[column?.key ?? ""] ?? ""
  const missing = `Falta: ${card?.missing?.words ?? ""}`
  const who =
    card?.who?.kind === "clinica"
      ? "Espera a la clínica"
      : card?.who?.kind === "meta"
        ? "Espera a Meta"
        : `Nos toca: ${card?.who?.person?.name || "falta asignar responsable"}`
  await page.goto(`${ADMIN}/pipeline?pestana=alta`)
  const board = page.getByRole("region", { name: "Tablero del alta" })
  const inColumn = board.getByRole("region", { name: new RegExp(`^${title}`) })
  const tile = inColumn.getByRole("link").filter({ hasText: clinic.org.name })
  await expect(tile).toContainText(missing)
  await expect(tile).toContainText(who)
  await expect(board.getByRole("heading", { name: /^Primer pago/ })).toBeVisible()
  await shot(page, "embudo-alta-1366")
  await page.goto(`${ADMIN}/pipeline?pestana=alta&vista=lista`)
  const line = page.getByRole("row").filter({ hasText: clinic.org.name })
  await expect(line).toContainText(title)
  await expect(line).toContainText(who)
  await expect(line).toContainText(card?.missing?.words.slice(1) ?? "")
  await shot(page, "embudo-alta-lista-1366")
  await line.click()
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}.*tab=alta`))

  // --- A 390 px: Embudo › Alta y Hoy sin desbordarse de lado --------------------------------
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${ADMIN}/pipeline?pestana=alta`)
  await expect(page.getByRole("region", { name: "Tablero del alta" })).toBeVisible()
  await expect(page.getByRole("link").filter({ hasText: clinic.org.name })).toBeVisible()
  await expectNoSideScroll(page, "Embudo › Alta")
  await shot(page, "embudo-alta-390")
  await page.goto(`${ADMIN}/pipeline?pestana=alta&vista=lista`)
  await expect(page.getByText(clinic.org.name).first()).toBeVisible()
  await expectNoSideScroll(page, "Embudo › Alta (lista)")
  await shot(page, "embudo-alta-lista-390")
  await page.goto(`${ADMIN}/?tareas=todas`)
  await expect(page.getByText(adminTask)).toBeVisible()
  await expectNoSideScroll(page, "Hoy")
  await shot(page, "hoy-390")
  await page.goto(`${ADMIN}/clients/${clientId}?tab=alta`)
  await expect(page.getByText("Datos recibidos: hecho")).toBeAttached()
  await shot(page, "ficha-alta-390")
  await page.goto(`${ADMIN}/clients/${clientId}?tab=documentos`)
  await expect(page.getByText(filename)).toBeVisible()
  await shot(page, "documentos-390")
  // La ficha y Documentos no tienen tope pedido aquí: se anota su ancho para el informe.
  for (const [name, path] of [
    ["ficha-alta", `?tab=alta`],
    ["documentos", `?tab=documentos`],
  ] as const) {
    await page.goto(`${ADMIN}/clients/${clientId}${path}`)
    await page.waitForLoadState("networkidle")
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    testInfo.annotations.push({ type: "ancho-390", description: `${name}: ${width}` })
  }
})
