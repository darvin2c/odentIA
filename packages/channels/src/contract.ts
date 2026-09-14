// Batería de contrato compartida: todo adaptador nuevo la pasa con sus
// fixtures golden (forma oficial documentada de cada proveedor, sin red).
import assert from "node:assert/strict";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js";

export interface VerifyCase {
  name: string;
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  expect: boolean;
}

export interface ParseCase {
  name: string;
  rawBody: string;
  expected: WebhookParseResult;
}

export interface SendCase {
  name: string;
  message: OutboundMessage;
  respondWith: unknown;
  expectUrl: string;
  expectBody: Record<string, unknown>;
  expectExternalId: string;
}

export interface ContractFixtures {
  config: Record<string, unknown>;
  capabilities: ChannelCapabilities;
  verify: VerifyCase[];
  parse: ParseCase[];
  send: SendCase[];
}

export interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** fetch stub que captura el request y responde JSON encolado. */
export function createStubFetch(responses: unknown[], captured: CapturedRequest[]): typeof fetch {
  const queue = [...responses];
  const stub = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    } else {
      body = init?.body;
    }
    captured.push({ url: String(url), method: init?.method ?? "GET", body });
    const next = queue.shift();
    return new Response(JSON.stringify(next ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return stub;
}

function assertSubset(actual: unknown, expected: Record<string, unknown>, path = ""): void {
  assert.ok(actual && typeof actual === "object", `cuerpo no es objeto en ${path || "raíz"}`);
  for (const [key, value] of Object.entries(expected)) {
    const child: unknown = (actual as Record<string, unknown>)[key];
    const at = path ? `${path}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertSubset(child, value as Record<string, unknown>, at);
    } else {
      assert.deepEqual(child, value, `desajuste en ${at}`);
    }
  }
}

function parseIds(result: WebhookParseResult): { events: string[]; messages: string[] } {
  return {
    events: result.messages.map((m) => m.externalEventId),
    messages: result.messages.map((m) => m.externalMessageId),
  };
}

/**
 * Verifica: capabilities, verify acepta/rechaza, parse golden, send construye
 * el request correcto, e ids de dedupe estables entre parses.
 */
export async function runAdapterContract(adapter: ChannelAdapter, fx: ContractFixtures): Promise<void> {
  assert.deepEqual(adapter.capabilities, fx.capabilities, "capabilities");

  for (const v of fx.verify) {
    const got = adapter.verifyWebhook({
      headers: v.headers,
      rawBody: v.rawBody,
      config: fx.config,
      webhookSecret: v.secret,
    });
    assert.equal(got, v.expect, `verify: ${v.name}`);
  }

  for (const p of fx.parse) {
    const got = adapter.parseWebhook({ headers: {}, rawBody: p.rawBody, config: fx.config });
    assert.deepEqual(got, p.expected, `parse: ${p.name}`);
  }

  for (const s of fx.send) {
    const captured: CapturedRequest[] = [];
    const got = await adapter.sendMessage(fx.config, s.message, {
      fetch: createStubFetch([s.respondWith], captured),
    });
    assert.equal(got.externalId, s.expectExternalId, `send externalId: ${s.name}`);
    assert.equal(captured.length, 1, `send requests: ${s.name}`);
    assert.equal(captured[0]?.url, s.expectUrl, `send url: ${s.name}`);
    assert.equal(captured[0]?.method, "POST", `send método: ${s.name}`);
    assertSubset(captured[0]?.body, s.expectBody, `send body: ${s.name}`);
  }

  for (const p of fx.parse) {
    const input = { headers: {}, rawBody: p.rawBody, config: fx.config };
    assert.deepEqual(parseIds(adapter.parseWebhook(input)), parseIds(adapter.parseWebhook(input)), `ids: ${p.name}`);
  }
}
