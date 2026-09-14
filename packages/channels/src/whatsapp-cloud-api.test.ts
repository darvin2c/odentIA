import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import whatsappFixtures from "./__fixtures__/whatsapp.json";
import { runAdapterContract, type ContractFixtures } from "./contract.js";
import { whatsappCloudApiAdapter } from "./whatsapp-cloud-api.js";

// Golden JSON con forma oficial de Cloud API; el contrato lo valida en runtime.
const fx: ContractFixtures = whatsappFixtures as unknown as ContractFixtures;

it("pasa el contrato del adaptador WhatsApp", async () => {
  await runAdapterContract(whatsappCloudApiAdapter, fx);
});

it("verify calcula HMAC sobre el raw exacto", () => {
  const rawBody = '{"object":"whatsapp_business_account"}';
  const sig = `sha256=${createHmac("sha256", "appsecret123").update(rawBody, "utf8").digest("hex")}`;
  expect(
    whatsappCloudApiAdapter.verifyWebhook({
      headers: { "X-Hub-Signature-256": sig },
      rawBody,
      config: fx.config,
      webhookSecret: "cualquiera",
    }),
  ).toBe(true);
  expect(
    whatsappCloudApiAdapter.verifyWebhook({
      headers: { "X-Hub-Signature-256": sig },
      rawBody: `${rawBody} `,
      config: fx.config,
      webhookSecret: "cualquiera",
    }),
  ).toBe(false);
});

it("sendMessage exige phoneNumberId", async () => {
  await expect(
    whatsappCloudApiAdapter.sendMessage({}, { to: "wa:1", kind: { type: "text", text: "hola" } }, { fetch }),
  ).rejects.toThrow("phoneNumberId");
});

it("fetchMedia resuelve url firmada y descarga con Bearer", async () => {
  const bytes = new TextEncoder().encode("fake-audio");
  const seen: { url: string; auth: string | null }[] = [];
  const stub = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(url), auth: init?.headers?.["Authorization"] ?? null });
    if (String(url).includes("graph.facebook.com")) {
      return new Response(JSON.stringify({ url: "https://cdn.example.com/m", mime_type: "audio/ogg" }), {
        status: 200,
      });
    }
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
  const got = await whatsappCloudApiAdapter.fetchMedia?.(fx.config, "media-1", { fetch: stub });
  expect(got?.filename).toBe("media-1.ogg");
  expect(got?.mimeType).toBe("audio/ogg");
  expect(seen).toEqual([
    { url: "https://graph.facebook.com/v21.0/media-1", auth: "Bearer TOKEN" },
    { url: "https://cdn.example.com/m", auth: "Bearer TOKEN" },
  ]);
});

it("validateConnection usa verified_name", async () => {
  const stub = (async () =>
    new Response(
      JSON.stringify({ id: "PNID", display_phone_number: "511999888777", verified_name: "Clínica" }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const got = await whatsappCloudApiAdapter.validateConnection(fx.config, { fetch: stub });
  expect(got).toEqual({ externalId: "PNID", displayName: "Clínica" });
});
