import { describe, expect, it } from "vitest"
import { cargaConfirmWords, cargaMarkedWords } from "./client-files-tab"
import {
  answeredWords,
  attachmentTypeWords,
  canAttachProposal,
  emailFileState,
  inboundEmailSchema,
  replyHint,
  replyToWords,
} from "./email-drawer"
import {
  canAnswer,
  type KairosItem,
  kairosItemSchema,
  newClientFromEmail,
  replyTargetOf,
} from "./kairos-items"
import { writeEmailHint } from "./write-drawer"

/** Un correo como lo devuelve `GET /api/admin/clients/inbound/:emailId`. */
const email = {
  id: "e1",
  mailbox: "hola",
  product: "dental",
  from: "elena@example.test",
  fromName: "Elena Quispe",
  to: "hola@odentia32.com",
  subject: "¿Cómo empiezo?",
  text: "Hola",
  receivedAt: "2026-11-13T15:00:00.000Z",
  senderVerified: true,
  attachments: 2,
  clientId: null,
  matchedBy: null,
  staff: null,
  canReply: true,
  replyFrom: { name: "Ada Lovelace · odentIA", address: "ada.lovelace@odentia32.com" },
  replySubject: "Re: ¿Cómo empiezo?",
  replies: [
    {
      id: "o1",
      status: "incierto",
      from: "ada.lovelace@odentia32.com",
      subject: "Re: ¿Cómo empiezo?",
      body: "Hola, Elena",
      createdBy: "u1",
      createdAt: "2026-11-13T16:00:00.000Z",
      sentAt: null,
    },
  ],
}

const item = (payload: Record<string, unknown>): KairosItem =>
  kairosItemSchema.parse({
    id: "k1",
    clientId: null,
    clientName: null,
    product: null,
    kind: "correo_sin_cliente",
    title: "Correo sin cliente: Elena Quispe",
    reason: "Llegó a hola@",
    status: "espera",
    payload,
    ready: true,
    adminOnly: false,
    expiresAt: "2026-11-15T15:00:00.000Z",
    createdAt: "2026-11-13T15:00:00.000Z",
    decidedAt: null,
    decidedByName: null,
    result: null,
    error: null,
  })

describe("el correo que llegó", () => {
  it("se lee como lo manda el servidor; sin «Desde» (quien ya no está) queda nulo", () => {
    const read = inboundEmailSchema.parse(email)
    expect(read.replyFrom?.address).toBe("ada.lovelace@odentia32.com")
    expect(read.replies[0]?.status).toBe("incierto")
    const { replyFrom: _from, replySubject: _subject, ...older } = email
    expect(inboundEmailSchema.parse(older)).toMatchObject({ replyFrom: null, replySubject: "" })
  })

  it("«Crear cliente con este correo» trae quién escribió, su correo y la marca", () => {
    expect(
      newClientFromEmail(
        item({
          emailId: "e1",
          mailbox: "hola",
          product: "medical",
          from: "elena@example.test",
          fromName: "Elena Quispe",
        }),
      ),
    ).toEqual({
      contactName: "Elena Quispe",
      email: "elena@example.test",
      product: "medical",
      origin: "otro",
      originDetail: "Nos escribió a hola@",
    })
    // A la dirección de una persona y sin nombre: no se inventa nada; su dirección real, si viene.
    expect(
      newClientFromEmail(item({ emailId: "e2", mailbox: "persona", from: "x@example.test" })),
    ).toEqual({
      contactName: "",
      email: "x@example.test",
      origin: "otro",
      originDetail: "Nos escribió a una persona del equipo",
    })
    expect(
      newClientFromEmail(
        item({
          emailId: "e3",
          mailbox: "persona",
          to: "ana.torres+ventas@odentia32.com",
          from: "x@example.test",
        }),
      ).originDetail,
    ).toBe("Nos escribió a ana.torres@")
  })

  it("Responder y Crear cliente: Soporte solo con lo que llegó a soporte@", () => {
    const hola = item({ emailId: "e1", mailbox: "hola" })
    const soporte = item({ emailId: "e2", mailbox: "soporte" })
    expect([canAnswer(hola, false), canAnswer(soporte, false)]).toEqual([false, true])
    expect(canAnswer(hola, true)).toBe(true)
  })

  it("responder dice a dónde va (su Reply-To) y con qué firma sale", () => {
    const read = inboundEmailSchema.parse({
      ...email,
      replyTo: "recepcion@example.test",
      replySignature: "Ada Lovelace · odentIA",
    })
    expect(replyToWords(read)).toBe(
      "recepcion@example.test (la dirección que pidió para responderle)",
    )
    expect(replyHint(read)).toContain("firmada «Ada Lovelace · odentIA»")
    // Sin Reply-To, al remitente; de un servidor viejo, sin aviso ni firma.
    const plain = inboundEmailSchema.parse(email)
    expect(replyToWords(plain)).toBe("Elena Quispe <elena@example.test>")
    expect(plain).toMatchObject({ notice: null, replySignature: null })
  })

  it("al responder dice si ya le respondimos: desde Kairós se abre sin ver el correo", () => {
    expect(answeredWords(inboundEmailSchema.parse(email))).toBeNull()
    const sent = inboundEmailSchema.parse({
      ...email,
      replies: [
        { ...email.replies[0], status: "enviado", sentAt: "2026-11-13T16:05:00.000Z" },
        { ...email.replies[0], id: "o2", status: "no_salio" },
      ],
    })
    expect(answeredWords(sent)).toMatch(
      /^Ya le respondimos el .+ desde ada\.lovelace@odentia32\.com\. Lo que escribas sale como otra respuesta\.$/,
    )
  })

  it("la tarjeta de Kairós dice a dónde irá la respuesta (su Reply-To)", () => {
    const base = { emailId: "e1", mailbox: "hola", from: "elena@example.test", fromName: "Elena" }
    expect(replyTargetOf(item(base))).toBe("Elena <elena@example.test>")
    expect(replyTargetOf(item({ ...base, replyTo: "gerencia@example.test" }))).toBe(
      "gerencia@example.test (la dirección que pidió para responderle)",
    )
  })

  it("«Escribir» por correo dice desde dónde sale: Soporte, siempre desde soporte@", () => {
    expect(writeEmailHint({ proposal: false, support: true })).toContain("soporte@")
    expect(writeEmailHint({ proposal: false, support: false })).toContain("tu nombre")
    expect(writeEmailHint({ proposal: true, support: false })).toContain("propuesta en PDF")
  })
})

describe("adjuntar una propuesta al responder", () => {
  const withClient = inboundEmailSchema.parse({ ...email, clientId: "c1" })
  it("solo Administración, con cliente y fuera de Kairós", () => {
    expect(canAttachProposal(withClient, true, false)).toBe(true)
    expect(canAttachProposal(withClient, false, false)).toBe(false)
    expect(canAttachProposal(withClient, true, true)).toBe(false)
    expect(canAttachProposal(inboundEmailSchema.parse(email), true, false)).toBe(false)
  })

  it("lo que llegó a soporte@ no la ofrece, tampoco a Administración: sale firmado por Soporte", () => {
    const toSupport = inboundEmailSchema.parse({
      ...email,
      clientId: "c1",
      mailbox: "soporte",
      to: "soporte@odentia32.com",
    })
    expect(canAttachProposal(toSupport, true, false)).toBe(false)
  })
})

describe("los adjuntos del correo y la carga de datos", () => {
  const file = {
    fileId: "f1",
    filename: "pacientes.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 120,
    kind: "correo" as const,
    deleteAfter: null,
    deleted: false,
    cargaDeleteAfter: "2026-12-12",
    cargaDueNow: false,
  }

  it("cada adjunto con uno de tres estados; de un servidor viejo, sin lista", () => {
    const read = inboundEmailSchema.parse({ ...email, files: [file] })
    const [only] = read.files
    if (!only) throw new Error("sin adjunto")
    expect(attachmentTypeWords(only.contentType)).toBe("Excel")
    expect(emailFileState(only)).toEqual({ words: "Adjunto de un correo", canMark: true })
    const carga = { ...only, kind: "archivo_clinica" as const, deleteAfter: "2026-12-12" }
    expect(emailFileState(carga).canMark).toBe(false)
    expect(emailFileState(carga).words).toMatch(/^Lo que mandó la clínica · se borra el /)
    expect(emailFileState({ ...carga, deleted: true })).toEqual({
      words: "Se borró",
      canMark: false,
    })
    expect(inboundEmailSchema.parse(email).files).toEqual([])
  })

  it("el diálogo dice el día del servidor, o que se borra al marcarlo", () => {
    expect(cargaConfirmWords(file)).toMatch(
      /^pacientes\.xlsx pasa a «Lo que mandó la clínica» y se borra el .+, a los 30 días de llegar/,
    )
    expect(cargaConfirmWords({ ...file, cargaDueNow: true })).toContain("se borra al marcarlo")
    expect(
      cargaMarkedWords("pacientes.xlsx", {
        file: { id: "f1", deleteAfter: null },
        dueNow: true,
        deletedNow: true,
      }),
    ).toBe("pacientes.xlsx se borró: llegó hace más de 30 días")
    expect(
      cargaMarkedWords("pacientes.xlsx", {
        file: { id: "f1", deleteAfter: null },
        dueNow: true,
        deletedNow: false,
      }),
    ).toContain("se borra en los próximos minutos")
  })
})
