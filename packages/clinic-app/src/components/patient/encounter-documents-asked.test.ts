// @vitest-environment jsdom

/**
 * Lo que Documentos da por pedido (QA en pantalla del 17 nov, D3): tras «Preparar» desde la fila del
 * Plan, lo que pide la atención se había leído antes de prepararlo, y el consentimiento recién hecho
 * salía «Ya no se pide: no lo aceptó o eligió otra opción».
 */
import { describe, expect, it } from "vitest"
import { consentsStillAsked, inLinkWords } from "./encounter-documents"

const prepared = {
  id: "doc-1",
  templateId: "tpl-endo",
  planItemId: "i-endo",
  linkSentAt: null,
  personSignedAt: null,
}

describe("consentsStillAsked", () => {
  it("el recién preparado para un tratamiento que lo pide no es «Ya no se pide», aunque lo pedido aún no lo nombre", () => {
    const needs = {
      isFetching: false,
      data: { data: [{ documentId: null, templateId: "tpl-endo", planItemId: "i-endo" }] },
    }
    const asked = consentsStillAsked([prepared], needs)
    expect(asked.notAsked).toEqual([])
    expect(asked.toSign).toEqual([prepared])
  })

  it("el preparado para lo que dejó fuera sigue diciéndose «Ya no se pide»", () => {
    const needs = {
      isFetching: false,
      data: { data: [{ documentId: null, templateId: "tpl-endo", planItemId: "i-otro" }] },
    }
    const asked = consentsStillAsked([prepared], needs)
    expect(asked.notAsked).toEqual([prepared])
    expect(asked.toSign).toEqual([])
  })

  // QA del 18 nov (novato 1): la exodoncia «Por decidir» con su consentimiento recién preparado.
  // Lo que pide la atención vuelve vacío (hoy no se hace), y Documentos decía «Ya no se pide».
  const empty = { isFetching: false, data: { data: [] } }

  it("el de un tratamiento «Por decidir» de la atención se sigue pidiendo, con «Firmar ahora»", () => {
    const asked = consentsStillAsked([prepared], empty, [
      { id: "i-endo", status: "pendiente", decisionStatus: "pendiente" },
    ])
    expect(asked.notAsked).toEqual([])
    expect(asked.toSign).toEqual([prepared])
  })

  // QA del 18 nov (desarrollo): dos pendientes agrupados decían «lo tiene en su enlace» con uno solo enviado.
  it("lo que tiene en su enlace dice cuántos, si no son todos", () => {
    const sent = { linkSentAt: "2026-11-18T13:00:00.000Z" }
    const kept = { linkSentAt: null }
    expect(inLinkWords([kept, kept])).toBe("")
    expect(inLinkWords([sent, kept])).toBe(" · 1 de 2 en su enlace")
    expect(inLinkWords([sent])).toBe(" · lo tiene en su enlace")
    expect(inLinkWords([sent, sent])).toBe(" · los tiene en su enlace")
  })

  it("el de lo que no aceptó, no eligió o se anuló ya no se pide", () => {
    for (const item of [
      { id: "i-endo", status: "pendiente", decisionStatus: "rechazado" },
      { id: "i-endo", status: "pendiente", decisionStatus: "no_elegida" },
      { id: "i-endo", status: "cancelado", decisionStatus: "aceptado" },
    ]) {
      const asked = consentsStillAsked([prepared], empty, [item])
      expect(asked.notAsked).toEqual([prepared])
      expect(asked.toSign).toEqual([])
    }
  })
})
