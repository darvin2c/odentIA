// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useScopedListSearch } from "./list-search"

describe("una lista abierta encima de otra pantalla", () => {
  it("guarda sus filtros en memoria: los cambia, los quita y no los confunde con la dirección", () => {
    const { result } = renderHook(() => useScopedListSearch({ tipo: "recetas", tooth: undefined }))
    expect(result.current.scoped).toBe(true)
    expect(result.current.get("tipo")).toBe("recetas")
    expect(result.current.get("tooth")).toBeUndefined()

    act(() => result.current.setParams({ tipo: undefined, q: "resina" }))
    expect(result.current.get("tipo")).toBeUndefined()
    expect(result.current.get("q")).toBe("resina")

    act(() => result.current.setParam("documentId", "abc"))
    expect(result.current.get("documentId")).toBe("abc")
    expect(result.current.get("q")).toBe("resina")

    act(() => result.current.resetFilters())
    expect(result.current.get("q")).toBeUndefined()
    expect(result.current.get("documentId")).toBeUndefined()
  })
})
