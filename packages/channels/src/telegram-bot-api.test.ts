import { expect, it } from "vitest"
import telegramFixtures from "./__fixtures__/telegram.json"
import {
  type CapturedRequest,
  type ContractFixtures,
  createStubFetch,
  runAdapterContract,
} from "./contract.js"
import { setTelegramWebhook, telegramBotApiAdapter } from "./telegram-bot-api.js"

// Golden JSON con forma oficial de Bot API; el contrato lo valida en runtime.
const fx: ContractFixtures = telegramFixtures as unknown as ContractFixtures

it("pasa el contrato del adaptador Telegram", async () => {
  await runAdapterContract(telegramBotApiAdapter, fx)
})

it("rechaza enviar plantillas", async () => {
  const captured: CapturedRequest[] = []
  await expect(
    telegramBotApiAdapter.sendMessage(
      fx.config,
      { to: "tg:555", kind: { type: "template", name: "x", language: "es", params: [] } },
      { fetch: createStubFetch([{}], captured) },
    ),
  ).rejects.toThrow("plantillas")
  expect(captured).toEqual([])
})

it("validateConnection resuelve getMe", async () => {
  const captured: CapturedRequest[] = []
  const got = await telegramBotApiAdapter.validateConnection(fx.config, {
    fetch: createStubFetch(
      [{ ok: true, result: { id: 123, username: "mibot", first_name: "Mi" } }],
      captured,
    ),
  })
  expect(got).toEqual({ externalId: "123", displayName: "@mibot", account: { name: "Mi", number: "@mibot" } })
  expect(captured[0]?.url).toBe("https://api.telegram.org/botTESTTOKEN/getMe")
})

it("validateConnection falla con token inválido", async () => {
  await expect(
    telegramBotApiAdapter.validateConnection(fx.config, {
      fetch: createStubFetch([{ ok: false, description: "Unauthorized" }], []),
    }),
  ).rejects.toThrow()
})

it("fetchMedia descarga vía getFile", async () => {
  const bytes = new TextEncoder().encode("fake-image")
  const calls: string[] = []
  const stub = (async (url: unknown) => {
    calls.push(String(url))
    if (String(url).endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/big.jpg" } }), {
        status: 200,
      })
    }
    return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } })
  }) as unknown as typeof fetch
  const got = await telegramBotApiAdapter.fetchMedia?.(fx.config, "file-1", { fetch: stub })
  expect(got).toEqual({
    bytes: new Uint8Array(bytes),
    mimeType: "image/jpeg",
    filename: "big.jpg",
  })
  expect(calls).toEqual([
    "https://api.telegram.org/botTESTTOKEN/getFile",
    "https://api.telegram.org/file/botTESTTOKEN/photos/big.jpg",
  ])
})

it("setTelegramWebhook registra url y secreto", async () => {
  const captured: CapturedRequest[] = []
  await setTelegramWebhook(fx.config, "https://api.example.com/hook", "s3cret", {
    fetch: createStubFetch([{ ok: true, result: true }], captured),
  })
  expect(captured[0]?.url).toBe("https://api.telegram.org/botTESTTOKEN/setWebhook")
  expect(captured[0]?.body).toMatchObject({
    url: "https://api.example.com/hook",
    secret_token: "s3cret",
  })
})

// Cargas con la forma oficial de Bot API (Message con voice, audio, video,
// video_note, sticker, poll y location).
function parseTelegram(message: Record<string, unknown>) {
  return telegramBotApiAdapter.parseWebhook({
    headers: {},
    rawBody: JSON.stringify({
      update_id: 9100,
      message: {
        message_id: 77,
        date: 1735689600,
        chat: { id: 555, first_name: "Ana", type: "private" },
        from: { id: 555, is_bot: false, first_name: "Ana", language_code: "es" },
        ...message,
      },
    }),
    config: fx.config,
  })
}

it("una nota de voz entra como audio OGG para que se transcriba", () => {
  const got = parseTelegram({
    voice: {
      duration: 4,
      mime_type: "audio/ogg",
      file_id: "AwACAgEAAxkBAAIBc2Voz",
      file_unique_id: "AgADvoz",
      file_size: 18342,
    },
  })
  expect(got.messages).toHaveLength(1)
  expect(got.messages[0]?.content).toEqual({
    type: "media",
    mediaExternalId: "AwACAgEAAxkBAAIBc2Voz",
    mimeType: "audio/ogg",
  })
})

it("un audio entra como media de audio con su tipo y su texto", () => {
  const got = parseTelegram({
    audio: {
      duration: 95,
      performer: "Ana",
      title: "Consulta",
      file_name: "consulta.mp3",
      mime_type: "audio/mpeg",
      file_id: "CQACAgEAAxkBAAIBdGAudio",
      file_unique_id: "AgADaudio",
      file_size: 1520000,
    },
    caption: "Lo que me dijo el doctor",
  })
  expect(got.messages[0]?.content).toEqual({
    type: "media",
    mediaExternalId: "CQACAgEAAxkBAAIBdGAudio",
    mimeType: "audio/mpeg",
    caption: "Lo que me dijo el doctor",
  })
})

it("un video y un video redondo entran como media de video", () => {
  const video = parseTelegram({
    video: {
      duration: 6,
      width: 1280,
      height: 720,
      file_name: "encia.mp4",
      mime_type: "video/mp4",
      thumbnail: { file_id: "thumb", file_unique_id: "t", width: 320, height: 180 },
      file_id: "BAACAgEAAxkBAAIBdVideo",
      file_unique_id: "AgADvideo",
      file_size: 980000,
    },
    caption: "Así sangra",
  })
  expect(video.messages[0]?.content).toEqual({
    type: "media",
    mediaExternalId: "BAACAgEAAxkBAAIBdVideo",
    mimeType: "video/mp4",
    caption: "Así sangra",
  })
  // VideoNote no trae mime_type: Bot API lo envía siempre en MPEG-4.
  const note = parseTelegram({
    video_note: {
      duration: 3,
      length: 240,
      thumbnail: { file_id: "thumb", file_unique_id: "t", width: 240, height: 240 },
      file_id: "DQACAgEAAxkBAAIBdNote",
      file_unique_id: "AgADnote",
      file_size: 210000,
    },
  })
  expect(note.messages[0]?.content).toEqual({
    type: "media",
    mediaExternalId: "DQACAgEAAxkBAAIBdNote",
    mimeType: "video/mp4",
  })
})

it("sticker, encuesta y ubicación no entran como un mensaje vacío", () => {
  const sticker = parseTelegram({
    sticker: {
      width: 512,
      height: 512,
      emoji: "😀",
      set_name: "Saludos",
      is_animated: false,
      is_video: false,
      type: "regular",
      file_id: "CAACAgIAAxkBAAIBd2Sticker",
      file_unique_id: "AgADsticker",
      file_size: 23000,
    },
  })
  const poll = parseTelegram({
    poll: {
      id: "5",
      question: "¿Mañana o tarde?",
      options: [
        { text: "Mañana", voter_count: 0 },
        { text: "Tarde", voter_count: 0 },
      ],
      total_voter_count: 0,
      is_closed: false,
      is_anonymous: true,
      type: "regular",
      allows_multiple_answers: false,
    },
  })
  const location = parseTelegram({ location: { latitude: -12.0464, longitude: -77.0428 } })
  for (const got of [sticker, poll, location]) {
    expect(got).toEqual({ messages: [], statuses: [] })
  }
})

it("un documento sin tipo declarado no se toma por foto", () => {
  const got = parseTelegram({
    document: { file_name: "informe", file_id: "BQACAgEAAxkBAAIBdoc", file_unique_id: "AgADdoc" },
  })
  expect(got.messages[0]?.content).toEqual({
    type: "media",
    mediaExternalId: "BQACAgEAAxkBAAIBdoc",
    mimeType: "application/octet-stream",
  })
})

it("fetchMedia toma el tipo de la extensión cuando Telegram responde octet-stream", async () => {
  const stub = (async (url: unknown) => {
    if (String(url).endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file_12.oga" } }), {
        status: 200,
      })
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })
  }) as unknown as typeof fetch
  const got = await telegramBotApiAdapter.fetchMedia?.(fx.config, "voz", { fetch: stub })
  expect(got?.mimeType).toBe("audio/ogg")
  expect(got?.filename).toBe("file_12.oga")
})
