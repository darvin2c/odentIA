// Pruebas de lo que el Worker manda a la API (`node --test`, Node 24 lee el TS sin compilar).
import assert from "node:assert/strict"
import { test } from "node:test"
import { inboundBody, omittedNote, pickAttachments } from "./index.ts"

const encoder = new TextEncoder()
const raw = (headers, body = "Hola, les escribo.") =>
  encoder.encode(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`)
const base = [
  "From: Rosa Mamani <rosa@clinica.test>",
  "To: hola@odentia32.com",
  "Subject: Una consulta",
  "Message-ID: <uno@clinica.test>",
  "Content-Type: text/plain; charset=utf-8",
]
const buzon = { kind: "buzon", mailbox: "hola", product: "dental" }
const persona = { kind: "persona", localPart: "ada.lovelace", product: "dental" }
const envelope = { from: "rosa@clinica.test", to: "hola@odentia32.com" }
const at = new Date("2026-11-13T15:00:00Z")

test("manda la primera dirección del Reply-To, recortada, y nada si no trae", async () => {
  const body = JSON.parse(
    await inboundBody(
      raw([...base, "Reply-To: Recepción <Recepcion@Clinica.test>, otra@clinica.test"]),
      envelope,
      buzon,
      at,
    ),
  )
  assert.equal(body.replyTo, "recepcion@clinica.test")
  assert.equal(body.from, "rosa@clinica.test")
  const without = JSON.parse(await inboundBody(raw(base), envelope, buzon, at))
  assert.equal(without.replyTo, null)
})

test("el aviso de los adjuntos va aparte del texto y dice la verdad según el camino", async () => {
  const mixed = [
    "From: Rosa Mamani <rosa@clinica.test>",
    "To: hola@odentia32.com",
    "Subject: Lista",
    "Message-ID: <dos@clinica.test>",
    'Content-Type: multipart/mixed; boundary="b"',
  ]
  const parts = [
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Les mando la lista.",
    "--b",
    "Content-Type: application/zip",
    'Content-Disposition: attachment; filename="lista.zip"',
    "Content-Transfer-Encoding: base64",
    "",
    "UEsDBA==",
    "--b--",
  ].join("\r\n")
  const fromBuzon = JSON.parse(await inboundBody(raw(mixed, parts), envelope, buzon, at))
  assert.equal(fromBuzon.text.trim(), "Les mando la lista.")
  assert.match(fromBuzon.notice, /lista\.zip/)
  assert.match(fromBuzon.notice, /buzón de siempre/)
  const fromPerson = JSON.parse(await inboundBody(raw(mixed, parts), envelope, persona, at))
  assert.doesNotMatch(fromPerson.notice, /buzón de siempre/)
  assert.match(fromPerson.notice, /copia de esa persona/)
  // Sin nada que avisar, no hay aviso.
  assert.equal(JSON.parse(await inboundBody(raw(base), envelope, buzon, at)).notice, null)
  assert.equal(omittedNote([], [], "buzon"), "")
})

test("el nombre y el tipo de un adjunto raro se recortan: la API no lo rechaza", () => {
  const { kept, notAllowed } = pickAttachments([
    {
      filename: `${"a".repeat(1500)}.pdf`,
      mimeType: `application/${"x".repeat(300)}`,
      disposition: "attachment",
      content: "JVBERi0=",
    },
    {
      filename: `${"b".repeat(1500)}.exe`,
      mimeType: "application/octet-stream",
      disposition: "attachment",
      content: "TVo=",
    },
  ])
  assert.equal(kept.length, 1)
  assert.ok(kept[0].filename.length <= 1000)
  assert.ok(kept[0].filename.endsWith(".pdf"))
  assert.ok(kept[0].contentType.length <= 200)
  assert.ok(notAllowed[0].length <= 1000)
})
