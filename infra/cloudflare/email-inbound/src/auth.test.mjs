// Pruebas del remitente verificado (`node --test`, Node 24 lee el TS sin compilar).
import assert from "node:assert/strict"
import { test } from "node:test"
import { senderVerified } from "./auth.ts"

const CF = "mx.cloudflare.net"
const arc = (value) => ({ key: "arc-authentication-results", value })
const results = (value) => ({ key: "authentication-results", value })

test("DMARC que pasa con el dominio del From: verificado", () => {
  const headers = [
    arc(
      `i=1; ${CF}; dkim=pass header.d=gmail.com header.s=20230601; dmarc=pass header.from=gmail.com policy.dmarc=none; spf=pass (${CF}: domain of dra@gmail.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=dra@gmail.com`,
    ),
  ]
  assert.equal(senderVerified(headers, "dra@gmail.com", CF), true)
})

test("SPF o DKIM que pasan con otro dominio que el del From: no verificado", () => {
  const headers = [
    arc(
      `i=1; ${CF}; dkim=pass header.d=atacante.test; dmarc=fail header.from=gmail.com; spf=pass smtp.mailfrom=x@atacante.test`,
    ),
  ]
  assert.equal(senderVerified(headers, "dra.calderon@gmail.com", CF), false)
})

test("DKIM alineado (subdominio) basta aunque no haya DMARC", () => {
  const headers = [results(`${CF}; dkim=pass header.d=correo.clinica.test; spf=none; dmarc=none`)]
  assert.equal(senderVerified(headers, "recepcion@clinica.test", CF), true)
})

test("solo vale el de arriba, el que agregó Cloudflare: uno falso más abajo no cuenta", () => {
  const headers = [
    arc(
      `i=2; ${CF}; dkim=none; spf=fail smtp.mailfrom=x@atacante.test; dmarc=fail header.from=gmail.com`,
    ),
    arc(`i=1; ${CF}; dmarc=pass header.from=gmail.com`),
  ]
  assert.equal(senderVerified(headers, "dra@gmail.com", CF), false)
})

test("uno de otro servidor arriba, o ninguno: no verificado", () => {
  assert.equal(
    senderVerified(
      [results("mx.atacante.test; dmarc=pass header.from=gmail.com")],
      "dra@gmail.com",
      CF,
    ),
    false,
  )
  assert.equal(senderVerified([], "dra@gmail.com", CF), false)
  assert.equal(senderVerified([results(`${CF}; dmarc=pass header.from=gmail.com`)], "", CF), false)
})

test("un comentario con «;» o «dmarc=pass» no engaña", () => {
  const headers = [
    arc(
      `i=1; ${CF}; spf=softfail (dmarc=pass header.from=gmail.com; ok) smtp.mailfrom=x@otro.test`,
    ),
  ]
  assert.equal(senderVerified(headers, "dra@gmail.com", CF), false)
})
