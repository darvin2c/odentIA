import { describe, expect, it } from "vitest"
import { supportSearchOf, waitlistSearchOf } from "./list-search"

/** Como junta TanStack Router la búsqueda de la dirección con la de la ruta: `{ ...cruda, ...ruta }`. */
const merged = (raw: Record<string, unknown>, parse: (search: Record<string, unknown>) => object) => ({ ...raw, ...parse(raw) })

describe("lo que la cola de soporte lee de la dirección", () => {
  it("un valor que no sirve se ignora: no llega a la API ni al selector", () => {
    const search = merged({ estado: "todos", tipo: "xyz", quien: "xyz", pestana: "xyz" }, supportSearchOf)
    expect(search).toEqual({ caso: undefined, clinica: undefined, estado: undefined, tipo: undefined, quien: undefined, pestana: undefined })
  })

  it("lo que sirve queda como estaba", () => {
    expect(supportSearchOf({ estado: "resuelto", tipo: "problema", quien: "mios", pestana: "metricas", caso: "c1", clinica: "org" })).toEqual({
      estado: "resuelto",
      tipo: "problema",
      quien: "mios",
      pestana: "metricas",
      caso: "c1",
      clinica: "org",
    })
  })
})

describe("lo que la lista de espera lee de la dirección", () => {
  it("una etapa o un producto que no existen se ignoran", () => {
    const search = merged({ etapa: "xyz", producto: "xyz" }, waitlistSearchOf)
    expect(search).toMatchObject({ etapa: undefined, producto: undefined })
  })

  it("«Por revisar» es sin etapa, el nombre de antes sigue sirviendo y la búsqueda numérica es texto", () => {
    expect(waitlistSearchOf({ etapa: "por_revisar" }).etapa).toBeUndefined()
    expect(merged({ estado: "entro" }, waitlistSearchOf)).toMatchObject({ etapa: "entro", estado: undefined })
    expect(waitlistSearchOf({ q: 987654321, producto: "medical", solicitud: "s1" })).toMatchObject({ q: "987654321", producto: "medical", solicitud: "s1" })
  })
})
