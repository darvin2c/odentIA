import { sql } from "drizzle-orm"
import { boolean, check, index, integer, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { catalogSchema } from "./schemas.js"

/**
 * Los videos de la Ayuda (ADR 0178): lo que el worker lee una vez al día de la
 * lista de reproducción de cada producto en YouTube. Son de odentIA, iguales
 * para toda clínica de ese producto: la aplicación solo los lee. `seen_at` es
 * la última lectura que lo encontró; el que ya no está en la lista deja de
 * mostrarse (`gone`) sin borrarse, para no perder a qué estaba unido.
 */
export const helpVideo = catalogSchema.table("help_video", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  product: text("product").notNull(),
  youtubeId: text("youtube_id").notNull(),
  title: text("title").notNull(),
  /** Nula si YouTube no la entregó. */
  durationSeconds: integer("duration_seconds"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  gone: boolean("gone").notNull().default(false),
}, table => [
  uniqueIndex("help_video_product_youtube_uidx").on(table.product, table.youtubeId),
  check("help_video_product_check", sql`${table.product} IN ('dental','medical','optical')`),
  check("help_video_duration_check", sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`),
])

/**
 * A qué respuesta de la guía está unido cada video, por la etiqueta de su
 * descripción (`#ayuda:<nombre fijo de la respuesta>`; `tema:<id>` para una
 * pantalla entera). Un video puede ir en varias respuestas y una respuesta
 * tener varios. `answer_hash` es la huella de las palabras de la respuesta
 * cuando se unió: si la respuesta cambió después, `review` lo marca para que
 * soporte lo mire; el video se sigue mostrando. `known` es falso si la
 * etiqueta no nombra nada de la guía de ese producto («sin unir»).
 */
export const helpVideoLink = catalogSchema.table("help_video_link", {
  videoId: uuid("video_id").notNull().references(() => helpVideo.id, { onDelete: "cascade" }),
  target: text("target").notNull(),
  /** Segundo donde empieza lo de esta respuesta; nulo, desde el principio. */
  startSeconds: integer("start_seconds"),
  known: boolean("known").notNull().default(true),
  answerHash: text("answer_hash"),
  review: boolean("review").notNull().default(false),
}, table => [
  primaryKey({ columns: [table.videoId, table.target] }),
  index("help_video_link_target_idx").on(table.target),
  check("help_video_link_start_check", sql`${table.startSeconds} is null or ${table.startSeconds} >= 0`),
])
