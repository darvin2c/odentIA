import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { createAppDb } from "@odentia/db"
import { SAAS_ACCOUNT_EXTERNAL_APPS } from "@odentia/db/schema/admin-accounts"
import { describe, expect, it } from "vitest"
import {
  ACCOUNT_APP_INFO,
  ACCOUNT_APPS,
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
    // Solo una app que es otro sistema tiene cuentas de cliente sin clínica (ADR 0210).
    expect(EXTERNAL_ACCOUNT_APPS).toEqual([...SAAS_ACCOUNT_EXTERNAL_APPS])
    expect(isAccountApp("gestoria")).toBe(true)
    expect(isAccountApp("dental")).toBe(false)
  })

  it("gestorIA es otro sistema: recibe los avisos y su entrada sale con la marca de sus correos", () => {
    expect(EXTERNAL_ACCOUNT_APPS).toEqual(["gestoria"])
    // Nunca una entrada que mande la verificación con la marca de otra app.
    expect(ACCOUNT_APP_INFO.gestoria.mailBrand).toBe("gestoria")
    expect(() => createAuth({ ...options, app: "gestoria" })).not.toThrow()
  })

  it("sin token firmado, sus rutas no existen", async () => {
    const auth = createAuth(options)
    for (const path of ["/api/auth/token", "/api/auth/jwks"]) {
      const response = await auth.handler(new Request(`https://api.example.test${path}`))
      expect(response.status, path).toBe(404)
    }
  })
})
