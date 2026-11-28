import {
  conversation,
  conversationMessage,
  customer,
  customerConsent,
  customerFact,
  type Db,
  type MessageAuthor,
  product,
  productVariant,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import type { Person } from "./cuenta.js"
import { addReceiptIn, createOrderIn, orderInput } from "./pedidos.js"
import { correctFact } from "./perfil.js"
import type { ChatModel } from "./sofi/modelo.js"
import { profileStore } from "./sofi/perfilar.js"

/**
 * El perfil de las clientas de Calzados Rosa (ADR 0240), con los actores de verdad: el canal trae
 * lo que ellas escriben, Sofi arma sus pedidos y anota el permiso con sus palabras, Argos perfila
 * (`profileStore`, con sus comprobaciones) y Lucía corrige con «Corregir». Queda como en el
 * prototipo:
 *
 * - Andrea Castillo: talla 37 de sus compras, su Instagram y lo que le gusta de su chat, canal
 *   WhatsApp, y el distrito que Argos sacó de su entrega (Lince) corregido por Lucía («San Isidro,
 *   su oficina»): el historial lo cuenta. Aceptó las promociones.
 * - Camila Vargas compró la 38 y la 39 por igual: Argos usa la 39, la más reciente, «Por confirmar».
 * - Valeria Soto dio su cumpleaños en el chat, con su cita, y aceptó las promociones.
 * - Jorge Salinas pidió la baja: «ya no me mandes estas cosas porfa».
 *
 * Argos lee con un modelo de demostración que responde con las citas de abajo (sin red): sirve para
 * ver la ficha, no mide nada. Solo para desarrollo, como el resto de `semilla.ts`, y con la base de
 * la aplicación (`GESTORIA_APP_DATABASE_URL`): los agentes y Lucía entran con sus reglas. Se agrega
 * una vez: si la tienda ya tiene algún dato de una clienta, no toca nada.
 */

const HOUR = 3_600_000

const lucia: Person = {
  userId: "semilla-lucia",
  email: "lucia@calzadosrosa.demo",
  name: "Lucía Torres",
}

/** Lo que el modelo de demostración «lee» cuando la cita está en lo que recibe. */
const DEMO_READS: { clave: string; valor: string; cita: string }[] = [
  { clave: "medida", valor: "37", cita: "beige en 37" },
  { clave: "instagram", valor: "@andre.castillo", cita: "en insta soy @andre.castillo" },
  {
    clave: "gustos",
    valor: "Sandalias de colores claros",
    cita: "Me encantan las de colores claros",
  },
  { clave: "distrito", valor: "Lince", cita: "Lince" },
  { clave: "cumpleanos", valor: "--12-15", cita: "es para mi cumple, el 15 de dic" },
  { clave: "distrito", valor: "Surco", cita: "Es para Surco" },
  { clave: "distrito", valor: "Miraflores", cita: "a Miraflores" },
]

function demoReader(): ChatModel {
  return {
    name: "demo",
    async complete(request) {
      const user = request.messages
        .filter((m) => m.role === "user")
        .map((m) => String(m.content))
        .join("\n")
      const found = DEMO_READS.filter((read) => user.includes(read.cita))
      return {
        content: JSON.stringify(found),
        toolCalls: [],
        usage: { input: 0, cached: 0, output: 0 },
      }
    },
  }
}

export async function seedDemoProfiles(ownerDb: Db, appDb: Db, storeId: string): Promise<void> {
  const [done] = await ownerDb
    .select({ id: customerFact.id })
    .from(customerFact)
    .where(eq(customerFact.storeId, storeId))
    .limit(1)
  if (done) return
  const variant = async (name: string, values: string[]) => {
    const rows = await ownerDb
      .select({ id: productVariant.id, values: productVariant.optionValues })
      .from(productVariant)
      .innerJoin(product, eq(product.id, productVariant.productId))
      .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
    const row = rows.find((r) => r.values.join(" ") === values.join(" "))
    if (!row) throw new Error(`semilla: falta ${name} ${values.join(" ")}`)
    return row.id
  }
  const idOf = async (
    table: typeof storePaymentMethod | typeof storeDeliveryMethod,
    name: string,
  ) => {
    const [row] = await ownerDb
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.storeId, storeId), eq(table.name, name)))
    if (!row) throw new Error(`semilla: falta ${name}`)
    return row.id
  }
  const reparto = await idOf(storeDeliveryMethod, "Reparto en Lima")
  const yape = await idOf(storePaymentMethod, "Yape")
  const customerNamed = async (name: string) => {
    const [row] = await ownerDb
      .select({ id: customer.id })
      .from(customer)
      .where(
        and(eq(customer.storeId, storeId), eq(customer.name, name), isNull(customer.mergedInto)),
      )
      .orderBy(customer.createdAt)
      .limit(1)
    if (!row) throw new Error(`semilla: falta la ficha de ${name}`)
    return row.id
  }
  const conversationOf = async (name: string) => {
    const [row] = await ownerDb
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.storeId, storeId), eq(conversation.customerName, name)))
      .limit(1)
    if (!row) throw new Error(`semilla: falta la conversación de ${name}`)
    return row.id
  }

  /** Lo que trae el canal: una conversación con sus mensajes desde hace `hoursAgo` horas. */
  const talk = async (
    channel: "whatsapp" | "instagram",
    customerName: string,
    hoursAgo: number,
    lines: [MessageAuthor, string][],
  ) => {
    const start = Date.now() - hoursAgo * HOUR
    const [row] = await ownerDb
      .insert(conversation)
      .values({
        storeId,
        channel,
        customerName,
        createdBy: "canal",
        createdAt: new Date(start),
        updatedAt: new Date(start + lines.length * 60_000),
        lastCustomerAt: new Date(
          start + Math.max(0, lines.map(([a]) => a).lastIndexOf("cliente")) * 60_000,
        ),
      })
      .returning({ id: conversation.id })
    for (const [i, line] of lines.entries()) await add(row!.id, line, start + i * 60_000)
    return row!.id
  }
  const add = (conversationId: string, [author, text]: [MessageAuthor, string], at: number) =>
    ownerDb.insert(conversationMessage).values({
      storeId,
      conversationId,
      author,
      text,
      delivery: author === "cliente" ? null : "sin_enviar",
      actorUserId: author === "sofi" ? SOFI_ACTOR : "canal",
      createdAt: new Date(at),
    })

  /** Sofi arma el pedido en el chat y anota la captura: ya es una compra. */
  const sofiSells = (conversationId: string, input: Record<string, unknown>) =>
    withAgent(appDb, SOFI_ACTOR, storeId, async (tx) => {
      const order = await createOrderIn(
        tx,
        storeId,
        SOFI_ACTOR,
        orderInput.parse({
          channel: "whatsapp",
          deliveryMethodId: reparto,
          zone: "Surco y Miraflores",
          paymentMethodId: yape,
          ...input,
        }),
        { conversationId },
      )
      await addReceiptIn(tx, storeId, SOFI_ACTOR, order.id, {
        amountCents: order.totalCents,
        operation: String(70_000_000 + order.number),
      })
      return order
    })

  /** Sofi anota el permiso o la baja con lo que ella escribió, tal cual. */
  const sofiNotes = (conversationId: string, state: "si" | "baja", quote: string) =>
    withAgent(appDb, SOFI_ACTOR, storeId, async (tx) => {
      const [conv] = await tx
        .select({ channel: conversation.channel })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
      const [said] = await tx
        .select({ id: conversationMessage.id })
        .from(conversationMessage)
        .where(
          and(
            eq(conversationMessage.conversationId, conversationId),
            eq(conversationMessage.author, "cliente"),
            sql`position(${quote} in ${conversationMessage.text}) > 0`,
          ),
        )
        .orderBy(desc(conversationMessage.seq))
        .limit(1)
      const [order] = await tx
        .select({ customerId: customer.id, mergedInto: customer.mergedInto })
        .from(customer)
        .where(
          sql`${customer.id} = (select o.customer_id from sale_order o where o.conversation_id = ${conversationId} and o.customer_id is not null order by o.created_at desc limit 1)`,
        )
      await tx.insert(customerConsent).values({
        storeId,
        customerId: order ? (order.mergedInto ?? order.customerId) : null,
        conversationId,
        channel: conv!.channel,
        state,
        messageId: said!.id,
        quote,
        actorUserId: SOFI_ACTOR,
      })
    })

  // Andrea Castillo vuelve por WhatsApp: se lleva otra sandalia beige 37, a Lince.
  const andrea = await customerNamed("Andrea Castillo")
  const andreaChat = await talk("whatsapp", "Andrea Castillo", 3, [
    ["cliente", "Hola, ¿tienen la sandalia beige en 37?"],
    ["sofi", "¡Hola! Soy Sofi, de Calzados Rosa. Sí, la Sandalia beige en 37 está disponible."],
    ["cliente", "Ya, anótamela. Te vi en insta, en insta soy @andre.castillo"],
    ["sofi", "¡Gracias! ¿A qué dirección te la envío?"],
    ["cliente", "Jr. Pumacahua 1450, Lince. Me encantan las de colores claros"],
    ["sofi", "Listo. ¿Quieres que te avise por aquí cuando lleguen novedades?"],
    ["cliente", "Sí, mándame las novedades por aquí"],
  ])
  await sofiSells(andreaChat, {
    customerId: andrea,
    address: "Jr. Pumacahua 1450, Lince",
    lines: [{ variantId: await variant("Sandalia", ["beige", "37"]), quantity: 1 }],
  })
  await sofiNotes(andreaChat, "si", "Sí, mándame las novedades por aquí")

  // Camila Vargas compró la blanca 38 y después la negra 39: Argos no sabe cuál es.
  const camilaChat = await talk("whatsapp", "Camila Vargas", 6, [
    ["cliente", "Hola, quiero la zapatilla blanca en 38 y la negra en 39"],
    ["sofi", "¡Hola! Soy Sofi, de Calzados Rosa. Te anoto las dos."],
    ["cliente", "Sí, acepto que me escriban con ofertas"],
  ])
  for (const values of [
    ["blanca", "38"],
    ["negra", "39"],
  ])
    await sofiSells(camilaChat, {
      customerName: "Camila Vargas",
      address: "Av. Benavides 1520, Miraflores",
      lines: [{ variantId: await variant("Zapatilla urbana", values), quantity: 1 }],
    })
  await sofiNotes(camilaChat, "si", "acepto que me escriban con ofertas")

  // Valeria Soto (de `semilla-sofi.ts`) cuenta que es para su cumpleaños y acepta las ofertas.
  const valeria = await conversationOf("Valeria Soto")
  await add(
    valeria,
    ["cliente", "Ah, y es para mi cumple, el 15 de dic 🎂"],
    Date.now() - 1.5 * HOUR,
  )
  await add(valeria, ["cliente", "Sí, avísame de las ofertas"], Date.now() - 1.4 * HOUR)
  await sofiNotes(valeria, "si", "avísame de las ofertas")

  // Jorge Salinas (de `semilla-sofi.ts`) pide que no le escriban más.
  const jorge = await conversationOf("Jorge Salinas")
  await add(jorge, ["cliente", "ya no me mandes estas cosas porfa"], Date.now() - HOUR)
  await sofiNotes(jorge, "baja", "ya no me mandes estas cosas porfa")

  // Argos perfila a todas, y Lucía corrige el distrito de Andrea: recibe en su oficina.
  await profileStore(appDb, storeId, new Date(), demoReader())
  await correctFact(appDb, lucia, storeId, andrea, {
    key: "distrito",
    value: "San Isidro, su oficina",
  })
}
