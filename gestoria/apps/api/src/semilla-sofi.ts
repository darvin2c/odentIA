import {
  agentGap,
  conversation,
  conversationMessage,
  type Db,
  type FollowUp,
  type MessageAuthor,
  product,
  productVariant,
  saleOrder,
  stockRequest,
  storeAgent,
  storeAgentAnswer,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq } from "drizzle-orm"
import { ARGOS_ACTOR, SOFI_ACTOR } from "./agente.js"
import { addReceiptIn, createOrderIn, orderInput } from "./pedidos.js"
import { questionKey } from "./sofi/saber.js"

/**
 * Sofi y Argos en Calzados Rosa (paso B5, tableros 2, 8 y 13): Sofi encendida (lo que sabe va en
 * `seedDemoSofiKnows`); conversaciones de WhatsApp e Instagram como las traerá B2 (una venta negociada con la
 * captura por confirmar, un pedido por pagar, una talla agotada que pidieron y un reclamo que
 * espera a una persona) y lo que Argos le encargó a Sofi. Solo para desarrollo y demostraciones,
 * como el resto de `semilla.ts`. Se agrega una vez: si la tienda ya tiene conversaciones, no
 * las toca.
 */

const HOUR = 3_600_000

export async function seedDemoSofi(tx: Db, storeId: string): Promise<void> {
  const [any] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.storeId, storeId))
    .limit(1)
  if (any) return
  await tx
    .insert(storeAgent)
    .values({ storeId, enabled: true, updatedBy: "semilla-rosa" })
    .onConflictDoNothing()

  const variant = async (name: string, values: string[]) => {
    const rows = await tx
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
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.storeId, storeId), eq(table.name, name)))
    return row!.id
  }
  const reparto = await idOf(storeDeliveryMethod, "Reparto en Lima")
  const yape = await idOf(storePaymentMethod, "Yape")

  /** Una conversación de un canal, con sus mensajes de hace `hoursAgo` horas en adelante. */
  const talk = async (
    channel: "whatsapp" | "instagram",
    customerName: string,
    hoursAgo: number,
    lines: [MessageAuthor, string][],
    extra: Partial<typeof conversation.$inferInsert> = {},
  ) => {
    const start = Date.now() - hoursAgo * HOUR
    const [row] = await tx
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
        ...extra,
      })
      .returning({ id: conversation.id })
    for (const [i, [author, text]] of lines.entries())
      await tx.insert(conversationMessage).values({
        storeId,
        conversationId: row!.id,
        author,
        text,
        delivery: author === "cliente" ? null : "sin_enviar",
        actorUserId:
          author === "sofi" ? SOFI_ACTOR : author === "cliente" ? "canal" : "semilla-lucia",
        createdAt: new Date(start + i * 60_000),
        // La respuesta con la que la pasó a una persona lleva su motivo, como la de Sofi.
        ...(author === "sofi" && i === lines.length - 1 && extra.waitingReason
          ? { detail: { paso: extra.waitingReason } }
          : {}),
      })
    return row!.id
  }
  const order = async (
    conversationId: string,
    input: Record<string, unknown>,
    hoursAgo: number,
  ) => {
    const created = await createOrderIn(
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
    await tx
      .update(saleOrder)
      .set({ createdAt: new Date(Date.now() - hoursAgo * HOUR) })
      .where(eq(saleOrder.id, created.id))
    return created
  }
  const followUp = async (conversationId: string, kind: FollowUp, ref: string, text: string) =>
    tx.insert(conversationMessage).values({
      storeId,
      conversationId,
      author: "sofi",
      text,
      delivery: "sin_enviar",
      needsTemplate: true,
      followUp: kind,
      followUpRef: ref,
      detail: { encargo: "argos" },
      actorUserId: ARGOS_ACTOR,
    })

  // Valeria: negoció (envío gratis y S/ 9 menos, del mismo margen) y mandó la captura de Yape.
  const valeria = await talk("whatsapp", "Valeria Soto", 2, [
    ["cliente", "Hola, ¿tienen la zapatilla blanca en 38?"],
    [
      "sofi",
      "¡Hola! Soy Sofi, de Calzados Rosa. Sí, la Zapatilla urbana blanca en 38 cuesta S/ 129. Es de cuero sintético con planta de goma. ¿Te la envío o la recoges?",
    ],
    ["cliente", "¿Me la dejas en 110? Es para Surco"],
    [
      "sofi",
      "A 110 no llego, pero te regalo el envío a Surco (S/ 10) y te la dejo en S/ 120, todo incluido. ¿Te la anoto?",
    ],
    ["cliente", "Ya, va. Av. Primavera 123, Surco. Soy Valeria Soto"],
    [
      "sofi",
      "Listo, Valeria: 1 Zapatilla urbana blanca talla 38, reparto a Surco gratis. Total S/ 120. Puedes pagar por Yape al 987 654 321 (Rosa Quispe) y me mandas la captura.",
    ],
    ["cliente", "Listo, te yapeé 120, operación 55667788"],
    [
      "sofi",
      "¡Gracias, Valeria! Anoté tu pago de S/ 120: una persona del equipo lo revisa y te aviso apenas esté confirmado.",
    ],
  ])
  const valeriaOrder = await order(
    valeria,
    {
      customerName: "Valeria Soto",
      address: "Av. Primavera 123, Surco",
      lines: [
        {
          variantId: await variant("Zapatilla urbana", ["blanca", "38"]),
          quantity: 1,
          unitCents: 12000,
        },
      ],
      deliveryCents: 0,
    },
    2,
  )
  await addReceiptIn(tx, storeId, SOFI_ACTOR, valeriaOrder.id, {
    amountCents: 12000,
    operation: "55667788",
  })

  // Jorge: armó su pedido por Instagram hace 5 horas y no pagó. Argos le pidió a Sofi recordarle.
  const jorge = await talk("instagram", "Jorge Salinas", 5, [
    ["cliente", "Hola, ¿cuánto el botín de cuero en 40?"],
    [
      "sofi",
      "¡Hola! Soy Sofi, de Calzados Rosa. El Botín de cuero marrón en 40 cuesta S/ 219. Es de cuero natural con forro térmico. ¿Te lo envío?",
    ],
    ["cliente", "Sí, a Miraflores. Jorge Salinas, Calle Las Flores 140"],
    [
      "sofi",
      "Listo, Jorge: Botín de cuero marrón 40 con reparto a Miraflores (S/ 10). Total S/ 229. ¿Lo confirmo?",
    ],
    ["cliente", "Sí"],
    [
      "sofi",
      "Anotado, pedido por S/ 229. Puedes pagar por Yape al 987 654 321 y me mandas la captura.",
    ],
  ])
  const jorgeOrder = await order(
    jorge,
    {
      channel: "instagram",
      customerName: "Jorge Salinas",
      address: "Calle Las Flores 140, Miraflores",
      lines: [{ variantId: await variant("Botín de cuero marrón", ["40"]), quantity: 1 }],
    },
    5,
  )
  await followUp(
    jorge,
    "pago",
    jorgeOrder.id,
    `Hola, Jorge. Tu pedido ${jorgeOrder.number} por S/ 229 está listo para pagar. ¿Te ayudo a terminar?`,
  )

  // Marta: pidió la zapatilla blanca 42, agotada. Sofi quedó en avisarle cuando vuelva.
  const marta = await talk("whatsapp", "Marta Ríos", 26, [
    ["cliente", "Hola, ¿la zapatilla blanca en 42?"],
    [
      "sofi",
      "¡Hola! Soy Sofi, de Calzados Rosa. La blanca en 42 se nos acabó. La tengo en negra en 41, a S/ 89. ¿O prefieres que te avise cuando vuelva la blanca?",
    ],
    ["cliente", "Avísame porfa"],
    ["sofi", "¡Hecho! Te escribo por aquí apenas vuelva la blanca en 42."],
  ])
  await tx.insert(stockRequest).values({
    storeId,
    variantId: await variant("Zapatilla urbana", ["blanca", "42"]),
    conversationId: marta,
  })

  // Luis: un reclamo. Sofi no promete devoluciones: la pasó a una persona.
  await talk(
    "whatsapp",
    "Luis Paredes",
    1,
    [
      ["cliente", "Buenas, el botín que me llegó tiene la suela despegada. Quiero cambiarlo."],
      ["sofi", "Te paso con una persona del equipo, que te escribe por aquí en un momento."],
    ],
    { handler: "persona", waitingReason: "Un reclamo: el botín llegó con la suela despegada" },
  )
}

/**
 * Lo que eligió Calzados Rosa para Sofi, «Lo que sabe» y «Lo que aprendió» (tablero 8 de
 * «gestorIA · Configuración, de nuevo»; ADR 0234): el horario de su equipo, tres respuestas y lo
 * que clientas de verdad preguntaron sin respuesta (cada una en su conversación, con Sofi pasando
 * el chat). Se agrega una vez: si la tienda ya tiene «Lo que sabe», no lo toca.
 */
export async function seedDemoSofiKnows(tx: Db, storeId: string): Promise<void> {
  const [any] = await tx
    .select({ id: storeAgentAnswer.id })
    .from(storeAgentAnswer)
    .where(eq(storeAgentAnswer.storeId, storeId))
    .limit(1)
  if (any) return
  await tx
    .update(storeAgent)
    .set({
      tone: "cercana",
      address: "tu",
      emojis: "pocos",
      teamHours: { days: [1, 2, 3, 4, 5, 6], from: "09:00", to: "19:00" },
    })
    .where(eq(storeAgent.storeId, storeId))
  const who = "semilla-rosa"
  await tx.insert(storeAgentAnswer).values(
    [
      ["¿Hacen cambios?", "Sí, de talla dentro de 7 días, con la caja y sin usar."],
      [
        "¿Dónde están?",
        "En Jr. Gamarra 650, La Victoria, stand 214. Puedes recoger de lunes a sábado.",
      ],
      ["¿Cómo se limpian las zapatillas blancas?", "Con un paño húmedo, sin lavadora."],
    ].map(([question, answer]) => ({
      storeId,
      question: question!,
      answer: answer!,
      createdBy: who,
      updatedBy: who,
    })),
  )
  const asked: [string, string, string][] = [
    [
      "Camila Torres",
      "Hola, ¿la zapatilla blanca es de cuero?",
      "¿La zapatilla blanca es de cuero?",
    ],
    ["Daniela Ruiz", "¿Es de cuero la blanca o sintética?", "¿La zapatilla blanca es de cuero?"],
    ["Paola Vega", "la blanca es cuero?", "¿La zapatilla blanca es de cuero?"],
    [
      "Sofía Lara",
      "¿El botín marrón viene en horma chica?",
      "¿La horma del botín marrón es chica?",
    ],
    ["Mónica Díaz", "¿La horma del botín es chica?", "¿La horma del botín marrón es chica?"],
    ["Rocío Salas", "¿Dan boleta o factura?", "¿Dan boleta o factura?"],
  ]
  for (const [i, [name, text, question]] of asked.entries()) {
    const at = Date.now() - (i + 2) * 20 * HOUR
    const [row] = await tx
      .insert(conversation)
      .values({
        storeId,
        channel: i % 2 ? "instagram" : "whatsapp",
        customerName: name,
        createdBy: "canal",
        createdAt: new Date(at),
        updatedAt: new Date(at + 60_000),
        lastCustomerAt: new Date(at),
        handler: "persona",
        waitingReason: "No sabe la respuesta",
      })
      .returning({ id: conversation.id })
    await tx.insert(conversationMessage).values([
      {
        storeId,
        conversationId: row!.id,
        author: "cliente",
        text,
        actorUserId: "canal",
        createdAt: new Date(at),
      },
      {
        storeId,
        conversationId: row!.id,
        author: "sofi",
        text: "Déjame consultarlo con el equipo. Te paso con una persona del equipo, que te escribe por aquí en un momento.",
        delivery: "sin_enviar",
        actorUserId: SOFI_ACTOR,
        detail: { paso: "No sabe la respuesta", pregunta: question },
        createdAt: new Date(at + 60_000),
      },
    ])
    await tx.insert(agentGap).values({
      storeId,
      conversationId: row!.id,
      question,
      questionKey: questionKey(question),
      createdBy: SOFI_ACTOR,
      createdAt: new Date(at + 60_000),
    })
  }
}
