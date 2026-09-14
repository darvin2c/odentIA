export * from "./protocol.js";
export * from "./contract.js";
export { telegramBotApiAdapter, setTelegramWebhook, pollTelegramUpdates } from "./telegram-bot-api.js";
export { whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js";
import type { ChannelAdapter, ChannelProvider } from "./protocol.js";
import { telegramBotApiAdapter } from "./telegram-bot-api.js";
import { whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js";

/** Añadir proveedor = nuevo adaptador + entrada aquí + pruebas de contrato. */
export const channelAdapters: Record<ChannelProvider, ChannelAdapter> = {
  telegram_bot_api: telegramBotApiAdapter,
  whatsapp_cloud_api: whatsappCloudApiAdapter,
};
