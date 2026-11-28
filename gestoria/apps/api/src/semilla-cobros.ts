import { crc32, deflateSync } from "node:zlib"
import { type Db, storePaymentLink, storePaymentMethod, storePaymentQr } from "@gestoria/db"
import { and, eq, inArray } from "drizzle-orm"
import { readSecretsKey, sealSecret } from "./secretos.js"

/**
 * Cobros de Calzados Rosa (lienzo «gestorIA · Configuración, de nuevo», tablero 6): el QR de su
 * Yape y de su Plin y, si el servidor tiene la llave de las credenciales, su Mercado Pago conectado
 * en modo prueba (con un token de mentira: crear el link de S/ 1 dirá que Mercado Pago no lo
 * reconoce). Solo para desarrollo y demostraciones, como el resto de `semilla.ts`.
 */

const OWNER = "semilla-rosa"

/**
 * Un QR de ejemplo, hecho aquí: los tres cuadros de las esquinas y módulos al azar (siempre los
 * mismos). Se ve como un QR, pero no lleva a ninguna parte.
 */
export function demoQrPng(): Buffer {
  const modules = 29
  const scale = 8
  const quiet = 4
  const size = (modules + quiet * 2) * scale
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const dark: boolean[][] = Array.from({ length: modules }, () =>
    Array.from({ length: modules }, () => random() < 0.48),
  )
  const finder = (top: number, left: number) => {
    for (let y = -1; y <= 7; y++)
      for (let x = -1; x <= 7; x++) {
        const row = top + y
        const col = left + x
        if (row < 0 || col < 0 || row >= modules || col >= modules) continue
        const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3))
        dark[row]![col] = ring !== 2 && ring !== 4
      }
  }
  finder(0, 0)
  finder(0, modules - 7)
  finder(modules - 7, 0)
  const rows: Buffer[] = []
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(size + 1, 255)
    row[0] = 0
    const my = Math.floor(py / scale) - quiet
    for (let px = 0; px < size; px++) {
      const mx = Math.floor(px / scale) - quiet
      if (my >= 0 && mx >= 0 && my < modules && mx < modules && dark[my]![mx]) row[1 + px] = 24
    }
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.writeUInt8(8, 8) // 8 bits
  header.writeUInt8(0, 9) // escala de grises
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export async function seedDemoPayments(
  tx: Db,
  storeId: string,
  secretsKey: Buffer | null = readSecretsKey(process.env.GESTORIA_SECRETS_KEY),
): Promise<void> {
  const wallets = await tx
    .select({ id: storePaymentMethod.id })
    .from(storePaymentMethod)
    .where(
      and(
        eq(storePaymentMethod.storeId, storeId),
        inArray(storePaymentMethod.kind, ["yape", "plin"]),
      ),
    )
  const qr = demoQrPng()
  for (const wallet of wallets)
    await tx
      .insert(storePaymentQr)
      .values({
        storeId,
        methodId: wallet.id,
        contentType: "image/png",
        content: qr,
        updatedBy: OWNER,
      })
      .onConflictDoNothing()
  if (!secretsKey) return
  // Conectada con sus claves (el Access Token de prueba de su propia aplicación), como se conecta
  // hoy sin la aplicación de gestorIA en Mercado Pago. El token es inventado: la revisión de cada
  // día no lo mira (`checked_at` lejano), si no la demo quedaría «sin permiso».
  const token = "TEST-0000000000000000-semilla-calzados-rosa"
  await tx
    .insert(storePaymentLink)
    .values({
      storeId,
      provider: "mercadopago",
      accessTokenEnc: sealSecret(secretsKey, storeId, token),
      connectedWith: "claves",
      checkedAt: new Date("2100-01-01T00:00:00Z"),
      mode: "prueba",
      providerUserId: "0",
      accountLabel: "rosa.quispe@…",
      hint: token.slice(-4),
      connectedBy: OWNER,
    })
    .onConflictDoNothing()
}
