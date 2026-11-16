import type { Db } from "@odentia/db"
import { type KairosImproveAsk, type KairosImproveWriter, ServiceError } from "@odentia/services"
import { type Context, Hono, type Next } from "hono"
import { describe, expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createKairosImproveRoute, KAIROS_IMPROVE_PER_MINUTE } from "./admin-kairos-improve.js"

/**
 * «Mejorar con Kairós» sin base: sin conversación ni correo, el contexto no lee nada
 * (`kairosImproveContext` solo mira el rol), así que la transacción solo corre lo que le dan.
 * Lo que lee de un chat o de un hilo lo prueba `admin-kairos.test.ts` contra Postgres.
 */
const ownerDb = {
  transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn({} as Db),
} as unknown as Db

function appWith(
  kairos: KairosImproveWriter | undefined,
  options: { now?: () => number; timeoutMs?: number } = {},
) {
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    const userId = c.req.header("x-test-user")
    if (userId) c.set("adminActor", { userId, role: c.req.header("x-test-role") ?? "admin" })
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.route(
    "/improve",
    createKairosImproveRoute({ ownerDb, ...(kairos ? { kairos } : {}), ...options }),
  )
  return app
}

function ask(app: Hono, body: unknown, who = "kr-ana", role = "admin") {
  return app.request("/improve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": who, "x-test-role": role },
    body: JSON.stringify(body),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: el cuerpo de una respuesta de prueba se lee suelto
const read = async (response: Response): Promise<any> => response.json()

/** Un escritor que responde lo que se le diga y guarda lo que recibió. */
function scripted(
  answer: (input: KairosImproveAsk) => ReturnType<KairosImproveWriter["improveText"]>,
) {
  const asks: KairosImproveAsk[] = []
  const writer: KairosImproveWriter = {
    improveText: (input) => {
      asks.push(input)
      return answer(input)
    },
  }
  return { writer, asks }
}

describe("POST /improve", () => {
  it("sin el modelo, el doble por reglas lo corrige y lo dice", async () => {
    const res = await ask(appWith(undefined), {
      text: "hola rosa,te escribo  por la presentacion del lunes a las 10",
      channel: "whatsapp",
    })
    expect(res.status).toBe(200)
    expect((await read(res)).data).toEqual({
      text: "Hola rosa, te escribo por la presentación del lunes a las 10.",
      changed: true,
      drafter: "plantilla",
    })
  })

  it("con el modelo devuelve su propuesta; sin conversación, el contexto va vacío", async () => {
    const { writer, asks } = scripted(async () => ({ ok: true, text: "Hola, Rosa." }))
    const res = await ask(appWith(writer), { text: "  hola rosa  ", channel: "correo" })
    expect(res.status).toBe(200)
    expect((await read(res)).data).toEqual({
      text: "Hola, Rosa.",
      changed: true,
      drafter: "modelo",
    })
    expect(asks).toEqual([{ text: "hola rosa", channel: "correo", context: { conversation: [] } }])
  })

  it("si ya estaba bien vuelve el mismo texto; si cambiaba datos o no devolvió nada, 422", async () => {
    const same = scripted(async () => ({ ok: false, why: "igual" }))
    const fine = await ask(appWith(same.writer), { text: "Hola, Rosa.", channel: "whatsapp" })
    expect(fine.status).toBe(200)
    expect((await read(fine)).data).toEqual({
      text: "Hola, Rosa.",
      changed: false,
      drafter: "modelo",
    })

    const inventing = scripted(async () => ({ ok: false, why: "inventaba" }))
    const changed = await ask(appWith(inventing.writer), { text: "a las 10", channel: "whatsapp" })
    expect(changed.status).toBe(422)
    expect((await read(changed)).error).toMatchObject({
      code: "KAIROS_IMPROVE_REJECTED",
      message: "Kairós no pudo mejorarlo sin cambiar datos; envíalo como está o cámbialo tú",
    })

    const blank = scripted(async () => ({ ok: false, why: "vacio" }))
    const nothing = await ask(appWith(blank.writer), { text: "hola", channel: "whatsapp" })
    expect(nothing.status).toBe(422)
    expect((await read(nothing)).error.code).toBe("KAIROS_IMPROVE_REJECTED")
  })

  it("si el modelo falla o tarda más de su tiempo, 502 y la llamada se corta", async () => {
    const broken = scripted(async () => {
      throw new Error("503 del proveedor")
    })
    const failed = await ask(appWith(broken.writer), { text: "hola", channel: "messenger" })
    expect(failed.status).toBe(502)
    expect((await read(failed)).error.code).toBe("KAIROS_UNAVAILABLE")

    let signal: AbortSignal | undefined
    const slow: KairosImproveWriter = {
      improveText: (_input, options) => {
        signal = options?.signal
        return new Promise(() => {})
      },
    }
    const late = await ask(appWith(slow, { timeoutMs: 20 }), { text: "hola", channel: "instagram" })
    expect(late.status).toBe(502)
    expect(signal?.aborted).toBe(true)
  })

  it("solo Administración y con un cuerpo válido, sin llegar a Kairós", async () => {
    const { writer, asks } = scripted(async () => ({ ok: true, text: "Hola." }))
    const app = appWith(writer)
    expect(
      (await ask(app, { text: "hola", channel: "whatsapp" }, "kr-sofia", "support")).status,
    ).toBe(403)
    const badChannel = await ask(app, { text: "hola", channel: "sms" })
    expect(badChannel.status).toBe(400)
    expect(Object.keys((await read(badChannel)).error.fields)).toEqual(["channel"])
    const tooLong = await ask(app, { text: "a".repeat(5001), channel: "correo" })
    expect(tooLong.status).toBe(400)
    const extra = await ask(app, { text: "hola", channel: "correo", send: true })
    expect(extra.status).toBe(400)
    expect(asks).toEqual([])
  })

  it(`más de ${KAIROS_IMPROVE_PER_MINUTE} por minuto y por persona: 429 hasta que pasa el minuto`, async () => {
    let now = 1_000_000
    const { writer } = scripted(async () => ({ ok: true, text: "Hola." }))
    const app = appWith(writer, { now: () => now })
    for (let i = 0; i < KAIROS_IMPROVE_PER_MINUTE; i += 1)
      expect((await ask(app, { text: "hola", channel: "whatsapp" })).status).toBe(200)
    const limited = await ask(app, { text: "hola", channel: "whatsapp" })
    expect(limited.status).toBe(429)
    expect((await read(limited)).error.code).toBe("RATE_LIMITED")
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0)
    // Otra persona del equipo sigue pudiendo.
    expect((await ask(app, { text: "hola", channel: "whatsapp" }, "kr-otra")).status).toBe(200)
    now += 60_001
    expect((await ask(app, { text: "hola", channel: "whatsapp" })).status).toBe(200)
  })
})
