import {
  type Db,
  MAX_PHOTO_BYTES,
  STORE_IMAGE_KINDS,
  type StoreImageKind,
  store,
  storeEvent,
  storeImage,
  storeLink,
} from "@gestoria/db"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { noteStoreAccount, noteStoreTeam } from "./acuerdo.js"
import { imageType } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { isTimeZone } from "./hora.js"
import { inStore, StoreError, storeSummary } from "./tiendas.js"

/**
 * Configuración › Datos de la tienda y Tu marca (lienzo «gestorIA como odentIA», tablero 10).
 *
 * - Datos de la tienda: el nombre, el país y la hora de la tienda (ADR 0222). La moneda queda fija
 *   desde que se creó (decisión 9). Un cambio de nombre o de país se le avisa a la administración.
 * - Tu marca, el kit básico de la tienda: el nombre que ve el cliente, el color de marca (cualquier
 *   color vale: los tonos legibles se calculan al mostrarlo, ADR 0162), el logo, la foto de
 *   portada y el nombre del link. Lo usa la app del equipo (su color) y, más adelante, el catálogo.
 *
 * Lo ve todo el equipo (`tienda.ver`, el color pinta su app); lo cambia quien tiene
 * `configuracion`. Cada cambio queda en el registro de la tienda con quién lo hizo.
 */

const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Elige un país de la lista")
  .nullable()

export const storeDataInput = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de tu tienda").max(80, "Máximo 80 caracteres"),
  country,
  timeZone: z.string().trim().refine(isTimeZone, "Elige una hora de la lista"),
})

export async function setStoreData(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof storeDataInput>,
) {
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [before] = await tx
      .select({ name: store.name, country: store.country, timeZone: store.timeZone })
      .from(store)
      .where(eq(store.id, storeId))
    if (!before) throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
    const changed = (Object.keys(input) as Array<keyof typeof input>).filter(
      (key) => before[key] !== input[key],
    )
    if (changed.length === 0) return
    await tx.update(store).set(input).where(eq(store.id, storeId))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.tienda",
      subject: "Datos de la tienda",
      detail: Object.fromEntries(
        changed.map((key) => [key, { antes: before[key], ahora: input[key] }]),
      ),
    })
    // La administración cobra con el nombre y el país; el selector de las clínicas, con el nombre.
    if (changed.includes("name") || changed.includes("country")) await noteStoreAccount(tx, storeId)
    if (changed.includes("name")) await noteStoreTeam(tx, storeId)
  })
  return storeSummary(appDb, person, storeId)
}

/**
 * Los nombres que no puede tomar una tienda (tablero 21): los de gestorIA y los que se usan para
 * engañar (entrar, pagar, verificar). También los que se les parecen: con números en lugar de
 * letras («adm1n»), con guiones o con algo más pegado («pago-facil», «soporte24»).
 */
export const RESERVED_LINK_NAMES = [
  "app",
  "api",
  "servidor",
  "www",
  "admin",
  "acceso",
  "login",
  "cuenta",
  "pago",
  "pagos",
  "soporte",
  "ayuda",
  "seguridad",
  "verificar",
  "gestoria",
] as const

/** Lo más corto y lo más largo que puede ser (lo que cabe en un nombre de dominio). */
export const LINK_NAME_MIN = 3
export const LINK_NAME_MAX = 63

/** Las cifras que se usan por letras: «4dm1n» se lee «admin». */
const LOOKALIKE: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
}

/** Qué tiene mal un nombre del link, dicho a la persona; null si vale. */
export function linkNameProblem(name: string): string | null {
  if (name.length < LINK_NAME_MIN) return `Usa al menos ${LINK_NAME_MIN} letras o números`
  if (name.length > LINK_NAME_MAX) return `Hasta ${LINK_NAME_MAX} letras o números`
  if (!/^[a-z0-9-]+$/.test(name))
    return "Solo letras sin tildes, números y guiones: sin espacios, eñes ni mayúsculas"
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    return "Un guion va solo y entre letras o números"
  const read = name.replace(/[0-9]/g, (digit) => LOOKALIKE[digit] ?? digit)
  const parts = [name, read, ...name.split("-"), ...read.split("-")]
  const bare = (part: string) => part.replace(/[0-9]+$/, "")
  const reserved = RESERVED_LINK_NAMES.some(
    (word) =>
      parts.some((part) => part === word || bare(part) === word) ||
      // gestorIA no se presta, ni pegado a otra palabra.
      (word === "gestoria" && read.replaceAll("-", "").includes(word)),
  )
  return reserved ? "Ese nombre está reservado. Prueba con el de tu tienda." : null
}

const link = z
  .string()
  .trim()
  .toLowerCase()
  .transform((name, ctx) => {
    const problem = linkNameProblem(name)
    if (problem) ctx.addIssue({ code: "custom", message: problem })
    return name
  })

export const brandInput = z.object({
  publicName: z
    .string()
    .trim()
    .max(80, "Máximo 80 caracteres")
    .transform((name) => name || null),
  brandColor: z
    .string()
    .trim()
    .toLowerCase()
    .transform((color) => (color === "" ? null : color.startsWith("#") ? color : `#${color}`))
    .refine((color) => color === null || /^#[0-9a-f]{6}$/.test(color), {
      message: "El código del color tiene 6 cifras, como #BE185D",
    }),
  link: link.nullable(),
})

/** El logo o la portada: su versión (cambia al cambiarla) para que el navegador pida la nueva. */
function imageRef(row: { kind: StoreImageKind; updatedAt: Date } | undefined) {
  return row ? { version: row.updatedAt.getTime() } : null
}

async function brandIn(tx: Db, storeId: string) {
  const [row] = await tx
    .select({ name: store.name, publicName: store.publicName, brandColor: store.brandColor })
    .from(store)
    .where(eq(store.id, storeId))
  if (!row) throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
  const images = await tx
    .select({ kind: storeImage.kind, updatedAt: storeImage.updatedAt })
    .from(storeImage)
    .where(eq(storeImage.storeId, storeId))
  const [current] = await tx
    .select({ name: storeLink.name })
    .from(storeLink)
    .where(and(eq(storeLink.storeId, storeId), eq(storeLink.current, true)))
  return {
    storeName: row.name,
    publicName: row.publicName,
    brandColor: row.brandColor,
    link: current?.name ?? null,
    logo: imageRef(images.find((image) => image.kind === "logo")),
    cover: imageRef(images.find((image) => image.kind === "portada")),
  }
}

export async function storeBrand(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", (tx) => brandIn(tx, storeId))
}

/**
 * Guarda el nombre que ve el cliente, el color y el nombre del link. El nombre del link de antes
 * se queda con la tienda: nadie más lo toma y el catálogo lo llevará al nuevo. Volver a uno propio
 * de antes lo vuelve a usar; uno de otra tienda, no (la base lo rechaza aunque no se vea).
 */
export async function setStoreBrand(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof brandInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const before = await brandIn(tx, storeId)
    const changes: Record<string, { antes: unknown; ahora: unknown }> = {}
    if (before.publicName !== input.publicName || before.brandColor !== input.brandColor) {
      await tx
        .update(store)
        .set({ publicName: input.publicName, brandColor: input.brandColor })
        .where(eq(store.id, storeId))
      if (before.publicName !== input.publicName)
        changes.publicName = { antes: before.publicName, ahora: input.publicName }
      if (before.brandColor !== input.brandColor)
        changes.brandColor = { antes: before.brandColor, ahora: input.brandColor }
    }
    // Un link puesto no se quita: se cambia por otro.
    if (input.link && input.link !== before.link) {
      await tx
        .update(storeLink)
        .set({ current: false })
        .where(and(eq(storeLink.storeId, storeId), eq(storeLink.current, true)))
      const [own] = await tx
        .update(storeLink)
        .set({ current: true })
        .where(and(eq(storeLink.storeId, storeId), eq(storeLink.name, input.link)))
        .returning({ name: storeLink.name })
      if (!own)
        await tx.insert(storeLink).values({ name: input.link, storeId, createdBy: person.userId })
      changes.link = { antes: before.link, ahora: input.link }
    }
    if (Object.keys(changes).length > 0)
      await tx.insert(storeEvent).values({
        storeId,
        actorUserId: person.userId,
        action: "configuracion.marca",
        subject: "Tu marca",
        detail: changes,
      })
    return brandIn(tx, storeId)
  })
}

export function imageKindOf(kind: string): StoreImageKind {
  const found = STORE_IMAGE_KINDS.find((known) => known === kind)
  if (!found) throw new StoreError(404, "NOT_FOUND", "Esa imagen no está")
  return found
}

const IMAGE_NAMES: Record<StoreImageKind, string> = {
  logo: "El logo",
  portada: "La foto de portada",
}

/** Pone el logo o la portada (reemplaza el que había). Se mira por su contenido, no su nombre. */
export async function putStoreImage(
  appDb: Db,
  person: Person,
  storeId: string,
  kind: StoreImageKind,
  bytes: Uint8Array,
) {
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES)
    throw new StoreError(
      400,
      "PHOTO_TOO_LARGE",
      `${IMAGE_NAMES[kind]} pesa demasiado. Prueba con una más chica.`,
    )
  const contentType = imageType(bytes)
  if (!contentType) throw new StoreError(400, "PHOTO_TYPE", "Sube una imagen en JPG, PNG o WebP")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const values = {
      contentType,
      content: Buffer.from(bytes),
      updatedBy: person.userId,
      updatedAt: sql`clock_timestamp()`,
    }
    await tx
      .insert(storeImage)
      .values({ storeId, kind, ...values })
      .onConflictDoUpdate({ target: [storeImage.storeId, storeImage.kind], set: values })
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.marca",
      subject: "Tu marca",
      detail: { [kind]: "cambiado" },
    })
    return brandIn(tx, storeId)
  })
}

export async function removeStoreImage(
  appDb: Db,
  person: Person,
  storeId: string,
  kind: StoreImageKind,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const removed = await tx
      .delete(storeImage)
      .where(and(eq(storeImage.storeId, storeId), eq(storeImage.kind, kind)))
      .returning({ kind: storeImage.kind })
    if (removed.length > 0)
      await tx.insert(storeEvent).values({
        storeId,
        actorUserId: person.userId,
        action: "configuracion.marca",
        subject: "Tu marca",
        detail: { [kind]: "quitado" },
      })
    return brandIn(tx, storeId)
  })
}

export async function storeImageContent(
  appDb: Db,
  person: Person,
  storeId: string,
  kind: StoreImageKind,
) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const [row] = await tx
      .select({ contentType: storeImage.contentType, content: storeImage.content })
      .from(storeImage)
      .where(and(eq(storeImage.storeId, storeId), eq(storeImage.kind, kind)))
    if (!row) throw new StoreError(404, "NOT_FOUND", `${IMAGE_NAMES[kind]} ya no está`)
    return row
  })
}
