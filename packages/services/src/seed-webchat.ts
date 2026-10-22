import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import {
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { webchatSite } from "@odentia/db/schema/webchat"
import { and, eq } from "drizzle-orm"
import { getClinicWebchat, updateClinicWebchat, WEBCHAT_CHANNEL } from "./webchat.js"

/**
 * Seed del chat web de la clínica (fase 6 del pulido de la Bandeja): el chat,
 * instalado en un sitio (el primero, registrado solo) y aparecido en otro que
 * espera el sí de la clínica; un visitante de demostración con un mensaje y una
 * prueba de Configuración. Nada sale a red externa. Idempotente.
 *
 * El padre la conecta a seed-dev con `{ secretsKey, fetch }`; no se exporta
 * en el barrel de servicios.
 */
export async function seedWebchat(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
  deps?: { secretsKey: Buffer; fetch: typeof fetch },
): Promise<void> {
  const { orgId, ownerUserId } = input
  if (!deps) throw new Error("seedWebchat requiere { secretsKey, fetch } (cifrado de la conexión)")
  const now = new Date()

  const chat = await getClinicWebchat(tx, orgId, deps.secretsKey, ownerUserId)
  await updateClinicWebchat(tx, orgId, deps.secretsKey, ownerUserId, { color: "#0f766e", greeting: "Hola, ¿en qué podemos ayudarte?" })
  const connectionId = chat.id
  if (chat.sites.length === 0) {
    await tx.insert(webchatSite).values([
      { organizationId: orgId, connectionId, origin: "https://sonrisa.pe", status: "permitido", firstSeenAt: new Date(now.getTime() - 3 * 86_400_000) },
      { organizationId: orgId, connectionId, origin: "https://promo-dental.net", status: "pendiente", firstSeenAt: new Date(now.getTime() - 2 * 3_600_000) },
    ])
  }

  // Visitante demo: solo contacto + identidad de canal. Nunca se vincula un
  // paciente por el nombre escrito en el widget.
  const visitorExternalId = "webchat:seed-visitante"
  const [identity] = await tx
    .select({ id: contactIdentity.id, contactId: contactIdentity.contactId })
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.channel, WEBCHAT_CHANNEL),
        eq(contactIdentity.externalUserId, visitorExternalId),
      ),
    )
    .limit(1)
  let contactId = identity?.contactId
  let identityId = identity?.id
  if (!contactId) {
    const [createdContact] = await tx
      .insert(contact)
      .values({ organizationId: orgId, displayName: "Visitante web", lastInteractionAt: now })
      .returning({ id: contact.id })
    if (!createdContact) throw new Error("No se pudo sembrar el contacto visitante")
    contactId = createdContact.id
    const [createdIdentity] = await tx
      .insert(contactIdentity)
      .values({
        organizationId: orgId,
        contactId,
        channel: WEBCHAT_CHANNEL,
        externalUserId: visitorExternalId,
        displayName: "Visitante web",
        isPrimary: true,
      })
      .onConflictDoNothing({
        target: [contactIdentity.organizationId, contactIdentity.channel, contactIdentity.externalUserId],
      })
      .returning({ id: contactIdentity.id })
    identityId =
      createdIdentity?.id ??
      (
        await tx
          .select({ id: contactIdentity.id })
          .from(contactIdentity)
          .where(
            and(
              eq(contactIdentity.organizationId, orgId),
              eq(contactIdentity.channel, WEBCHAT_CHANNEL),
              eq(contactIdentity.externalUserId, visitorExternalId),
            ),
          )
          .limit(1)
      )[0]?.id
    if (!identityId) throw new Error("No se pudo sembrar la identidad del visitante")
  }

  const [conv] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(eq(conversation.channelConnectionId, connectionId), eq(conversation.externalThreadId, visitorExternalId)),
    )
    .limit(1)
  let conversationId = conv?.id
  if (!conversationId) {
    const [created] = await tx
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId,
        contactIdentityId: identityId,
        channelConnectionId: connectionId,
        externalThreadId: visitorExternalId,
        unreadCount: 1,
        lastInboundAt: now,
        lastMessageAt: now,
      })
      .onConflictDoNothing({
        target: [conversation.channelConnectionId, conversation.externalThreadId],
      })
      .returning({ id: conversation.id })
    conversationId =
      created?.id ??
      (
        await tx
          .select({ id: conversation.id })
          .from(conversation)
          .where(
            and(
              eq(conversation.channelConnectionId, connectionId),
              eq(conversation.externalThreadId, visitorExternalId),
            ),
          )
          .limit(1)
      )[0]?.id
    if (!conversationId) throw new Error("No se pudo sembrar la conversación del visitante")
  }

  // Solo entrante: el operador la ve en la misma bandeja; nada sale afuera.
  await tx
    .insert(message)
    .values({
      organizationId: orgId,
      conversationId,
      direction: "in",
      senderKind: "contact",
      contentType: "text",
      body: "Hola, ¿tienen citas disponibles esta semana?",
      externalId: "webchat:seed:visitante:bienvenida-1",
      status: "received",
    })
    .onConflictDoNothing()

  // Una prueba de Configuración: lleva «Prueba» en la Bandeja y se borra a los 7 días.
  const testThread = `webchat:prueba:${randomUUID()}`
  const [testPerson] = await tx
    .insert(contact)
    .values({ organizationId: orgId, displayName: "Prueba del chat web", lastInteractionAt: now })
    .returning({ id: contact.id })
  if (!testPerson) throw new Error("No se pudo sembrar la prueba del chat web")
  const [testIdentity] = await tx
    .insert(contactIdentity)
    .values({ organizationId: orgId, contactId: testPerson.id, channel: WEBCHAT_CHANNEL, externalUserId: testThread, displayName: "Prueba del chat web", isPrimary: true })
    .returning({ id: contactIdentity.id })
  const [testConversation] = await tx
    .insert(conversation)
    .values({
      organizationId: orgId,
      contactId: testPerson.id,
      contactIdentityId: testIdentity?.id ?? null,
      channelConnectionId: connectionId,
      externalThreadId: testThread,
      isTest: true,
      lastInboundAt: new Date(now.getTime() - 20 * 60_000),
      lastMessageAt: new Date(now.getTime() - 19 * 60_000),
    })
    .returning({ id: conversation.id })
  if (!testConversation) throw new Error("No se pudo sembrar la conversación de prueba")
  await tx.insert(message).values([
    {
      organizationId: orgId, conversationId: testConversation.id, direction: "in", senderKind: "contact", contentType: "text",
      body: "¿Hacen ortodoncia invisible? ¿Cuánto cuesta?", externalId: `webchat:prueba-${randomUUID()}:c1`, status: "received",
      createdAt: new Date(now.getTime() - 20 * 60_000),
    },
    {
      organizationId: orgId, conversationId: testConversation.id, direction: "out", senderKind: "agent", contentType: "text",
      body: "Sí, la hacemos. El precio lo confirma la doctora en la evaluación.", externalId: `webchat:local:${randomUUID()}`, status: "delivered",
      createdAt: new Date(now.getTime() - 19 * 60_000),
    },
  ])
}
