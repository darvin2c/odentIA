// Pruebas de a dónde va cada correo (`node --test`, Node 24 lee el TS sin compilar).
import assert from "node:assert/strict"
import { test } from "node:test"
import { routeOf, skipReason, threadHeaders } from "./route.ts"

const headers = (pairs) => {
  const map = new Map(Object.entries(pairs).map(([key, value]) => [key.toLowerCase(), value]))
  return (name) => map.get(name.toLowerCase()) ?? null
}

test("los buzones fijos de cada dominio, con su producto; la etiqueta +algo no cuenta", () => {
  assert.deepEqual(routeOf("Soporte+urgente@OdentIA32.com"), {
    kind: "buzon",
    mailbox: "soporte",
    product: "dental",
  })
  assert.deepEqual(routeOf("hola@latidia72.com"), {
    kind: "buzon",
    mailbox: "hola",
    product: "medical",
  })
  assert.deepEqual(routeOf("fundadores@vistia20.com."), {
    kind: "buzon",
    mailbox: "fundadores",
    product: "optical",
  })
  assert.deepEqual(routeOf("contacto@odentia32.com"), {
    kind: "buzon",
    mailbox: "contacto",
    product: "dental",
  })
})

test("cualquier otra dirección de un dominio nuestro es de una persona", () => {
  assert.deepEqual(routeOf("Ada.Lovelace+x@odentia32.com"), {
    kind: "persona",
    localPart: "ada.lovelace",
    product: "dental",
  })
  assert.deepEqual(routeOf("darvin.cotrina@latidia72.com"), {
    kind: "persona",
    localPart: "darvin.cotrina",
    product: "medical",
  })
})

test("lo que tiene su propia regla (o es del servidor) solo se reenvía; otro dominio, nada", () => {
  for (const local of [
    "privacidad",
    "reclamaciones",
    "redes",
    "reply",
    "no-reply",
    "postmaster",
    "abuse",
  ])
    assert.deepEqual(routeOf(`${local}@odentia32.com`), { kind: "reenviar", product: "dental" })
  assert.equal(routeOf("hola@otra.test"), null)
  assert.equal(routeOf("sin-arroba"), null)
})

test("lo que sale de nuestros dominios sin persona detrás no entra al ARM", () => {
  assert.equal(skipReason(headers({}), "no-reply@odentia32.com"), "propio")
  assert.equal(skipReason(headers({}), "noreply@latidia72.com"), "propio")
  assert.equal(skipReason(headers({}), "reply@vistia20.com"), "propio")
  // Una persona del equipo que escribe a soporte@ sí entra; un no-reply de otro dominio también.
  assert.equal(skipReason(headers({}), "ada.lovelace@odentia32.com"), null)
  assert.equal(skipReason(headers({}), "no-reply@clinica.test"), null)
})

test("las respuestas automáticas y los rebotes no entran al ARM", () => {
  assert.equal(
    skipReason(headers({ "Auto-Submitted": "auto-replied" }), "dra@gmail.com"),
    "automatico",
  )
  assert.equal(skipReason(headers({ "Auto-Submitted": "No" }), "dra@gmail.com"), null)
  assert.equal(skipReason(headers({ "X-Autoreply": "yes" }), "dra@gmail.com"), "automatico")
  assert.equal(skipReason(headers({ "X-Autorespond": "1" }), "dra@gmail.com"), "automatico")
  for (const precedence of ["bulk", "Junk", "auto_reply", "list"])
    assert.equal(skipReason(headers({ Precedence: precedence }), "dra@gmail.com"), "automatico")
  assert.equal(skipReason(headers({ Precedence: "first-class" }), "dra@gmail.com"), null)
  assert.equal(
    skipReason(
      headers({ "Content-Type": 'multipart/report; report-type="delivery-status"' }),
      "x@y.test",
    ),
    "automatico",
  )
  assert.equal(skipReason(headers({}), ""), "automatico")
  assert.equal(skipReason(headers({}), "MAILER-DAEMON@gmail.com"), "automatico")
  assert.equal(skipReason(headers({}), "postmaster@clinica.test"), "automatico")
})

test("las cabeceras del hilo van solo con sus Message-ID y recortadas", () => {
  assert.deepEqual(threadHeaders(" <a@x> ", "<a@x>  <b@x>\r\n <c@x> basura"), {
    inReplyTo: "<a@x>",
    references: "<a@x> <b@x> <c@x>",
  })
  assert.deepEqual(threadHeaders(undefined, ""), { inReplyTo: null, references: null })
  const many = Array.from({ length: 400 }, (_, i) => `<id-${i}-${"x".repeat(20)}@gmail.com>`).join(
    " ",
  )
  const { references } = threadHeaders(null, many)
  assert.ok(references.length <= 8000)
  // Se quedan el primero (el que abrió el hilo) y los últimos.
  assert.ok(references.startsWith("<id-0-"))
  assert.ok(references.endsWith("<id-399-xxxxxxxxxxxxxxxxxxxx@gmail.com>"))
})
