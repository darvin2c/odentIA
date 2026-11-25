/**
 * El entorno del recorrido de gestorIA en un navegador (ADR 0214): su base de verdad
 * (testcontainers), su servidor de verdad (`createApp`), una cuenta de mentira que firma el token
 * de quien se elija y una administración de mentira que responde el estado de la tienda. Siembra
 * una tienda abierta por la administración, un pedido de soporte por aceptar y una conversación
 * que espera a una persona porque Sofi está apagada. Solo pruebas: nunca corre en producción.
 *
 * La cuenta de mentira: `GET /api/auth/get-session` y `/api/auth/token` responden por quien diga
 * `POST /__como/<persona>` (`nadie`: sin sesión), o por quien entró con su correo y `CLAVE`.
 * También lo de Mi perfil que usa el recorrido de la cuenta (ADR 0216): cambiar la contraseña
 * (la actual es `CLAVE`; la nueva no se guarda) y activar los dos pasos con el código
 * `CODIGO_TOTP`. `GET /__cuenta` dice lo que pidió la pantalla. Sin la red: ningún proveedor real.
 */
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { conversation, conversationMessage } from "@gestoria/db"
import { startTestDb } from "@gestoria/db/testing"
import { serve } from "@hono/node-server"
import {
  type AccountState,
  type AdminRequest,
  APP_CONTRACT_PATHS,
  CONTRACT_PATHS,
} from "@odentia/contract"
import { signMessage } from "@odentia/contract/signing"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { createApp } from "../apps/api/src/app.js"
import { defaultLinkAdapters } from "../apps/api/src/link-de-pago.js"
import { answer } from "../apps/api/src/sofi/sofi.js"
import {
  ACCOUNT_PORT,
  API_PORT,
  CLAVE,
  CODIGO_TOTP,
  PEOPLE,
  STORE_ID,
  WEB_PORT,
  type Who,
} from "./entorno.js"

const ACCOUNT = `http://127.0.0.1:${ACCOUNT_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`
const SECRET = `whsec_${Buffer.alloc(32, 3).toString("base64")}`

const db = await startTestDb()
const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "e2e" }

/** El estado que respondería la administración: un cobro por pagar y cómo pagarlo. */
function stateOf(account: string): AccountState {
  const at = new Date().toISOString()
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
  return {
    account,
    found: account === STORE_ID,
    at,
    access: { allowed: true, status: "activa", reason: null, readOnlyAt: null, trialEndsAt: null },
    agents: { trialExhausted: false, capReached: false },
    budget: {
      currency: "USD",
      creditCents: 500,
      creditUsedCents: 200,
      capCents: 3000,
      spentCents: 900,
      periodStart: day(-10),
      periodEnd: day(20),
    },
    plan: { code: "tienda", name: "Tienda", currency: "USD", priceCents: 1900, creditCents: 500 },
    charges: [
      {
        id: "cargo-e2e",
        periodStart: day(-40),
        periodEnd: day(-10),
        amountCents: 2380,
        paidCents: 0,
        currency: "USD",
        status: "pendiente",
        dueAt: day(5),
        lines: [{ kind: "plan", description: "Plan Tienda", quantity: 1, amountCents: 2380 }],
      },
    ],
    payments: [],
    notices: [],
    paymentMethods: [
      { code: "yape", name: "Yape", instructions: "Yapea al 999 000 000 y sube la captura." },
      { code: "transferencia", name: "Transferencia", instructions: null },
    ],
    support: [],
  }
}

const adminFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.pathname === CONTRACT_PATHS.state) {
    const { account } = JSON.parse(String(init?.body ?? "{}")) as { account: string }
    return Response.json(stateOf(account))
  }
  return Response.json({ received: true, repeated: false })
}

const contract = { url: ACCOUNT, secret: SECRET, fetch: adminFetch }
const app = createApp({
  appDb: db.appDb,
  ownerDb: db.ownerDb,
  account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
  webURL: WEB,
  link: {
    adapters: defaultLinkAdapters(),
    secretsKey: null,
    apiURL: `http://127.0.0.1:${API_PORT}`,
  },
  contract,
})

/** Un pedido de la administración, firmado como lo firmaría ella. */
async function ask(request: AdminRequest) {
  const body = JSON.stringify(request)
  const response = await app.request(`http://127.0.0.1:${API_PORT}${APP_CONTRACT_PATHS.requests}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signMessage({ secret: SECRET, id: randomUUID(), body }),
    },
    body,
  })
  const result = (await response.json()) as { status?: string; message?: string }
  if (result.status !== "hecho")
    throw new Error(`El pedido ${request.type} no se hizo: ${JSON.stringify(result)}`)
}

const rosa = PEOPLE.rosa
const now = () => new Date().toISOString()
await ask({
  type: "cuenta.abrir",
  timestamp: now(),
  data: {
    account: STORE_ID,
    name: "Calzados Rosa",
    currency: "PEN",
    country: "PE",
    owner: { userId: rosa.id, name: rosa.name, email: rosa.email },
  },
})
await ask({
  type: "soporte.entrar",
  timestamp: now(),
  data: {
    account: STORE_ID,
    staff: { userId: PEOPLE.ana.id, name: PEOPLE.ana.name, email: PEOPLE.ana.email },
    minutes: 30,
    reason: "Ver contigo por qué no se ven las fotos del catálogo",
  },
})
// Una clienta escribe y Sofi está apagada: la conversación pasa a una persona, con el motivo.
const [conv] = await db.ownerDb
  .insert(conversation)
  .values({ storeId: STORE_ID, channel: "whatsapp", createdBy: rosa.id, customerName: "Carla" })
  .returning({ id: conversation.id })
await db.ownerDb.insert(conversationMessage).values({
  storeId: STORE_ID,
  conversationId: conv!.id,
  author: "cliente",
  text: "Hola, ¿tienen sandalias talla 38?",
  actorUserId: rosa.id,
})
const sofi = await answer(
  {
    appDb: db.appDb,
    lockDb: db.ownerDb,
    model: null,
    link: { adapters: defaultLinkAdapters(), secretsKey: null, apiURL: WEB },
  },
  STORE_ID,
  conv!.id,
)
if (sofi.status !== "apagada") throw new Error(`Sofi debía estar apagada: ${sofi.status}`)

serve({ fetch: app.fetch, port: API_PORT, hostname: "127.0.0.1" })

// La cuenta de mentira, con las cabeceras que pide la pantalla (credenciales, su origen).
let current: Who | null = "rosa"
/** Quién activó los dos pasos y lo que pidió Mi perfil (para que el recorrido lo compruebe). */
const twoFactorOn = new Set<Who>()
const asked: Array<{ path: string; body: Record<string, unknown> }> = []
const readBody = async (request: import("node:http").IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>
}
const account = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", ACCOUNT)
  const headers = {
    "access-control-allow-origin": WEB,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json",
  }
  const json = (status: number, value: unknown) => {
    response.writeHead(status, headers)
    response.end(JSON.stringify(value))
  }
  if (request.method === "OPTIONS") return json(204, {})
  const como = /^\/__como\/(\w+)$/.exec(url.pathname)?.[1]
  if (request.method === "POST" && como && (como in PEOPLE || como === "nadie")) {
    current = como === "nadie" ? null : (como as Who)
    return json(200, { como })
  }
  if (request.method === "GET" && url.pathname === "/__cuenta") return json(200, { asked })
  // Entrar con correo y contraseña (la de todas es `CLAVE`) y cerrar la sesión.
  if (request.method === "POST" && url.pathname === "/api/auth/sign-in/email") {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      email?: string
      password?: string
    }
    const who = (Object.keys(PEOPLE) as Who[]).find((key) => PEOPLE[key].email === body.email)
    if (!who || body.password !== CLAVE)
      return json(401, {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      })
    current = who
    const person = PEOPLE[who]
    return json(200, {
      redirect: false,
      token: `t-${person.id}`,
      user: { id: person.id, email: person.email, name: person.name, emailVerified: true },
    })
  }
  if (request.method === "POST" && url.pathname === "/api/auth/sign-out") {
    current = null
    return json(200, { success: true })
  }
  if (!current) {
    if (url.pathname === "/api/auth/get-session") return json(200, null)
    return json(401, { message: "Sin sesión" })
  }
  const p = PEOPLE[current]
  if (url.pathname === "/api/auth/get-session")
    return json(200, {
      session: {
        id: `s-${p.id}`,
        userId: p.id,
        token: `t-${p.id}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      user: { id: p.id, email: p.email, name: p.name, emailVerified: true, image: null },
    })
  // Mi perfil (ADR 0216): los dos pasos, las sesiones y la contraseña de quien entró.
  if (request.method === "GET" && url.pathname === "/api/account/two-factor")
    return json(200, {
      data: {
        enabled: twoFactorOn.has(current),
        staff: false,
        hasPassword: true,
        requiredBy: [],
        trustedBrowsers: 0,
      },
    })
  if (request.method === "GET" && url.pathname === "/api/auth/list-sessions")
    return json(200, [
      {
        id: `s-${p.id}`,
        token: `t-${p.id}`,
        userAgent: request.headers["user-agent"] ?? null,
        ipAddress: "127.0.0.1",
        updatedAt: new Date().toISOString(),
      },
    ])
  if (request.method === "POST" && url.pathname.startsWith("/api/auth/")) {
    const body = await readBody(request)
    const path = url.pathname.slice("/api/auth".length)
    asked.push({ path, body })
    const user = { id: p.id, email: p.email, name: p.name, emailVerified: true }
    if (path === "/change-password" || path === "/two-factor/enable") {
      const password = path === "/change-password" ? body.currentPassword : body.password
      if (password !== CLAVE)
        return json(400, { code: "INVALID_PASSWORD", message: "Invalid password" })
      if (path === "/change-password") return json(200, { token: `t-${p.id}`, user })
      return json(200, {
        method: "totp",
        totpURI: `otpauth://totp/gestorIA:${encodeURIComponent(p.email)}?secret=JBSWY3DPEHPK3PXP&issuer=gestorIA`,
        backupCodes: ["aaaa1-bbbb1", "aaaa2-bbbb2", "aaaa3-bbbb3", "aaaa4-bbbb4"],
      })
    }
    if (path === "/two-factor/verify-totp") {
      if (body.code !== CODIGO_TOTP)
        return json(401, { code: "INVALID_CODE", message: "Invalid code" })
      twoFactorOn.add(current)
      return json(200, { token: `t-${p.id}`, user })
    }
  }
  if (url.pathname === "/api/auth/token") {
    const iat = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      email: p.email,
      emailVerified: true,
      name: p.name,
      image: null,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "e2e" })
      .setSubject(p.id)
      .setIssuer(ACCOUNT)
      .setAudience("gestoria")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(pair.privateKey)
    return json(200, { token })
  }
  return json(404, { message: "No existe en la cuenta de mentira" })
})
account.listen(ACCOUNT_PORT, "127.0.0.1")
console.log(`gestoria-e2e: listo (servidor ${API_PORT}, cuenta ${ACCOUNT_PORT})`)

const stop = async () => {
  account.close()
  await db.stop()
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
process.on("SIGINT", () => void stop())
