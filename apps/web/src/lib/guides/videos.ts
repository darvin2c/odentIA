// Los videos de una guía, del canal de YouTube de odentIA. Si la guía tiene su lista de reproducción,
// se leen de ahí: un tutorial nuevo que se suma a la lista aparece solo en la guía, sin tocar la web.
// Se lee el feed público de la lista (sin clave ni costo; trae los últimos 15) y se guarda unas horas.
// Si YouTube no responde o la lista está vacía, la guía muestra su video fijo, o ninguno.
import { edgeCache } from "../edge-cache"
import type { Guide, GuideVideo } from "./types"

/** Lo que dura la lista leída: un video nuevo se ve en la guía en unas horas. */
const FRESH_SECONDS = 6 * 60 * 60
/** Si YouTube falla, no se vuelve a intentar en cada visita: se espera este rato con el video fijo. */
const FAILED_SECONDS = 10 * 60
/** Si YouTube tarda, la página no espera: sale con el video fijo. */
const TIMEOUT_MS = 1500
/** Los que se muestran como mucho: el principal y los de «Más videos de este tema». */
const MAX_VIDEOS = 7

export const CHANNEL_URL = "https://www.youtube.com/@odentIA32"

/** Una lista de YouTube (PL…), para no armar una dirección con cualquier cosa. */
export const PLAYLIST_ID = /^PL[\w-]{10,64}$/

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`
/** La miniatura de 640 × 480 (la de 480 se veía borrosa en la portada). */
export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/sddefault.jpg`
export const embedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}`

const feedUrl = (playlist: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist}`

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code] ?? whole
  })
}

const tag = (xml: string, name: string) => {
  const found = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]
  return found === undefined ? undefined : decode(found.trim())
}

/** Los videos del feed de una lista, del más reciente al más viejo. */
export function parseFeed(xml: string): GuideVideo[] {
  const videos: GuideVideo[] = []
  for (const entry of xml.split("<entry>").slice(1)) {
    const youtubeId = tag(entry, "yt:videoId")
    const title = tag(entry, "title")
    const published = tag(entry, "published")
    if (!youtubeId || !/^[\w-]{11}$/.test(youtubeId) || !title || !published) continue
    const description = tag(entry, "media:description")
    videos.push({ youtubeId, title, published, description: description?.split("\n")[0] || undefined })
  }
  return videos.sort((a, b) => b.published.localeCompare(a.published))
}

/** Lo leído en este proceso, para no ir a YouTube en cada visita (en Node; en Workers, además, la caché). */
const memory = new Map<string, { at: number; videos: GuideVideo[] }>()

async function playlistVideos(playlist: string): Promise<GuideVideo[]> {
  const kept = memory.get(playlist)
  if (kept && Date.now() - kept.at < FRESH_SECONDS * 1000) return kept.videos
  const url = feedUrl(playlist)
  const edge = edgeCache()
  const hit = await edge?.match(url)
  if (hit) {
    const videos = parseFeed(await hit.text())
    memory.set(playlist, { at: Date.now(), videos })
    return videos
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`YouTube respondió ${response.status}`)
    const xml = await response.text()
    const videos = parseFeed(xml)
    memory.set(playlist, { at: Date.now(), videos })
    await edge?.put(url, new Response(xml, { headers: { "Cache-Control": `s-maxage=${FRESH_SECONDS}` } }))
    return videos
  } catch (error) {
    // La falla se recuerda un rato (lista vacía: va el video fijo), para que cada visita no espere otra vez.
    memory.set(playlist, { at: Date.now() - (FRESH_SECONDS - FAILED_SECONDS) * 1000, videos: [] })
    await edge?.put(url, new Response("", { headers: { "Cache-Control": `s-maxage=${FAILED_SECONDS}` } }))
    throw error
  }
}

/** Los videos de la guía: el primero es el principal. Nunca falla: sin YouTube, el fijo o ninguno. */
export async function guideVideos(guide: Guide): Promise<GuideVideo[]> {
  const fixed = guide.video ? [guide.video] : []
  if (!guide.playlist || !PLAYLIST_ID.test(guide.playlist)) return fixed
  try {
    const videos = await playlistVideos(guide.playlist)
    return videos.length ? videos.slice(0, MAX_VIDEOS) : fixed
  } catch (error) {
    console.error(`web: no se leyó la lista de videos de ${guide.slug}`, error)
    return fixed
  }
}

/** Los datos de cada video para Google: así la guía puede salir también en los resultados de video. */
export function videoJsonLd(videos: GuideVideo[], guide: Guide) {
  return videos.map((video) => ({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.title,
    description: video.description ?? guide.description,
    thumbnailUrl: [thumbUrl(video.youtubeId)],
    uploadDate: video.published,
    contentUrl: watchUrl(video.youtubeId),
    embedUrl: embedUrl(video.youtubeId),
    inLanguage: "es",
  }))
}
