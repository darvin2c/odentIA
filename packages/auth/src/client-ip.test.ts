import { createAppDb } from "@odentia/db"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clientIpAddress, createAuth } from "./index.js"

/**
 * Límite de intentos de Better Auth según la cabecera del proxy. Un inicio de
 * sesión con el cuerpo vacío responde 400 sin tocar la base, pero el límite ya
 * lo contó: 3 cada 10 s por dirección y luego 429.
 */
// postgres-js conecta en la primera consulta, y estas peticiones no llegan a ninguna.
const db = createAppDb("postgres://nadie@127.0.0.1:9/sin-base")

async function signInWith(clientIpHeader?: string) {
  const auth = createAuth({
    db,
    ownerDb: db,
    mailer: { send: async () => {} },
    secret: "x".repeat(32),
    baseURL: "https://api.example.test",
    webURL: "https://app.example.test",
    cookieDomain: "example.test",
    trustedOrigins: ["https://app.example.test"],
    googleClientId: "",
    googleClientSecret: "",
    clientIpHeader,
  })
  // Better Auth solo limita con NODE_ENV=production; aquí se enciende a mano.
  ;(await auth.$context).rateLimit.enabled = true
  return async (headers: Record<string, string>) => {
    const response = await auth.handler(
      new Request("https://api.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test", ...headers },
        body: "{}",
      }),
    )
    return response.status
  }
}

// El contador vive en memoria del proceso: cada prueba empieza un minuto después.
let now = Date.UTC(2026, 9, 17, 12)
beforeEach(() => {
  now += 60_000
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("IP de quien pide en Better Auth", () => {
  it("dos IP distintas no comparten el límite", async () => {
    const signIn = await signInWith("x-real-ip")
    for (let i = 0; i < 3; i++) expect(await signIn({ "x-real-ip": "198.51.100.7" })).toBe(400)
    expect(await signIn({ "x-real-ip": "198.51.100.7" })).toBe(429)
    expect(await signIn({ "x-real-ip": "203.0.113.20" })).toBe(400)
  })

  it("otra cabecera no estrena límite: cf-connecting-ip y x-forwarded-for las escribe el cliente", async () => {
    const signIn = await signInWith("x-real-ip")
    for (let i = 0; i < 3; i++) {
      await signIn({ "x-real-ip": "198.51.100.8", "cf-connecting-ip": `203.0.113.${i}`, "x-forwarded-for": `192.0.2.${i}` })
    }
    expect(await signIn({ "x-real-ip": "198.51.100.8", "cf-connecting-ip": "203.0.113.99", "x-forwarded-for": "192.0.2.99" })).toBe(429)
  })

  // En pruebas Better Auth anota 127.0.0.1 a quien no tiene IP; en producción,
  // `no-trusted-ip`. En ambos casos es un único límite para todos.
  it("sin la cabecera, o con varias direcciones en ella, todos comparten un límite: nunca sin límite", async () => {
    const signIn = await signInWith("x-real-ip")
    for (let i = 0; i < 3; i++) {
      expect(await signIn({ "cf-connecting-ip": `203.0.113.${i}`, "x-forwarded-for": `192.0.2.${i}` })).toBe(400)
    }
    expect(await signIn({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": "192.0.2.50" })).toBe(429)
    expect(await signIn({ "x-real-ip": "198.51.100.9, 198.51.100.10" })).toBe(429)
  })

  it("vacía, no cree a ninguna cabecera, tampoco a la x-forwarded-for que Better Auth usa por defecto", async () => {
    const signIn = await signInWith(undefined)
    for (let i = 0; i < 3; i++) expect(await signIn({ "x-forwarded-for": `192.0.2.${i}`, "x-real-ip": `198.51.100.${i}` })).toBe(400)
    expect(await signIn({ "x-forwarded-for": "192.0.2.77", "x-real-ip": "198.51.100.77" })).toBe(429)
  })

  it("una sola cabecera, en minúsculas", () => {
    expect(clientIpAddress("X-Real-IP")).toEqual({ ipAddressHeaders: ["x-real-ip"] })
    expect(clientIpAddress("")).toEqual({ ipAddressHeaders: [] })
    expect(clientIpAddress(undefined)).toEqual({ ipAddressHeaders: [] })
  })
})
