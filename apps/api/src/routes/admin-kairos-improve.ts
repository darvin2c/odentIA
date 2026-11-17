import { fakeKairosWriter } from "@odentia/agent"
import type { Db } from "@odentia/db"
import {
  KAIROS_IMPROVE_CHANNELS,
  KAIROS_IMPROVE_TEXT_MAX,
  type KairosImproveContext,
  type KairosImproveResult,
  type KairosImproveWriter,
  kairosImproveContext,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { serviceErrorResponse, validationError } from "./helpers.js"

/**
 * «Mejorar con Kairós» (`POST /api/admin/kairos/improve`, ADR 0196): Kairós
 * corrige y aclara lo que escribió una persona de Administración en el editor
 * de respuesta, sin agregar cifras, horas, precios ni enlaces que no estaban
 * (si su propuesta los trae, no sale). Devuelve la propuesta y nada más: la
 * persona ve lo que cambiaría y elige; nunca envía ni guarda. La conversación
 * se lee en una transacción propietaria (`kairosImproveContext`) y el modelo
 * corre fuera de ella, con 20 s como mucho; su gasto va a `kairos_ai_usage`
 * con el uso `mejorar` (el `onUse` del escritor). Sin el escritor con modelo,
 * el doble por reglas (`drafter: "plantilla"`).
 */

/** Lo que espera al modelo como mucho, con la segunda vuelta si la primera agregaba datos. */
export const KAIROS_IMPROVE_TIMEOUT_MS = 20_000
/** Cuántas veces por minuto puede pedirlo una persona: lo de más, 429. */
export const KAIROS_IMPROVE_PER_MINUTE = 20
const WINDOW_MS = 60_000
/** Cuántas personas se cuentan a la vez: el equipo es chico; pasado el tope, se espera. */
const MAX_BUCKETS = 1_000

export interface KairosImproveDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app: solo la conexión propietaria. */
  ownerDb: Db
  /** El escritor de Kairós con modelo; sin él, el doble por reglas, sin gasto. */
  kairos?: KairosImproveWriter
  /** Solo las pruebas los cambian. */
  timeoutMs?: number
  now?: () => number
}

const improveBody = z
  .strictObject({
    text: z
      .string("Escribe el mensaje")
      .trim()
      .min(1, "Escribe el mensaje")
      .max(KAIROS_IMPROVE_TEXT_MAX, `El mensaje va hasta ${KAIROS_IMPROVE_TEXT_MAX} caracteres`),
    channel: z.enum(
      KAIROS_IMPROVE_CHANNELS,
      "Elige el canal: correo, WhatsApp, Instagram o Messenger",
    ),
    chatId: z.uuid("La conversación no es válida").optional(),
    emailId: z.uuid("El correo no es válido").optional(),
  })
  .refine((body) => !(body.chatId && body.emailId), {
    message: "Elige la conversación o el correo, no los dos",
    path: ["emailId"],
  })

const REJECTED: Record<Exclude<KairosImproveResult, { ok: true }>["why"], string> = {
  inventaba: "Kairós no pudo mejorarlo sin cambiar datos; envíalo como está o cámbialo tú",
  vacio: "Kairós no devolvió el texto; envíalo como está o cámbialo tú",
  igual: "Ya estaba bien escrito",
}

function rateLimited(c: Context, waitMs: number) {
  c.header("Retry-After", String(Math.max(1, Math.ceil(waitMs / 1000))))
  return c.json(
    errorBody(c, "RATE_LIMITED", "Pediste mejorar muchas veces seguidas; espera un momento"),
    429,
  )
}

/** Corta lo que tarda: después de `ms` se aborta la llamada y se responde como una falla del modelo. */
async function withTimeout<T>(
  run: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("Kairós tardó demasiado"))
    }, ms)
  })
  try {
    return await Promise.race([run, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createKairosImproveRoute(deps: KairosImproveDeps) {
  const app = new Hono()
  const writer = deps.kairos ?? fakeKairosWriter
  const clock = deps.now ?? Date.now
  /** Por persona: cuántas pidió en el minuto que corre (en memoria, por proceso). */
  const buckets = new Map<string, { expiresAt: number; count: number }>()

  app.post("/", async (c) => {
    const actor = adminContextOf(c)
    if (actor.role !== "admin")
      return c.json(errorBody(c, "FORBIDDEN", "«Mejorar con Kairós» es de Administración"), 403)
    const parsed = improveBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)

    // Lo que cuesta es el modelo: cuenta lo que llega hasta él, no un cuerpo mal armado.
    const at = clock()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= at) buckets.delete(key)
    let bucket = buckets.get(actor.userId)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) return rateLimited(c, WINDOW_MS)
      bucket = { expiresAt: at + WINDOW_MS, count: 0 }
      buckets.set(actor.userId, bucket)
    }
    if (bucket.count >= KAIROS_IMPROVE_PER_MINUTE) return rateLimited(c, bucket.expiresAt - at)
    bucket.count += 1

    const { text, channel, chatId, emailId } = parsed.data
    let context: KairosImproveContext
    try {
      context = await deps.ownerDb.transaction((tx) =>
        kairosImproveContext(tx as Db, actor, { chatId: chatId ?? null, emailId: emailId ?? null }),
      )
    } catch (error) {
      const response = serviceErrorResponse(c, error)
      if (response) return response
      throw error
    }

    const controller = new AbortController()
    let result: KairosImproveResult
    try {
      result = await withTimeout(
        writer.improveText({ text, channel, context }, { signal: controller.signal }),
        deps.timeoutMs ?? KAIROS_IMPROVE_TIMEOUT_MS,
        controller,
      )
    } catch (error) {
      // Sin el texto de la persona en el registro: solo qué falló.
      console.error(
        "Kairós: no pudo mejorar un texto",
        error instanceof Error ? error.message.slice(0, 200) : "error desconocido",
      )
      return c.json(
        errorBody(
          c,
          "KAIROS_UNAVAILABLE",
          "Kairós no pudo mejorarlo ahora: envíalo como está o vuelve a intentarlo",
        ),
        502,
      )
    }
    const drafter = writer.drafter ?? "modelo"
    if (result.ok) return c.json({ data: { text: result.text, changed: true, drafter } })
    // Ya estaba bien: vuelve el mismo texto y la pantalla lo dice.
    if (result.why === "igual") return c.json({ data: { text, changed: false, drafter } })
    return c.json(errorBody(c, "KAIROS_IMPROVE_REJECTED", REJECTED[result.why]), 422)
  })

  return app
}
