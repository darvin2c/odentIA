import { expect, it } from "vitest"
import { decryptConfig, encryptJson, secretsKeyFromEnv } from "./secrets.js"

const KEY = secretsKeyFromEnv("aa".repeat(32))

it("cifra y descifra config redonda", () => {
  const config = { botToken: "abc", templates: [{ name: "t", language: "es_PE" }] }
  expect(decryptConfig(KEY, encryptJson(KEY, config))).toEqual(config)
})

it("falla con clave incorrecta", () => {
  const other = secretsKeyFromEnv("bb".repeat(32))
  expect(() => decryptConfig(other, encryptJson(KEY, { a: 1 }))).toThrow("descifrar")
})

it("rechaza formato y clave inválidos", () => {
  expect(() => decryptConfig(KEY, "no-es-formato")).toThrow("formato")
  expect(() => decryptConfig(KEY, encryptJson(KEY, [1, 2]))).toThrow("formato")
  expect(() => secretsKeyFromEnv(undefined)).toThrow("SECRETS_KEY")
  expect(() => secretsKeyFromEnv("corta")).toThrow("32 bytes")
})
