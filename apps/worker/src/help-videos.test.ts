import { expect, it } from "vitest"
import { isoDurationSeconds, readHelpPlaylist } from "./help-videos.js"

it("la duración de YouTube se lee en segundos", () => {
  expect(isoDurationSeconds("PT4M13S")).toBe(253)
  expect(isoDurationSeconds("PT1H2M3S")).toBe(3723)
  expect(isoDurationSeconds("PT45S")).toBe(45)
  expect(isoDurationSeconds("P1DT1S")).toBe(86_401)
  expect(isoDurationSeconds("P")).toBeNull()
  expect(isoDurationSeconds("cuatro minutos")).toBeNull()
  expect(isoDurationSeconds(undefined)).toBeNull()
})

it("lee la lista por páginas: solo lo público, sin repetir, con su duración; la clave no queda en el error", async () => {
  const asked: string[] = []
  const item = (id: string, privacy: string, title = id) => ({
    snippet: { title, description: `#ayuda:tareas-crear ${id}`, publishedAt: "2026-11-01T10:00:00Z", resourceId: { videoId: id } },
    contentDetails: { videoId: id, videoPublishedAt: "2026-10-30T10:00:00Z" },
    status: { privacyStatus: privacy },
  })
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    asked.push(`${url.pathname.split("/").pop()}?${url.searchParams.get("pageToken") ?? url.searchParams.get("id") ?? ""}`)
    expect(url.searchParams.get("key")).toBe("clave")
    if (url.pathname.endsWith("/playlistItems")) {
      return Response.json(
        url.searchParams.get("pageToken")
          ? { items: [item("b", "public"), item("a", "public"), item("c", "private", "Private video")] }
          : { nextPageToken: "p2", items: [item("a", "public", "Crear una tarea"), item("d", "unlisted")] },
      )
    }
    return Response.json({ items: [{ id: "a", contentDetails: { duration: "PT2M5S" } }, { id: "b", contentDetails: {} }] })
  }) as typeof fetch

  const videos = await readHelpPlaylist(fetcher, "clave", "PL1")
  expect(asked).toEqual(["playlistItems?", "playlistItems?p2", "videos?a,b"])
  expect(videos).toEqual([
    { youtubeId: "a", title: "Crear una tarea", description: "#ayuda:tareas-crear a", publishedAt: new Date("2026-10-30T10:00:00Z"), durationSeconds: 125 },
    { youtubeId: "b", title: "b", description: "#ayuda:tareas-crear b", publishedAt: new Date("2026-10-30T10:00:00Z"), durationSeconds: null },
  ])

  const failing = (async () => new Response("clave rechazada: clave", { status: 403 })) as typeof fetch
  await expect(readHelpPlaylist(failing, "clave", "PL1")).rejects.toThrow("YouTube respondió 403 en playlistItems")
})
