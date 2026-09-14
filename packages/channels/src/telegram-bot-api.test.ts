import { expect, it } from "vitest";
import telegramFixtures from "./__fixtures__/telegram.json";
import { createStubFetch, runAdapterContract, type CapturedRequest, type ContractFixtures } from "./contract.js";
import { pollTelegramUpdates, setTelegramWebhook, telegramBotApiAdapter } from "./telegram-bot-api.js";

// Golden JSON con forma oficial de Bot API; el contrato lo valida en runtime.
const fx: ContractFixtures = telegramFixtures as unknown as ContractFixtures;

it("pasa el contrato del adaptador Telegram", async () => {
  await runAdapterContract(telegramBotApiAdapter, fx);
});

it("rechaza enviar plantillas", async () => {
  const captured: CapturedRequest[] = [];
  await expect(
    telegramBotApiAdapter.sendMessage(
      fx.config,
      { to: "tg:555", kind: { type: "template", name: "x", language: "es", params: [] } },
      { fetch: createStubFetch([{}], captured) },
    ),
  ).rejects.toThrow("plantillas");
  expect(captured).toEqual([]);
});

it("validateConnection resuelve getMe", async () => {
  const captured: CapturedRequest[] = [];
  const got = await telegramBotApiAdapter.validateConnection(fx.config, {
    fetch: createStubFetch([{ ok: true, result: { id: 123, username: "mibot", first_name: "Mi" } }], captured),
  });
  expect(got).toEqual({ externalId: "123", displayName: "@mibot" });
  expect(captured[0]?.url).toBe("https://api.telegram.org/botTESTTOKEN/getMe");
});

it("validateConnection falla con token inválido", async () => {
  await expect(
    telegramBotApiAdapter.validateConnection(fx.config, {
      fetch: createStubFetch([{ ok: false, description: "Unauthorized" }], []),
    }),
  ).rejects.toThrow();
});

it("fetchMedia descarga vía getFile", async () => {
  const bytes = new TextEncoder().encode("fake-image");
  const calls: string[] = [];
  const stub = (async (url: unknown) => {
    calls.push(String(url));
    if (String(url).endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/big.jpg" } }), { status: 200 });
    }
    return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch;
  const got = await telegramBotApiAdapter.fetchMedia?.(fx.config, "file-1", { fetch: stub });
  expect(got).toEqual({ bytes: new Uint8Array(bytes), mimeType: "image/jpeg", filename: "big.jpg" });
  expect(calls).toEqual([
    "https://api.telegram.org/botTESTTOKEN/getFile",
    "https://api.telegram.org/file/botTESTTOKEN/photos/big.jpg",
  ]);
});

it("setTelegramWebhook registra url y secreto", async () => {
  const captured: CapturedRequest[] = [];
  await setTelegramWebhook(fx.config, "https://api.example.com/hook", "s3cret", {
    fetch: createStubFetch([{ ok: true, result: true }], captured),
  });
  expect(captured[0]?.url).toBe("https://api.telegram.org/botTESTTOKEN/setWebhook");
  expect(captured[0]?.body).toMatchObject({ url: "https://api.example.com/hook", secret_token: "s3cret" });
});

it("pollTelegramUpdates devuelve ids y siguiente offset", async () => {
  const captured: CapturedRequest[] = [];
  const got = await pollTelegramUpdates(
    { ...fx.config, pollingOffset: 9000 },
    {
      fetch: createStubFetch(
        [{ ok: true, result: [{ update_id: 9001 }, { update_id: 9002 }] }],
        captured,
      ),
    },
  );
  expect(got).toEqual({ updateIds: [9001, 9002], nextOffset: 9003 });
  expect(captured[0]?.url).toContain("offset=9000");
});
