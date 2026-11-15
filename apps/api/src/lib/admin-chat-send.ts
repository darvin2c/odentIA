// El envío por los canales de la administración vive en los servicios (`admin-chat-send.ts`): lo
// usan estas rutas y el worker, cuando Kairós responde solo en los chats.
export {
  CHAT_CHANNEL_WORDS,
  type ChatSendDeps,
  type ChatSendOutcome,
  chatChannelOff,
  chatSenderOf,
  INSTAGRAM_TEXT_BYTES,
  sendChatOutreach,
} from "@odentia/services"
