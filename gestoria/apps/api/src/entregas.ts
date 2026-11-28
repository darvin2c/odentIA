import {
  type Db,
  type DeliverySlot,
  type DeliveryZone,
  FAILED_TRIPS,
  type FailedTrip,
  MAX_DELIVERY_SLOTS,
  store,
  storeDeliveryMethod,
  storeEvent,
  ZONE_LEADS,
} from "@gestoria/db"
import { and, asc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { DISTRICT_BY_CODE, DISTRICTS, type District, isDistrict } from "./distritos.js"
import { addDays, dayIn, storeClockIn, weekdayOf } from "./hora.js"
import { slotLabel, sortSlots, storeSlotsIn } from "./repartidores.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Entregas por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7; ADR 0233). Las
 * formas de entrega siguen siendo `DeliveryMethod` de Schema.org; lo nuevo:
 *
 * - Cada zona del reparto guarda sus distritos por su código UBIGEO del INEI (`distritos.ts`):
 *   nadie los escribe. Un distrito está en una sola zona en toda la tienda (`checkZonesIn`).
 * - La zona tiene precio, cuándo llega (hoy antes de la hora de corte, al día siguiente o en
 *   días fijos, en la hora de la tienda), sus franjas (de las de la tienda, las de Despachos), si
 *   acepta pago al recibir y si le alcanza el envío gratis.
 * - El precio de un envío sale de una sola regla (`deliveryPriceOf`), la misma para «Anotar un
 *   pedido», «Cambiar», un cambio o devolución y Sofi.
 */

/* ------------------------------------------------------------------------- las zonas */

const minute = z
  .number()
  .int("Elige una hora")
  .min(0)
  .max(24 * 60)
const slot = z
  .object({ start: minute, end: minute })
  .refine((s) => s.start < s.end, { message: "La franja termina después de empezar" })
const weekday = z.number().int().min(1).max(7)

/**
 * Una zona, como llega del navegador. Lo de antes (solo nombre y precio) sigue valiendo: el
 * resto toma su valor de siempre (sin distritos, al día siguiente, con envío gratis). El pago al
 * recibir, si no viene, es el de su forma de entrega (`deliveryInput` lo completa).
 */
export const zoneInput = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre de la zona").max(60),
    priceCents: z.number().int("Escribe un monto válido").min(0).max(100_000_000),
    districts: z
      .array(z.string().refine(isDistrict, "Ese distrito no está en la lista oficial"))
      .max(60)
      .optional(),
    lead: z.enum(ZONE_LEADS).default("manana"),
    cutoff: minute.nullable().default(null),
    weekdays: z.array(weekday).max(7).default([]),
    slots: z.array(slot).max(MAX_DELIVERY_SLOTS).default([]),
    payOnDelivery: z.boolean().optional(),
    freeShipping: z.boolean().default(true),
  })
  .superRefine((zone, ctx) => {
    if (zone.lead === "hoy" && zone.cutoff === null)
      ctx.addIssue({ code: "custom", path: ["cutoff"], message: "Elige hasta qué hora es hoy" })
    if (zone.lead === "dias" && zone.weekdays.length === 0)
      ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Elige qué días vas" })
  })
  .transform((zone) => ({
    ...zone,
    cutoff: zone.lead === "hoy" ? zone.cutoff : null,
    weekdays: zone.lead === "dias" ? [...new Set(zone.weekdays)].sort() : [],
    slots: sortSlots(zone.slots),
  }))

/** Las zonas de una forma de entrega: nombres distintos y cada distrito una sola vez. */
export function zonesProblem(zones: { name: string; districts?: string[] }[]): {
  path: (string | number)[]
  message: string
} | null {
  const names = new Set<string>()
  const seen = new Map<string, string>()
  for (const [i, zone] of zones.entries()) {
    const key = zone.name.toLocaleLowerCase("es")
    if (names.has(key))
      return { path: ["zones", i, "name"], message: "Ya hay una zona con ese nombre" }
    names.add(key)
    for (const code of zone.districts ?? []) {
      const other = seen.get(code)
      if (other)
        return {
          path: ["zones", i, "districts"],
          message: `${DISTRICT_BY_CODE.get(code)?.short ?? code} ya está en «${other}»`,
        }
      seen.set(code, zone.name)
    }
  }
  return null
}

/**
 * Antes de guardar las zonas de una forma de entrega: ningún distrito suyo está en otra forma de
 * la tienda. Devuelve las zonas listas para guardar: lo que no trae una zona de antes (una pantalla
 * vieja que manda solo nombre y precio) se queda como estaba guardado en la zona del mismo nombre,
 * y las franjas que la tienda ya no tiene se quitan. Bloquea la tienda mientras dura la
 * transacción: dos cambios a la vez no dejan un distrito en dos zonas.
 */
export async function checkZonesIn(
  tx: Db,
  storeId: string,
  methodId: string | null,
  sent: ZoneSent[],
): Promise<DeliveryZone[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`entregas:${storeId}`}))`)
  const methods = await tx
    .select({
      id: storeDeliveryMethod.id,
      name: storeDeliveryMethod.name,
      zones: storeDeliveryMethod.zones,
    })
    .from(storeDeliveryMethod)
    .where(eq(storeDeliveryMethod.storeId, storeId))
  const saved = new Map(
    (methods.find((m) => m.id === methodId)?.zones ?? []).map((zone) => [zone.name, zone]),
  )
  const mine = new Set((await storeSlotsIn(tx, storeId)).map((s) => `${s.start}-${s.end}`))
  const zones: DeliveryZone[] = sent.map((zone) => {
    const before = saved.get(zone.name)
    return {
      ...zone,
      districts: zone.districts ?? before?.districts ?? [],
      slots: zone.slots.filter((s) => mine.has(`${s.start}-${s.end}`)),
      payOnDelivery: zone.payOnDelivery,
    }
  })
  const taken = new Map<string, string>()
  for (const other of methods)
    if (other.id !== methodId)
      for (const zone of other.zones)
        for (const code of zone.districts ?? []) taken.set(code, other.name)
  for (const [i, zone] of zones.entries())
    for (const code of zone.districts) {
      const owner = taken.get(code)
      if (owner) {
        const message = `${DISTRICT_BY_CODE.get(code)?.short ?? code} ya está en «${owner}»`
        throw new StoreError(409, "DISTRICT_TAKEN", message, { [`zones.${i}.districts`]: message })
      }
    }
  const problem = zonesProblem(zones)
  if (problem) throw new StoreError(400, "VALIDATION_ERROR", problem.message)
  return zones
}

/** Una zona como llega, ya revisada: sin distritos si no los trae (los guarda `checkZonesIn`). */
export type ZoneSent = Omit<DeliveryZone, "districts"> & { districts?: string[] }

/** Una zona con lo de siempre: al día siguiente, sin franjas, con pago al recibir y envío gratis. */
export function plainZone(
  name: string,
  priceCents: number,
  districts: string[] = [],
): DeliveryZone {
  return {
    name,
    priceCents,
    districts,
    lead: "manana",
    cutoff: null,
    weekdays: [],
    slots: [],
    payOnDelivery: true,
    freeShipping: true,
  }
}

/* --------------------------------------------------------------- el precio del envío */

type Method = typeof storeDeliveryMethod.$inferSelect

export interface DeliveryChoice {
  /** El nombre de la zona, como se eligió en la lista. */
  zone: string | null
  /** El distrito (UBIGEO), si se sabe: manda sobre el nombre de la zona. */
  district?: string | null
  /** Con «se acuerda en el chat»: cuánto cuesta. */
  listCents: number | null
}

export type DeliveryPrice =
  | { ok: true; listCents: number; zone: DeliveryZone | null }
  | { ok: false; field: string; message: string }

/**
 * Lo que cuesta un envío antes de negociar: la única regla, para el equipo y para Sofi. Por
 * zona, la del distrito (o la elegida por su nombre); por agencia, llevarlo a la agencia más el
 * flete, si la tienda lo cobra antes.
 */
export function deliveryPriceOf(method: Method, choice: DeliveryChoice): DeliveryPrice {
  const freight = method.freight === "antes" ? (method.freightCents ?? 0) : 0
  switch (method.cost) {
    case "gratis":
      return { ok: true, listCents: freight, zone: null }
    case "fijo":
      return { ok: true, listCents: (method.priceCents ?? 0) + freight, zone: null }
    case "por_zona": {
      if (choice.district) {
        const zone = method.zones.find((z) => z.districts?.includes(choice.district ?? ""))
        if (!zone)
          return {
            ok: false,
            field: "zone",
            message: `${DISTRICT_BY_CODE.get(choice.district)?.short ?? "Ese distrito"}: no entregas ahí con «${method.name}»`,
          }
        return { ok: true, listCents: zone.priceCents, zone }
      }
      const zone = method.zones.find((z) => z.name === choice.zone)
      if (!zone) return { ok: false, field: "zone", message: "Elige la zona" }
      return { ok: true, listCents: zone.priceCents, zone }
    }
    default:
      if (choice.listCents === null)
        return { ok: false, field: "deliveryListCents", message: "Escribe cuánto cuesta el envío" }
      return { ok: true, listCents: choice.listCents, zone: null }
  }
}

/** Si se puede pagar al recibir: por zona, lo de su zona; si no, lo de la forma de entrega. */
export function payOnDeliveryOf(method: Method, zone: DeliveryZone | null): boolean {
  if (method.cost === "por_zona" && zone) return zone.payOnDelivery ?? method.acceptsPayOnDelivery
  return method.acceptsPayOnDelivery
}

/** Desde qué compra es gratis: por zona, solo en las zonas que lo tienen. */
export function freeFromOf(method: Method, zone: DeliveryZone | null): number | null {
  if (method.cost === "por_zona" && zone && zone.freeShipping === false) return null
  return method.freeFromCents
}

/* ------------------------------------------------------------- cuándo llega, en palabras */

const pad = (n: number) => String(n).padStart(2, "0")

/** Los minutos desde las 00:00 en la hora de la tienda. */
function minutesIn(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const of = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return of("hour") * 60 + of("minute")
}

/** «1 p. m.», «10:30 a. m.»: como se dice la hora en el Perú. */
export function clockWords(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${m ? `:${pad(m)}` : ""} ${h < 12 ? "a. m." : "p. m."}`
}

/** «entre 2 y 6 p. m.», «entre 10 a. m. y 1 p. m.». */
export function slotWords(slot: DeliverySlot): string {
  const from = clockWords(slot.start)
  const to = clockWords(slot.end)
  const sameHalf = from.slice(-5) === to.slice(-5)
  return `entre ${sameHalf ? from.slice(0, -6) : from} y ${to}`
}

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

/** «martes y viernes». */
export function weekdaysWords(days: number[]): string {
  const names = days.map((day) => WEEKDAYS[day - 1] ?? "")
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : (names[0] ?? "")
}

/** Cuándo llega lo de una zona, como regla: «hoy si pide antes de la 1 p. m.». */
export function leadWords(zone: Pick<DeliveryZone, "lead" | "cutoff" | "weekdays">): string {
  if (zone.lead === "hoy") return `hoy si pide antes de la ${clockWords(zone.cutoff ?? 0)}`
  if (zone.lead === "dias") return `los ${weekdaysWords(zone.weekdays)}`
  return "al día siguiente"
}

/**
 * El día en que llega un pedido hecho ahora, en la hora de la tienda: hoy antes de la hora de
 * corte; si no, mañana; en días fijos, el primero de ellos desde mañana.
 */
export function arrivalDay(
  zone: Pick<DeliveryZone, "lead" | "cutoff" | "weekdays">,
  timeZone: string,
  now: Date,
): string {
  const today = dayIn(timeZone, now)
  if (zone.lead === "hoy" && minutesIn(timeZone, now) < (zone.cutoff ?? 0)) return today
  if (zone.lead === "dias" && zone.weekdays.length > 0)
    for (let i = 1; i <= 7; i++) {
      const day = addDays(today, i)
      if (zone.weekdays.includes(weekdayOf(day) + 1)) return day
    }
  return addDays(today, 1)
}

/** «hoy», «mañana» o «el viernes 28». */
export function dayWords(day: string, today: string): string {
  if (day === today) return "hoy"
  if (day === addDays(today, 1)) return "mañana"
  const [, , d] = day.split("-").map(Number)
  return `el ${WEEKDAYS[weekdayOf(day)]} ${d}`
}

/* ---------------------------------------------------------------- la plantilla de Lima */

/**
 * «Lejanos y playas»: no es de Ipsos, es nuestra. Ahí los couriers de Lima cobran de S/ 15 a
 * S/ 20 o van en días fijos: Ancón y Santa Rosa al norte, Ventanilla y Mi Perú en el Callao,
 * Chosica, Chaclacayo y Cieneguilla al este, y Lurín, Pachacámac y las playas del sur.
 */
export const FAR_DISTRICTS = [
  "150102",
  "150139",
  "070106",
  "070107",
  "150118",
  "150107",
  "150109",
  "150119",
  "150123",
  "150126",
  "150127",
  "150129",
  "150138",
  "150124",
]

const MORNING: DeliverySlot = { start: 10 * 60, end: 13 * 60 }
const AFTERNOON: DeliverySlot = { start: 14 * 60, end: 18 * 60 }

/** Los grupos de la plantilla: los de Ipsos (Centro y Lima Moderna juntos) y los lejanos. */
const TEMPLATE_GROUPS: { name: string; of: (district: District) => boolean }[] = [
  { name: "Centro y Lima Moderna", of: (x) => x.ipsos === "centro" || x.ipsos === "moderna" },
  { name: "Lima Este", of: (x) => x.ipsos === "este" },
  { name: "Lima Norte", of: (x) => x.ipsos === "norte" },
  { name: "Lima Sur", of: (x) => x.ipsos === "sur" },
  { name: "Callao", of: (x) => x.ipsos === "callao" },
]

/**
 * Las zonas de la plantilla de Lima (decisión 5): seis, con los 50 distritos. Los precios son de
 * partida, lo que publican couriers de Lima para tiendas (de S/ 10 a S/ 18): la zona desde la
 * que despacha la tienda (o Centro y Lima Moderna) a S/ 10 y hoy si pide antes de la 1 p. m.;
 * las demás a S/ 12, al día siguiente; «Lejanos y playas» a S/ 18, martes y viernes, sin pago
 * al recibir ni envío gratis. La tienda cambia lo que quiera.
 */
export function limaTemplate(shipFrom: string | null): DeliveryZone[] {
  const far = new Set(FAR_DISTRICTS)
  const home = shipFrom && !far.has(shipFrom) ? DISTRICT_BY_CODE.get(shipFrom) : undefined
  const near = home ? TEMPLATE_GROUPS.findIndex((group) => group.of(home)) : 0
  const zones: DeliveryZone[] = TEMPLATE_GROUPS.map((group, i) => ({
    name: group.name,
    priceCents: i === near ? 1000 : 1200,
    districts: DISTRICTS.filter((x) => !far.has(x.code) && group.of(x)).map((x) => x.code),
    lead: i === near ? "hoy" : "manana",
    cutoff: i === near ? 13 * 60 : null,
    weekdays: [],
    slots: i === near ? [MORNING, AFTERNOON] : [AFTERNOON],
    payOnDelivery: true,
    freeShipping: true,
  }))
  zones.push({
    name: "Lejanos y playas",
    priceCents: 1800,
    districts: FAR_DISTRICTS,
    lead: "dias",
    cutoff: null,
    weekdays: [2, 5],
    slots: [],
    payOnDelivery: false,
    freeShipping: false,
  })
  return zones
}

/* ----------------------------------------------------------------- lo de la pantalla */

/** Lo que lleva la pantalla de Entregas: las formas, las franjas, las reglas y los distritos. */
export async function deliverySetup(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const [shop] = await tx
      .select({
        currency: store.currency,
        shipFrom: store.shipFrom,
        failedTrip: store.failedTrip,
      })
      .from(store)
      .where(eq(store.id, storeId))
    const deliveries = await tx
      .select()
      .from(storeDeliveryMethod)
      .where(eq(storeDeliveryMethod.storeId, storeId))
      .orderBy(asc(storeDeliveryMethod.createdAt))
    const { timeZone } = await storeClockIn(tx, storeId)
    return {
      deliveries: deliveries.map(({ storeId: _, ...m }) => m),
      slots: (await storeSlotsIn(tx, storeId)).map((s) => ({ ...s, label: slotLabel(s) })),
      shipFrom: shop?.shipFrom ?? null,
      failedTrip: shop?.failedTrip ?? "primera_tienda",
      timeZone,
      /** La plantilla de Lima va en soles: solo se ofrece a una tienda que vende en soles. */
      template: shop?.currency === "PEN",
      districts: DISTRICTS.map(({ aliases: _, ...district }) => district),
    }
  })
}

export const deliveryRulesInput = z
  .object({
    shipFrom: z.string().refine(isDistrict, "Elige un distrito de la lista").nullable().optional(),
    failedTrip: z.enum(FAILED_TRIPS).optional(),
  })
  .strict()

/** Desde dónde despacha la tienda y quién paga el viaje fallido. */
export async function setDeliveryRules(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof deliveryRulesInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const set: { shipFrom?: string | null; failedTrip?: FailedTrip } = {}
    if (input.shipFrom !== undefined) set.shipFrom = input.shipFrom
    if (input.failedTrip) set.failedTrip = input.failedTrip
    if (Object.keys(set).length === 0) return { ok: true }
    await tx.update(store).set(set).where(eq(store.id, storeId))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: "Reglas de entrega",
      detail: set,
    })
    return { ok: true }
  })
}

export const templateInput = z
  .object({ shipFrom: z.string().refine(isDistrict, "Elige un distrito de la lista").nullable() })
  .strict()

/**
 * Usar la plantilla de Lima: el reparto de la tienda (el primero, o uno nuevo «Reparto en Lima»)
 * pasa a sus seis zonas, y las franjas de la plantilla se suman a las de la tienda si caben.
 * Ningún distrito puede quedar en otra forma de entrega: si otra los tiene, lo dice.
 */
export async function applyLimaTemplate(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof templateInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [shop] = await tx
      .select({ currency: store.currency, slots: store.deliverySlots })
      .from(store)
      .where(eq(store.id, storeId))
    if (shop?.currency !== "PEN")
      throw new StoreError(409, "NOT_PEN", "La plantilla de Lima es en soles")
    const slots = [...(shop.slots ?? [])]
    for (const add of [MORNING, AFTERNOON])
      if (
        !slots.some((s) => s.start === add.start && s.end === add.end) &&
        slots.length < MAX_DELIVERY_SLOTS
      )
        slots.push(add)
    const mine = new Set(slots.map((s) => `${s.start}-${s.end}`))
    const zones = limaTemplate(input.shipFrom).map((zone) => ({
      ...zone,
      slots: zone.slots.filter((s) => mine.has(`${s.start}-${s.end}`)),
    }))
    await tx
      .update(store)
      .set({ shipFrom: input.shipFrom, deliverySlots: sortSlots(slots) })
      .where(eq(store.id, storeId))
    const [fleet] = await tx
      .select()
      .from(storeDeliveryMethod)
      .where(
        and(
          eq(storeDeliveryMethod.storeId, storeId),
          eq(storeDeliveryMethod.type, "DeliveryModeOwnFleet"),
        ),
      )
      .orderBy(asc(storeDeliveryMethod.createdAt))
      .limit(1)
    const checked = await checkZonesIn(tx, storeId, fleet?.id ?? null, zones)
    const values = {
      cost: "por_zona" as const,
      priceCents: null,
      zones: checked,
      eta: "",
      acceptsPayOnDelivery: true,
      freeFromCents: fleet?.freeFromCents ?? 20000,
      isActive: true,
    }
    const [row] = fleet
      ? await tx
          .update(storeDeliveryMethod)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(storeDeliveryMethod.id, fleet.id))
          .returning()
      : await tx
          .insert(storeDeliveryMethod)
          .values({ storeId, name: "Reparto en Lima", type: "DeliveryModeOwnFleet", ...values })
          .returning()
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: row!.name,
      detail: { plantilla: "lima", desde: input.shipFrom },
    })
    return row!
  })
}

/* --------------------------------------------------------------- lo que le dice Sofi */

/**
 * Lo que llega a un distrito con cada forma de reparto encendida: su zona, el precio, cuándo y
 * en qué franja, si se paga al recibir y desde qué compra es gratis. Si ninguna llega, lo dice.
 */
export async function deliveryToDistrictIn(tx: Db, storeId: string, code: string, now: Date) {
  const { timeZone, today } = await storeClockIn(tx, storeId, now)
  const methods = await tx
    .select()
    .from(storeDeliveryMethod)
    .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.isActive, true)))
    .orderBy(asc(storeDeliveryMethod.createdAt))
  const [shop] = await tx
    .select({ failedTrip: store.failedTrip })
    .from(store)
    .where(eq(store.id, storeId))
  const found = methods.flatMap((method) => {
    if (method.cost !== "por_zona") return []
    const zone = method.zones.find((z) => z.districts?.includes(code))
    if (!zone) return []
    const day = arrivalDay(zone, timeZone, now)
    return [{ method, zone, day, dayText: dayWords(day, today) }]
  })
  // Un reparto sin zonas (un precio para todo, gratis o se acuerda) llega a cualquier distrito.
  const anywhere = methods.filter(
    (method) => method.type === "DeliveryModeOwnFleet" && method.cost !== "por_zona",
  )
  return { found, anywhere, failedTrip: shop?.failedTrip ?? "primera_tienda", timeZone, today }
}

/** Lo que dice Sofi de quién paga si la clienta no está, antes de que pague. */
export const FAILED_TRIP_WORDS: Record<FailedTrip, string> = {
  primera_tienda:
    "Si no hay nadie para recibir, la primera vez la tienda asume el viaje; el siguiente viaje lo paga la clienta.",
  clienta: "Si no hay nadie para recibir, cada viaje que se repite lo paga la clienta.",
  tienda: "Si no hay nadie para recibir, la tienda asume el viaje que se repite.",
}
