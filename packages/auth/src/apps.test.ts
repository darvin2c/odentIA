import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { createAppDb } from "@odentia/db"
import { describe, expect, it } from "vitest"
import {
  ACCOUNT_APP_INFO,
  ACCOUNT_APPS,
  accountAppNotReady,
  appOfProduct,
  createAuth,
  EXTERNAL_ACCOUNT_APPS,
  isAccountApp,
} from "./index.js"

// postgres-js conecta en la primera consulta, y estas peticiones no llegan a ninguna.
const db = createAppDb("postgres://nadie@127.0.0.1:9/sin-base")
const options = {
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
}

describe("las apps de la cuenta (ADR 0201)", () => {
  it("cada producto de clínicas es una app, con su nombre y la marca de sus correos", () => {
    expect(CLINICAL_PRODUCTS.map(appOfProduct)).toEqual(["odentia", "latidia", "vistia"])
    for (const product of CLINICAL_PRODUCTS) {
      const info = ACCOUNT_APP_INFO[appOfProduct(product)]
      expect(info.product).toBe(product)
      expect(info.mailBrand).toBe(appOfProduct(product))
    }
    expect(ACCOUNT_APPS).toContain("gestoria")
    expect(isAccountApp("gestoria")).toBe(true)
    expect(isAccountApp("dental")).toBe(false)
  })

  it("gestorIA es otro sistema: recibe los avisos y su entrada no se enciende sin la marca de sus correos", () => {
    expect(EXTERNAL_ACCOUNT_APPS).toEqual(["gestoria"])
    expect(accountAppNotReady("gestoria")).toMatch(/gestorIA/)
    expect(accountAppNotReady("latidia")).toBeNull()
    // Nunca una entrada que mande la verificación con la marca de otra app.
    expect(() => createAuth({ ...options, app: "gestoria" })).toThrow(/gestorIA/)
  })

  it("sin token firmado, sus rutas no existen", async () => {
    const auth = createAuth(options)
    for (const path of ["/api/auth/token", "/api/auth/jwks"]) {
      const response = await auth.handler(new Request(`https://api.example.test${path}`))
      expect(response.status, path).toBe(404)
    }
  })
})
