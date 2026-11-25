/** Los videos de una guía: de su lista de YouTube, y si YouTube falla, el video fijo. */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Guide } from "./types"
import { guideVideos, parseFeed, videoJsonLd } from "./videos"

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
 <title>Odontograma</title>
 <entry>
  <yt:videoId>aaaaaaaaaaa</yt:videoId>
  <title>Cómo llenar el odontograma &amp; sus colores</title>
  <published>2026-11-10T08:00:00+00:00</published>
  <media:group><media:description>Paso a paso.
Segunda línea.</media:description></media:group>
 </entry>
 <entry>
  <yt:videoId>bbbbbbbbbbb</yt:videoId>
  <title>El odontograma de niños</title>
  <published>2026-11-20T08:00:00+00:00</published>
 </entry>
 <entry>
  <yt:videoId>no válido</yt:videoId>
  <title>Roto</title>
  <published>2026-11-21T08:00:00+00:00</published>
 </entry>
</feed>`

const FIXED = { youtubeId: "ccccccccccc", title: "El fijo", published: "2026-11-01" }

const guide = (extra: Partial<Guide>) => ({ slug: "prueba", description: "La guía.", ...extra }) as Guide

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

/** La caché de Workers, en memoria: la comparten los «procesos» que se arman con `vi.resetModules`. */
function stubEdge() {
  const stored = new Map<string, Response>()
  vi.stubGlobal("caches", {
    default: {
      match: async (key: string) => stored.get(key)?.clone(),
      put: async (key: string, response: Response) => void stored.set(key, response),
    },
  })
}

describe("los videos de una guía", () => {
  it("lee la lista del más reciente al más viejo, sin los que no son un video", () => {
    expect(parseFeed(FEED)).toEqual([
      { youtubeId: "bbbbbbbbbbb", title: "El odontograma de niños", published: "2026-11-20T08:00:00+00:00", description: undefined },
      { youtubeId: "aaaaaaaaaaa", title: "Cómo llenar el odontograma & sus colores", published: "2026-11-10T08:00:00+00:00", description: "Paso a paso." },
    ])
  })

  it("con su lista, muestra los de YouTube; si YouTube no responde, el fijo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(FEED)))
    const videos = await guideVideos(guide({ playlist: "PLaaaaaaaaaaaaaaaa", video: FIXED }))
    expect(videos.map((video) => video.youtubeId)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa"])

    const failing = vi.fn(async () => new Response("", { status: 500 }))
    vi.stubGlobal("fetch", failing)
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await guideVideos(guide({ playlist: "PLbbbbbbbbbbbbbbbb", video: FIXED }))).toEqual([FIXED])
    // La falla se recuerda: la visita siguiente no espera otra vez a YouTube.
    expect(await guideVideos(guide({ playlist: "PLbbbbbbbbbbbbbbbb", video: FIXED }))).toEqual([FIXED])
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it("sin lista no va a YouTube, y una lista que no es de YouTube no se lee", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    expect(await guideVideos(guide({ video: FIXED }))).toEqual([FIXED])
    expect(await guideVideos(guide({ playlist: "https://otra.example", video: FIXED }))).toEqual([FIXED])
    expect(await guideVideos(guide({}))).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("cada video va a Google con su fecha, su imagen y dónde se ve", () => {
    const [data] = videoJsonLd([FIXED], guide({}))
    expect(data).toMatchObject({
      "@type": "VideoObject",
      name: "El fijo",
      description: "La guía.",
      uploadDate: "2026-11-01",
      thumbnailUrl: ["https://i.ytimg.com/vi/ccccccccccc/sddefault.jpg"],
      embedUrl: "https://www.youtube-nocookie.com/embed/ccccccccccc",
    })
  })

  it("en Workers, una falla dura 10 minutos también para otro proceso, no 6 horas", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"))
    stubEdge()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const withList = guide({ playlist: "PLcccccccccccccccc", video: FIXED })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })))
    expect(await (await import("./videos")).guideVideos(withList)).toEqual([FIXED])

    // Otro proceso, YouTube ya responde: dentro de los 10 minutos sigue el fijo, sin ir a YouTube.
    vi.resetModules()
    const ok = vi.fn(async () => new Response(FEED))
    vi.stubGlobal("fetch", ok)
    vi.setSystemTime(new Date("2026-11-25T12:05:00Z"))
    expect(await (await import("./videos")).guideVideos(withList)).toEqual([FIXED])
    expect(ok).not.toHaveBeenCalled()

    // Pasados los 10 minutos, lee la lista.
    vi.resetModules()
    vi.setSystemTime(new Date("2026-11-25T12:11:00Z"))
    const videos = await (await import("./videos")).guideVideos(withList)
    expect(videos.map((video) => video.youtubeId)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa"])
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
