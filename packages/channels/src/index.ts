export * from "./contract.js"
export * from "./protocol.js"
export * from "./meta-graph.js"
export { setTelegramWebhook, telegramBotApiAdapter } from "./telegram-bot-api.js"
export * from "./gmail.js"
export * from "./microsoft365.js"
export {
  splitWhatsAppWebhook,
  type WhatsAppAccountDelivery,
  type WhatsAppDelivery,
  type WhatsAppNumberDelivery,
  isWhatsAppAccountFailure,
  whatsappCloudApiAdapter,
  whatsappFailureWords,
  whatsappHiddenAddress,
  WHATSAPP_TOKEN_REJECTED_CODE,
} from "./whatsapp-cloud-api.js"
export {
  exchangeSignupCode,
  inspectSignupToken,
  listAccountNumbers,
  type MetaPlatformApp,
  MetaSignupError,
  type MetaSignupStep,
  newRegistrationPin,
  refreshSignupToken,
  registerPhoneNumber,
  requestBusinessAppSync,
  type SignupToken,
  type SignupTokenState,
  subscribeAppToAccount,
} from "./whatsapp-embedded-signup.js"
export {
  inspectOwnAppToken,
  type OwnAppNumber,
  type OwnAppToken,
  OwnAppTokenError,
  type OwnAppTokenProblem,
  readOwnAppNumber,
} from "./whatsapp-own-app.js"
export {
  assertValidWebchatConfig,
  buildWebchatInbound,
  createWebchatToken,
  isWebchatSessionId,
  isWebchatTestSession,
  newWebchatSessionId,
  isWebchatPlaceholderName,
  normalizeOrigin,
  WEBCHAT_PLACEHOLDER_NAMES,
  signWebchatBody,
  verifyWebchatToken,
  WEBCHAT_CHANNEL,
  WEBCHAT_TOKEN_TTL_MS,
  webChatAdapter,
  type WebchatConnectionConfig,
  type WebchatVisitorPayload,
} from "./web-chat.js"
export {
  instagramAdapter,
  messengerAdapter,
  verifyMetaChallenge,
  verifyMetaSignature,
} from "./meta-messaging.js"
import { gmailAdapter } from "./gmail.js"
import { microsoft365Adapter } from "./microsoft365.js"
import type { ChannelAdapter, ChannelProvider } from "./protocol.js"
import { instagramAdapter, messengerAdapter } from "./meta-messaging.js"
import { telegramBotApiAdapter } from "./telegram-bot-api.js"
import { webChatAdapter } from "./web-chat.js"
import { whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js"

/**
 * Registro parcial: cada slice dueño añade su adaptador (gmail/microsoft365 =
 * Email, web_chat = Web). `requireAdapter` en services falla explícito si el
 * proveedor aún no está registrado: nunca se finge una conexión activa.
 */
export const channelAdapters: Partial<Record<ChannelProvider, ChannelAdapter>> = {
  telegram_bot_api: telegramBotApiAdapter,
  whatsapp_cloud_api: whatsappCloudApiAdapter,
  messenger: messengerAdapter,
  instagram: instagramAdapter,
  web_chat: webChatAdapter,
  gmail: gmailAdapter,
  microsoft365: microsoft365Adapter,
}

/** Adaptador registrado o error explícito (nunca undefined silencioso). */
export function requireChannelAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = channelAdapters[provider]
  if (!adapter) throw new Error(`Proveedor no registrado: ${provider}`)
  return adapter
}
