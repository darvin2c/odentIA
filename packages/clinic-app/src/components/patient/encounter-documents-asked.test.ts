// @vitest-environment jsdom

/**
 * Lo que Documentos da por pedido (QA en pantalla del 17 nov, D3): tras «Preparar» desde la fila del
 * Plan, lo que pide la atención se había leído antes de prepararlo, y el consentimiento recién hecho
 * salía «Ya no se pide: no lo aceptó o eligió otra opción».
 */
import { describe, expect, it } from "vitest"
import { consentsStillAsked } from "./encounter-documents"

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
})
