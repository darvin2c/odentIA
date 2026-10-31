// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest"
import { apiTransport } from "./ssr-fetch"

afterEach(() => vi.unstubAllGlobals())

function network(...results: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = results.shift()
    if (next instanceof Error) throw next
    return next as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const cut = () => new TypeError("fetch failed")

test("en el servidor, una lectura cortada se repite una vez", async () => {
  const fetchMock = network(cut(), new Response("ok"))
  const response = await apiTransport("https://api.test/x")
  expect(await response.text()).toBe("ok")
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("si el corte sigue, el error llega a quien llamó", async () => {
  const fetchMock = network(cut(), cut())
  await expect(apiTransport("https://api.test/x")).rejects.toThrow("fetch failed")
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("lo que escribe no se repite: no se sabe si llegó", async () => {
  const fetchMock = network(cut(), new Response("ok"))
  await expect(apiTransport("https://api.test/x", { method: "POST" })).rejects.toThrow("fetch failed")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("una respuesta de error de la API no se repite", async () => {
  const fetchMock = network(new Response("no", { status: 500 }), new Response("ok"))
  expect((await apiTransport("https://api.test/x")).status).toBe(500)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("en el navegador no repite", async () => {
  vi.stubGlobal("window", {})
  const fetchMock = network(cut(), new Response("ok"))
  await expect(apiTransport("https://api.test/x")).rejects.toThrow("fetch failed")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
