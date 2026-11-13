// Pruebas de qué hace el Worker con cada correo (`node --test`): reenviar, mandar a la API,
// rechazar. Sin red: el reenvío, la API y el rechazo son dobles que anotan lo que se hizo.
import assert from "node:assert/strict"
import { test } from "node:test"
import { deliver } from "./flow.ts"

const REJECT_UNKNOWN = "Esta dirección no existe"

function harness({ api = { status: "ok", copyTo: null }, forwardFails = [], skip = null } = {}) {
  const log = []
  const deps = {
    forward: async (to) => {
      log.push(`reenvía:${to}`)
      if (forwardFails.includes(to)) throw new Error("no verificada")
    },
    reject: (reason) => log.push(`rechaza:${reason}`),
    post: async (route) => {
      log.push(`api:${route.kind}`)
      return typeof api === "function" ? api() : api
    },
    skipReason: () => skip,
    warn: () => {},
  }
  return { log, deps }
}

const env = { FORWARD_TO: "buzon@gmail.test" }

test("un buzón fijo: primero se reenvía y después va a la API", async () => {
  const { log, deps } = harness()
  await deliver("hola@odentia32.com", env, deps)
  assert.deepEqual(log, ["reenvía:buzon@gmail.test", "api:buzon"])
})

test("un buzón fijo: si fallan el reenvío y la API, se rechaza para que quien escribe sepa", async () => {
  const { log, deps } = harness({ api: { status: "error" }, forwardFails: ["buzon@gmail.test"] })
  await deliver("soporte@odentia32.com", env, deps)
  assert.equal(log.at(-1)?.startsWith("rechaza:"), true)
  assert.notEqual(log.at(-1), `rechaza:${REJECT_UNKNOWN}`)
})

test("una persona: primero la API; existe → su copia; no existe → se rechaza sin reenviar", async () => {
  const withCopy = harness({ api: { status: "ok", copyTo: "ada@gmail.test" } })
  await deliver("ada.lovelace@odentia32.com", env, withCopy.deps)
  assert.deepEqual(withCopy.log, ["api:persona", "reenvía:ada@gmail.test"])

  const withoutCopy = harness({ api: { status: "ok", copyTo: null } })
  await deliver("ada.lovelace@odentia32.com", env, withoutCopy.deps)
  assert.deepEqual(withoutCopy.log, ["api:persona"])

  const nobody = harness({ api: { status: "unknown" } })
  await deliver("nadie@odentia32.com", env, nobody.deps)
  assert.deepEqual(nobody.log, ["api:persona", `rechaza:${REJECT_UNKNOWN}`])
})

test("una persona: si la API falla o no responde, se reenvía al buzón de siempre (no se pierde)", async () => {
  const failing = harness({ api: { status: "error" } })
  await deliver("ada.lovelace@odentia32.com", env, failing.deps)
  assert.deepEqual(failing.log, ["api:persona", "reenvía:buzon@gmail.test"])

  const thrown = harness({
    api: () => {
      throw new Error("sin red")
    },
  })
  await deliver("ada.lovelace@odentia32.com", env, thrown.deps)
  assert.deepEqual(thrown.log, ["api:persona", "reenvía:buzon@gmail.test"])
})

test("lo que no entra al ARM solo se reenvía al buzón de siempre", async () => {
  for (const recipient of ["hola@odentia32.com", "ada.lovelace@odentia32.com"]) {
    const { log, deps } = harness({ skip: "automatico" })
    await deliver(recipient, env, deps)
    assert.deepEqual(log, ["reenvía:buzon@gmail.test"])
  }
  const own = harness()
  await deliver("privacidad@odentia32.com", env, own.deps)
  assert.deepEqual(own.log, ["reenvía:buzon@gmail.test"])
  const elsewhere = harness()
  await deliver("hola@otra.test", env, elsewhere.deps)
  assert.deepEqual(elsewhere.log, ["reenvía:buzon@gmail.test"])
})
