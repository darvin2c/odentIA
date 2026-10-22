import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { clinicalNote, patient } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Buscador rápido (ADR 0066): Ctrl+K o «Buscar en todo» desde cualquier
 * pantalla, cada resultado debajo de su dueño y Enter directo a lo elegido.
 * Cada rol ve lo de su pantalla: lo decide el servidor.
 */

async function observe(page: Page, info: TestInfo, name: string) {
  // Lo que se sale del ancho, con su nombre, para saber qué arreglar.
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 80)} «${(el.textContent ?? "").trim().slice(0, 30)}»`,
      ),
  )
  expect(wide, `se sale del ancho en ${name}`).toEqual([])
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
}

/** Lucía (paciente, con una nota clínica), su madre con el mismo teléfono y una persona que escribió por WhatsApp. */
async function people(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const [lucia] = await db
    .insert(contact)
    .values({ organizationId, displayName: "Lucía Quispe", phone: "+51987654321" })
    .returning()
  const [ficha] = await db
    .insert(patient)
    .values({ organizationId, personId: lucia!.id, patientNumber: 1 })
    .returning()
  await db
    .insert(contact)
    .values({ organizationId, displayName: "Rosa Huamán", phone: "+51987654321" })
  await db
    .insert(clinicalNote)
    .values({
      organizationId,
      patientId: ficha!.id,
      authorUserId: owner.user.id,
      note: "Refiere bruxismo nocturno.",
    })
  const [lead] = await db
    .insert(contact)
    .values({ organizationId, displayName: "Marta Ríos" })
    .returning()
  const connectionId = randomUUID()
  await db
    .insert(channelConnection)
    .values({
      id: connectionId,
      organizationId,
      channel: "whatsapp",
      provider: "prueba",
      displayName: "WhatsApp",
      configEncrypted: "no-se-usa",
      webhookSecret: "no-se-usa",
    })
  const [thread] = await db
    .insert(conversation)
    .values({
      organizationId,
      contactId: lead!.id,
      channelConnectionId: connectionId,
      externalThreadId: "51911222333",
    })
    .returning()
  await db
    .insert(message)
    .values({
      organizationId,
      conversationId: thread!.id,
      direction: "in",
      senderKind: "contact",
      body: "¿Cuánto cuesta el blanqueamiento?",
    })
  return { luciaId: lucia!.id, conversationId: thread!.id }
}

const setRole = (db: Db, owner: OwnerFixture, role: string) =>
  db
    .update(member)
    .set({ role })
    .where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))

const dialog = (page: Page) => page.getByRole("dialog", { name: "Buscar en todo" })
/**
 * Ctrl+K lo escucha el layout de la clínica. La raíz marca la página como
 * hidratada antes de que ese layout termine de montarse (el botón ya se ve,
 * venido del servidor), y la tecla de ese momento se pierde: se vuelve a
 * pulsar mientras la ventana no abre. Si el atajo no funciona, igual falla.
 */
async function pressSearchShortcut(page: Page) {
  await expect(async () => {
    if (!(await dialog(page).isVisible())) await page.keyboard.press("Control+K")
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
}
/** Escribe en la ventana ya abierta (lo tecleado antes de que abra no cuenta). */
async function search(page: Page, text: string) {
  await expect(dialog(page)).toBeVisible()
  await page.getByRole("combobox", { name: "Buscar en todo" }).fill(text)
}

test("Ctrl+K desde cualquier pantalla: «lucia» encuentra a Lucía con lo suyo y Enter abre su ficha", async ({
  owner,
  fixtureDb,
}, info) => {
  const { luciaId } = await people(fixtureDb, owner)
  const page = owner.page
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/tasks"))

  await pressSearchShortcut(page)
  await expect(dialog(page)).toBeVisible()
  await search(page, "lucia")
  const result = dialog(page)
    .getByRole("option", { name: /Lucía Quispe/ })
    .first()
  await expect(result).toBeVisible()
  // Buscar nunca identifica: por el teléfono salen madre e hija.
  await page.getByRole("combobox", { name: "Buscar en todo" }).fill("987 654")
  await expect(dialog(page).getByRole("option", { name: /Rosa Huamán/ })).toBeVisible()
  await expect(
    dialog(page)
      .getByRole("option", { name: /Lucía Quispe/ })
      .first(),
  ).toBeVisible()
  await observe(page, info, "buscador-telefono-escritorio.png")

  await page.getByRole("combobox", { name: "Buscar en todo" }).fill("lucia")
  await expect(result).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/people/${luciaId}`))
  await expect(dialog(page)).toBeHidden()

  // Lo abierto hace poco aparece al volver a abrir, y Esc cierra.
  await page.getByRole("button", { name: "Buscar en todo" }).click()
  await expect(dialog(page).getByRole("option", { name: /Lucía Quispe/ })).toBeVisible()
  await observe(page, info, "buscador-sin-escribir.png")
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toBeHidden()
})

test("lo que dicen los mensajes aparece debajo de quien lo escribió y lleva a la conversación", async ({
  owner,
  fixtureDb,
}, info) => {
  const { conversationId } = await people(fixtureDb, owner)
  const page = owner.page
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/home"))
  await pressSearchShortcut(page)
  await search(page, "blanqueamiento")
  await expect(dialog(page).getByRole("option", { name: /Marta Ríos/ })).toBeVisible()
  // Lo elegido al llegar los resultados es lo primero que se encontró, no «Preguntarle a Ayuda».
  await expect(dialog(page).getByRole("option", { name: /Marta Ríos/ })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  const said = dialog(page).getByRole("option", { name: /Mensaje.*blanqueamiento/ })
  await expect(said).toBeVisible()
  await observe(page, info, "buscador-mensajes.png")
  await said.click()
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
})

test("cada rol ve lo de su pantalla: recepción no ve la historia clínica, el odontólogo sí", async ({
  owner,
  fixtureDb,
}) => {
  await people(fixtureDb, owner)
  const page = owner.page
  await setRole(fixtureDb, owner, "reception")
  await gotoHydrated(page, tenant(owner.org.slug, "/home"))
  await pressSearchShortcut(page)
  await search(page, "bruxismo")
  await expect(dialog(page).getByText("No encontramos «bruxismo».")).toBeVisible()
  await expect(dialog(page).getByRole("option", { name: /Preguntarle a Ayuda/ })).toBeVisible()

  await setRole(fixtureDb, owner, "clinician")
  await gotoHydrated(page, tenant(owner.org.slug, "/home"))
  await pressSearchShortcut(page)
  await search(page, "bruxismo")
  await expect(dialog(page).getByRole("option", { name: /Nota.*bruxismo/ })).toBeVisible()
})

test("en el teléfono: la lupa de la cabecera abre la búsqueda a pantalla completa", async ({
  owner,
  fixtureDb,
}, info) => {
  await people(fixtureDb, owner)
  const page = owner.page
  await page.setViewportSize({ width: 375, height: 812 })
  await gotoHydrated(page, tenant(owner.org.slug, "/people"))
  // La lupa entra en la cabecera sin empujar nada fuera de la pantalla.
  await observe(page, info, "pacientes-telefono.png")
  await page.getByRole("button", { name: "Buscar en todo" }).click()
  await expect(dialog(page)).toBeVisible()
  const box = await dialog(page).boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(370)
  await page.getByRole("combobox", { name: "Buscar en todo" }).fill("lucia")
  await expect(
    dialog(page)
      .getByRole("option", { name: /Lucía Quispe/ })
      .first(),
  ).toBeVisible()
  await observe(page, info, "buscador-telefono.png")
  await dialog(page).getByRole("button", { name: "Cerrar" }).click()
  await expect(dialog(page)).toBeHidden()
})
