/**
 * Lo común de los recorridos de la administración (el ARM, ADR 0184): entrar
 * con su segundo factor desde la pantalla real y el cliente de una cuenta de
 * prueba.
 */
import { createHmac } from "node:crypto"
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasClient, saasClientContact } from "@odentia/db/schema/admin-arm"
import { expect, type Locator, type Page } from "@playwright/test"
import { hostUrl } from "./env"

export const ADMIN = hostUrl("admin")

/** El código TOTP de ahora (RFC 6238, SHA-1, 30 s, 6 cifras) para una clave en base32. */
export function totpNow(base32: string): string {
  let bits = ""
  for (const char of base32.replace(/\s|=/g, "").toUpperCase())
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [])
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const mac = createHmac("sha1", key).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0xf
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

/** Enrola el segundo factor con la clave escrita y entra, como lo hace una persona del equipo. */
export async function enterAdmin(page: Page, password: string): Promise<void> {
  await page.goto(`${ADMIN}/security`)
  await page.getByLabel("Contraseña").fill(password)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByRole("button", { name: /No puedes escanear/ }).click()
  const secret = (await page.locator("code").first().textContent()) ?? ""
  await page.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Entrar a la administración" }).click()
  await expect(page).not.toHaveURL(/\/security/)
}

/**
 * Una superficie lateral por su título: con la columna lateral libre va ahí
 * (una región); si no, en cajón (un diálogo).
 */
export function surface(page: Page, name: string | RegExp): Locator {
  const exact = typeof name === "string"
  return page.getByRole("dialog", { name, exact }).or(page.getByRole("region", { name, exact }))
}

/**
 * El cliente de una cuenta de prueba, como lo deja Kairós con la regla
 * «cuenta sin cliente» (`clientForOrganization`): su nombre, su producto y la
 * cuenta ligada. Aquí no se espera a su pasada (cada 5 minutos) ni se corre
 * para todas las cuentas de la base, que son de otras pruebas: se deja solo el
 * de esta. Si la pasada ya lo creó, se queda ese con el producto pedido. Con
 * `contact`, esa persona queda como su contacto principal.
 */
export async function accountClient(
  db: Db,
  input: {
    org: { id: string; name: string }
    product: ClinicalProduct
    contact?: { name: string; email: string; userId?: string }
  },
): Promise<string> {
  const [client] = await db
    .insert(saasClient)
    .values({ name: input.org.name, product: input.product, organizationId: input.org.id })
    .onConflictDoUpdate({ target: saasClient.organizationId, set: { product: input.product } })
    .returning({ id: saasClient.id })
  if (!client) throw new Error("No quedó el cliente de la cuenta")
  if (input.contact)
    await db.insert(saasClientContact).values({
      clientId: client.id,
      name: input.contact.name,
      email: input.contact.email.toLowerCase(),
      userId: input.contact.userId ?? null,
      roles: ["decide"],
      isPrimary: true,
    })
  return client.id
}
