import { createHash } from "node:crypto"
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { helpVideo, helpVideoLink } from "@odentia/db/schema/help"
import { and, desc, eq, inArray, notInArray } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { notFound } from "./errors.js"
import type { HelpTopic } from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"
import { helpTopicsFor } from "./products.js"

/* ---------- Los videos de la Ayuda: se leen de YouTube una vez al día, no al preguntar (ADR 0178) ---------- */

/**
 * Un video se une a una respuesta de la guía por una etiqueta en su
 * descripción: `#ayuda:<nombre fijo de la respuesta>`, o `#ayuda:tema:<id>`
 * para la pantalla entera. Puede llevar varias, y cada una el segundo donde
 * empieza lo suyo (`#ayuda:tareas-crear@90`, `@1m30s`). Unirlos a mano no
 * existe: una sola forma de hacerlo.
 */
const TAG = /#ayuda:((?:tema:)?[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:@([0-9ms:]+))?/gi

/** El segundo de inicio como se escribe: «90», «90s», «2m», «1m30», «1m30s» o «1:30». Nulo si no se entiende. */
function startSecondsOf(text: string | undefined): number | null {
  if (!text) return null
  const clock = /^(\d+):(\d{1,2})$/.exec(text)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const spoken = /^(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(text)
  if (!spoken || (spoken[1] === undefined && spoken[2] === undefined)) return null
  return Number(spoken[1] ?? 0) * 60 + Number(spoken[2] ?? 0)
}
/** Cuántos videos se muestran bajo una respuesta. */
export const HELP_VIDEOS_SHOWN = 2

export interface HelpVideoTag {
  target: string
  startSeconds: number | null
}

/** Las etiquetas de una descripción, sin repetir; la primera de cada respuesta manda. */
export function parseHelpVideoTags(description: string): HelpVideoTag[] {
  const tags = new Map<string, HelpVideoTag>()
  for (const match of description.matchAll(TAG)) {
    const target = (match[1] ?? "").toLowerCase()
    if (!target || tags.has(target)) continue
    tags.set(target, { target, startSeconds: startSecondsOf(match[2]) })
  }
  return [...tags.values()]
}

/** La etiqueta de una pantalla entera. */
export const helpTopicTarget = (topicId: string): string => `tema:${topicId}`

/** A qué se puede unir un video en una guía, con el texto que explica cada cosa. */
export function helpVideoTargets(topics: readonly HelpTopic[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const topic of topics) {
    targets.set(helpTopicTarget(topic.id), topic.purpose)
    for (const faq of topic.faqs ?? []) targets.set(faq.id, faq.a)
  }
  return targets
}

/**
 * La huella de una respuesta: sus palabras, sin signos, tildes ni mayúsculas.
 * Corregir una coma no la cambia; cambiar lo que dice, sí.
 */
export const helpAnswerHash = (text: string): string => createHash("sha256").update(normalizeForSearch(text)).digest("hex").slice(0, 32)

/** Lo que el worker leyó de YouTube de un video de la lista. */
export interface HelpVideoItem {
  youtubeId: string
  title: string
  description: string
  publishedAt: Date
  durationSeconds: number | null
}

export interface HelpVideoSync {
  videos: number
  gone: number
  linked: number
  /** Etiquetas que no nombran nada de la guía de ese producto. */
  unknown: number
  /** Uniones cuya respuesta cambió desde que se unió. */
  review: number
}

/**
 * Deja la lista de un producto como está en YouTube. Solo con la conexión
 * propietaria: la aplicación lee, no escribe. Lo que ya no está en la lista
 * deja de mostrarse sin borrarse; cada etiqueta se une a su respuesta y, si no
 * nombra ninguna, queda «sin unir». La huella se guarda al unir y no se pisa:
 * si la respuesta cambió después, la unión queda «por revisar» y el video se
 * sigue mostrando, hasta que alguien diga que sigue valiendo.
 */
export async function syncHelpVideos(
  ownerDb: Db,
  product: ClinicalProduct,
  items: readonly HelpVideoItem[],
  now: Date = new Date(),
  topics: readonly HelpTopic[] = helpTopicsFor(product),
): Promise<HelpVideoSync> {
  const targets = helpVideoTargets(topics)
  return ownerDb.transaction(async (tx) => {
    const out: HelpVideoSync = { videos: items.length, gone: 0, linked: 0, unknown: 0, review: 0 }
    const seen: string[] = []
    for (const item of items) {
      const values = {
        title: item.title.slice(0, 300),
        durationSeconds: item.durationSeconds,
        publishedAt: item.publishedAt,
        seenAt: now,
        gone: false,
      }
      const [video] = await tx
        .insert(helpVideo)
        .values({ product, youtubeId: item.youtubeId, ...values })
        .onConflictDoUpdate({ target: [helpVideo.product, helpVideo.youtubeId], set: values })
        .returning({ id: helpVideo.id })
      if (!video) throw new Error("No se pudo guardar el video")
      seen.push(video.id)
      const tags = parseHelpVideoTags(item.description)
      const before = await tx.select().from(helpVideoLink).where(eq(helpVideoLink.videoId, video.id))
      const wanted = new Set(tags.map((tag) => tag.target))
      const dropped = before.filter((link) => !wanted.has(link.target)).map((link) => link.target)
      if (dropped.length > 0) await tx.delete(helpVideoLink).where(and(eq(helpVideoLink.videoId, video.id), inArray(helpVideoLink.target, dropped)))
      for (const tag of tags) {
        const text = targets.get(tag.target)
        const known = text !== undefined
        const current = known ? helpAnswerHash(text) : null
        const old = before.find((link) => link.target === tag.target)
        // La huella es la de cuando se unió; una etiqueta que recién ahora nombra algo se une hoy.
        const answerHash = old?.known && old.answerHash ? old.answerHash : current
        const review = known && answerHash !== current
        await tx
          .insert(helpVideoLink)
          .values({ videoId: video.id, target: tag.target, startSeconds: tag.startSeconds, known, answerHash, review })
          .onConflictDoUpdate({
            target: [helpVideoLink.videoId, helpVideoLink.target],
            set: { startSeconds: tag.startSeconds, known, answerHash, review },
          })
        if (known) out.linked += 1
        else out.unknown += 1
        if (review) out.review += 1
      }
    }
    const left = await tx
      .update(helpVideo)
      .set({ gone: true })
      .where(and(eq(helpVideo.product, product), eq(helpVideo.gone, false), ...(seen.length > 0 ? [notInArray(helpVideo.id, seen)] : [])))
      .returning({ id: helpVideo.id })
    out.gone = left.length
    return out
  })
}

/** Un video como lo ve quien pregunta. */
export interface HelpAnswerVideo {
  title: string
  /** Abre YouTube, en el segundo de esa respuesta si la etiqueta lo dijo. */
  url: string
  /** Lo que dura, en minutos y al menos uno; nulo si YouTube no lo dijo. */
  minutes: number | null
}

const watchUrl = (youtubeId: string, startSeconds: number | null): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}${startSeconds ? `&t=${startSeconds}s` : ""}`

/**
 * Los videos de unas respuestas, por respuesta: los más nuevos primero y
 * `HELP_VIDEOS_SHOWN` como mucho. Lo que ya no está en la lista o no se pudo
 * unir no sale.
 */
export async function helpVideosFor(tx: Db, product: ClinicalProduct, targets: readonly string[]): Promise<Map<string, HelpAnswerVideo[]>> {
  const out = new Map<string, HelpAnswerVideo[]>()
  if (targets.length === 0) return out
  const rows = await tx
    .select({
      target: helpVideoLink.target,
      startSeconds: helpVideoLink.startSeconds,
      youtubeId: helpVideo.youtubeId,
      title: helpVideo.title,
      durationSeconds: helpVideo.durationSeconds,
    })
    .from(helpVideoLink)
    .innerJoin(helpVideo, eq(helpVideo.id, helpVideoLink.videoId))
    .where(and(eq(helpVideo.product, product), eq(helpVideo.gone, false), eq(helpVideoLink.known, true), inArray(helpVideoLink.target, [...new Set(targets)])))
    .orderBy(desc(helpVideo.publishedAt), helpVideo.youtubeId)
  for (const row of rows) {
    const list = out.get(row.target) ?? []
    if (list.length >= HELP_VIDEOS_SHOWN) continue
    list.push({
      title: row.title,
      url: watchUrl(row.youtubeId, row.startSeconds),
      minutes: row.durationSeconds === null ? null : Math.max(1, Math.round(row.durationSeconds / 60)),
    })
    out.set(row.target, list)
  }
  return out
}

/* ---------- Lo que ve soporte ---------- */

export interface HelpVideoAdminLink {
  target: string
  /** La pregunta o la pantalla a la que está unido; nulo si la etiqueta no nombra nada. */
  label: string | null
  startSeconds: number | null
  /** La respuesta cambió desde que se unió: mirar si el video sigue valiendo. */
  review: boolean
}

export interface HelpVideoAdminRow {
  id: string
  product: ClinicalProduct
  title: string
  url: string
  publishedAt: string
  /** Ya no está en la lista de YouTube: no se muestra. */
  gone: boolean
  links: HelpVideoAdminLink[]
}

const targetLabel = (target: string, topics: readonly HelpTopic[]): string | null => {
  for (const topic of topics) {
    if (helpTopicTarget(topic.id) === target) return `Pantalla ${topic.title}`
    const faq = (topic.faqs ?? []).find((item) => item.id === target)
    if (faq) return faq.q
  }
  return null
}

/** Todos los videos leídos, con a qué está unido cada uno: los que piden algo, primero. */
export async function listHelpVideos(ownerDb: Db, actor: AdminActor): Promise<HelpVideoAdminRow[]> {
  const videos = await ownerDb.select().from(helpVideo).orderBy(desc(helpVideo.publishedAt))
  const links = videos.length > 0 ? await ownerDb.select().from(helpVideoLink).where(inArray(helpVideoLink.videoId, videos.map((video) => video.id))) : []
  await writeAdminAudit(ownerDb, actor, { action: "support.help_videos.read" })
  const rows = videos.map((video): HelpVideoAdminRow => {
    const product = video.product as ClinicalProduct
    const topics = helpTopicsFor(product)
    return {
      id: video.id,
      product,
      title: video.title,
      url: watchUrl(video.youtubeId, null),
      publishedAt: video.publishedAt.toISOString(),
      gone: video.gone,
      links: links
        .filter((link) => link.videoId === video.id)
        .map((link) => ({ target: link.target, label: link.known ? targetLabel(link.target, topics) : null, startSeconds: link.startSeconds, review: link.review })),
    }
  })
  const asks = (row: HelpVideoAdminRow) => (row.gone ? 0 : row.links.length === 0 || row.links.some((link) => link.label === null || link.review) ? 2 : 1)
  return rows.sort((a, b) => asks(b) - asks(a))
}

/** «Sigue valiendo»: la respuesta cambió, alguien miró el video y sirve igual. La huella pasa a ser la de hoy. */
export async function keepHelpVideoLink(ownerDb: Db, actor: AdminActor, videoId: string, target: string): Promise<void> {
  await ownerDb.transaction(async (tx) => {
    const [video] = await tx.select({ product: helpVideo.product }).from(helpVideo).where(eq(helpVideo.id, videoId)).limit(1)
    const text = video ? helpVideoTargets(helpTopicsFor(video.product as ClinicalProduct)).get(target) : undefined
    if (text === undefined) throw notFound("Video de la Ayuda")
    const [row] = await tx
      .update(helpVideoLink)
      .set({ answerHash: helpAnswerHash(text), review: false })
      .where(and(eq(helpVideoLink.videoId, videoId), eq(helpVideoLink.target, target)))
      .returning({ target: helpVideoLink.target })
    if (!row) throw notFound("Video de la Ayuda")
    await writeAdminAudit(tx, actor, { action: "support.help_videos.keep", metadata: { videoId, target } })
  })
}

/** Las etiquetas que se pueden poner en un video de un producto, para copiarlas. */
export function helpVideoTagList(product: ClinicalProduct): Array<{ tag: string; label: string; where: string }> {
  return helpTopicsFor(product).flatMap((topic) => [
    { tag: `#ayuda:${helpTopicTarget(topic.id)}`, label: `Pantalla ${topic.title}`, where: topic.title },
    ...(topic.faqs ?? []).map((faq) => ({ tag: `#ayuda:${faq.id}`, label: faq.q, where: topic.title })),
  ])
}
