import { describe, expect, it } from "vitest"
import { pipelineQueryOf, pipelineSearchOf } from "./pipeline-search"

describe("la dirección del Embudo", () => {
  it("lleva cada clave siempre, vacía si su valor no sirve", () => {
    const search = pipelineSearchOf({
      producto: "xyz",
      responsable: "a b",
      origen: "tv",
      vista: "tabla",
      otra: "1",
    })
    expect(search).toEqual({
      producto: undefined,
      responsable: undefined,
      origen: undefined,
      vista: undefined,
    })
    expect(Object.keys(search).sort()).toEqual(["origen", "producto", "responsable", "vista"])
  })

  it("lee lo que sí vale", () => {
    expect(
      pipelineSearchOf({
        producto: "medical",
        responsable: "mio",
        origen: "referido",
        vista: "lista",
      }),
    ).toEqual({
      producto: "medical",
      responsable: "mio",
      origen: "referido",
      vista: "lista",
    })
  })

  it("manda a la API el responsable y el origen, no el producto", () => {
    expect(
      pipelineQueryOf(pipelineSearchOf({ producto: "dental", responsable: "sin", origen: "web" })),
    ).toBe("/api/admin/clients/pipeline?owner=sin&origin=web")
    expect(pipelineQueryOf(pipelineSearchOf({}))).toBe("/api/admin/clients/pipeline")
  })
})
