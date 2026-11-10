import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { type HelpVideoItem, type HelpVideoSync, syncHelpVideos } from "@odentia/services"
import { z } from "zod"

/**
 * Los videos de la Ayuda (ADR 0178): una vez al día se lee la lista de
 * reproducción de cada producto en YouTube y se deja en la base lo que hay.
 * La Ayuda nunca llama a YouTube al responder. Sin clave o sin lista de un
 * producto, ese producto no se lee y lo que ya estaba queda como estaba.
 */
const API = "https://www.googleapis.com/youtube/v3"
/** Lo que YouTube deja pedir por página, en las dos llamadas. */
const PAGE = 50
/** Una lista de la Ayuda no pasa de unos cientos de videos: más páginas es un error, no una lista. */
const MAX_PAGES = 20
const TIMEOUT_MS = 15_000

const playlistPage = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        snippet: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            publishedAt: z.string().optional(),
            resourceId: z.object({ videoId: z.string().optional() }).optional(),
          })
          .optional(),
        contentDetails: z.object({ videoId: z.string().optional(), videoPublishedAt: z.string().optional() }).optional(),
        status: z.object({ privacyStatus: z.string().optional() }).optional(),
      }),
    )
    .default([]),
})

const videosPage = z.object({
  items: z.array(z.object({ id: z.string(), contentDetails: z.object({ duration: z.string().optional() }).optional() })).default([]),
})

/** «PT1H2M3S» en segundos; nulo si no tiene la forma. */
export function isoDurationSeconds(value: string | undefined): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? "")
  if (!match || match.slice(1).every((part) => part === undefined)) return null
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  return (days ?? 0) * 86_400 + (hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0)
}

async function getJson(fetcher: typeof fetch, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API}/${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  // El cuerpo del error puede repetir la clave: solo queda el código.
  if (!response.ok) throw new Error(`YouTube respondió ${response.status} en ${path}`)
  return response.json()
}

/**
 * Los videos públicos de una lista, con su duración. Los privados, los
 * borrados y los que no se listan fuera de la lista no entran: en la Ayuda
 * solo sale lo que cualquiera puede abrir.
 */
export async function readHelpPlaylist(fetcher: typeof fetch, apiKey: string, playlistId: string): Promise<HelpVideoItem[]> {
  const found: Array<Omit<HelpVideoItem, "durationSeconds">> = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = playlistPage.parse(
      await getJson(fetcher, "playlistItems", {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults: String(PAGE),
        key: apiKey,
        ...(pageToken ? { pageToken } : {}),
      }),
    )
    for (const item of data.items) {
      const youtubeId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId
      const published = new Date(item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? "")
      if (!youtubeId || item.status?.privacyStatus !== "public" || Number.isNaN(published.getTime())) continue
      if (found.some((video) => video.youtubeId === youtubeId)) continue
      found.push({ youtubeId, title: item.snippet?.title ?? "", description: item.snippet?.description ?? "", publishedAt: published })
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  const durations = new Map<string, number | null>()
  for (let at = 0; at < found.length; at += PAGE) {
    const ids = found.slice(at, at + PAGE).map((video) => video.youtubeId)
    const data = videosPage.parse(await getJson(fetcher, "videos", { part: "contentDetails", id: ids.join(","), key: apiKey }))
    for (const item of data.items) durations.set(item.id, isoDurationSeconds(item.contentDetails?.duration))
  }
  return found.map((video) => ({ ...video, durationSeconds: durations.get(video.youtubeId) ?? null }))
}

export interface HelpVideosConfig {
  apiKey: string | undefined
  /** La lista de reproducción de cada producto; sin lista, ese producto no se lee. */
  playlists: Record<ClinicalProduct, string | undefined>
}

/**
 * Lee cada lista y la deja en la base. Un producto que falla no detiene a los
 * demás ni borra lo suyo: una lista que no se pudo leer no es una lista vacía.
 */
export async function runHelpVideosTick(
  ownerDb: Db,
  config: HelpVideosConfig,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<Partial<Record<ClinicalProduct, HelpVideoSync>>> {
  const out: Partial<Record<ClinicalProduct, HelpVideoSync>> = {}
  if (!config.apiKey) return out
  for (const product of CLINICAL_PRODUCTS) {
    const playlist = config.playlists[product]
    if (!playlist) continue
    try {
      out[product] = await syncHelpVideos(ownerDb, product, await readHelpPlaylist(fetcher, config.apiKey, playlist), now)
    } catch (error) {
      console.error(`[help_videos] ${product}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return out
}
