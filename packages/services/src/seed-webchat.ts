import type { Db } from "@odentia/db"
import {
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { createWebchatConnection, listWebchatConnections, WEBCHAT_CHANNEL } from "./webchat.js"

/**
 * Seed del chat web embebible: conexión local segura (orígenes de dev,
 * cifrada con SECRETS_KEY igual que el resto) y un visitante de demostración
 * con un único mensaje entrante. Sin mensajes salientes: nada sale a red
 * externa. Idempotente (re-ejecutable).
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

  const existing = await listWebchatConnections(tx, orgId, deps.secretsKey)
  let connectionId = existing[0]?.id
  if (!connectionId) {
    const created = await createWebchatConnection(
      tx,
      orgId,
      deps.secretsKey,
      ownerUserId,
      {
        displayName: "Chat web",
        config: {
          allowedOrigins: ["https://*.odentia.localhost", "http://localhost:3000"],
          widgetTitle: "Chat web",
          widgetColor: "#0f766e",
          greeting: "Hola, ¿en qué podemos ayudarte?",
        },
      },
      { fetch: deps.fetch },
    )
    connectionId = created.id
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
}
