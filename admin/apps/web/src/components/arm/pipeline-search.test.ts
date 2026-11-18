import { describe, expect, it } from "vitest"
import { pipelineQueryOf, pipelineSearchOf } from "./pipeline-search"

describe("la dirección del Embudo", () => {
  it("lleva cada clave siempre, vacía si su valor no sirve", () => {
    const search = pipelineSearchOf({
      producto: "xyz",
      responsable: "a b",
      origen: "tv",
      vista: "tabla",
      pestana: "venta",
      otra: "1",
    })
    expect(search).toEqual({
      pestana: undefined,
      producto: undefined,
      responsable: undefined,
      origen: undefined,
      vista: undefined,
    })
    expect(Object.keys(search).sort()).toEqual([
      "origen",
      "pestana",
      "producto",
      "responsable",
      "vista",
    ])
  })

  it("lee lo que sí vale", () => {
    expect(
      pipelineSearchOf({
        producto: "medical",
        responsable: "mio",
        origen: "referido",
        vista: "lista",
        pestana: "alta",
      }),
    ).toEqual({
      pestana: "alta",
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

  it("el Alta va a su propia lista, con los mismos filtros", () => {
    expect(
      pipelineQueryOf(
        pipelineSearchOf({
          pestana: "alta",
          producto: "dental",
          responsable: "mio",
          origen: "web",
        }),
      ),
    ).toBe("/api/admin/clients/pipeline/alta?owner=mio&origin=web")
    expect(pipelineQueryOf(pipelineSearchOf({ pestana: "alta" }))).toBe(
      "/api/admin/clients/pipeline/alta",
    )
  })
})
