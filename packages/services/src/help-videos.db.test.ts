import type { ClinicalProduct } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { helpVideo, helpVideoLink } from "@odentia/db/schema/help"
import { and, asc, eq, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { askHelp, type HelpAsker } from "./help.js"
import type { HelpTopic } from "./help-guide.js"
import { helpAnswerHash, type HelpVideoItem, helpVideosFor, keepHelpVideoLink, syncHelpVideos } from "./help-videos.js"
import { helpTopicsFor } from "./products.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Los videos de la Ayuda con base (ADR 0178): lo que el worker deja al leer la
 * lista de YouTube, lo que ve quien pregunta y lo que el rol de la aplicación
 * puede y no puede. Lo que no necesita base está en `help-videos.test.ts`.
 *
 * Las tablas son de odentIA, no de una clínica, y una lectura deja «fuera de la
 * lista» todo lo de su producto que no trae: cada bloque usa un producto, o
 * dice la lista entera cada vez.
 */
setupTestDb()

const USER = "help-video-user"
const STAFF: AdminActor = { userId: "help-video-staff", role: "support" }
const NOW = new Date("2026-11-10T08:00:00Z")

/** Una guía de muestra: completar la guía de verdad no mueve estas pruebas. */
const GUIDE: HelpTopic[] = [
  {
    id: "tareas",
    path: "/tasks",
    title: "Tareas",
    parent: null,
    purpose: "Los pendientes del equipo.",
    terms: [],
    faqs: [
      { id: "tareas-crear", q: "¿Cómo creo una tarea?", a: "En Tareas, «Nueva tarea»: escribe qué hay que hacer y pulsa «Guardar»." },
      { id: "tareas-asignar", q: "¿Cómo le paso una tarea a otra persona?", a: "Abre la tarea y elige a quién en «Responsable»." },
    ],
  },
]
/** La misma guía con otra respuesta en una pregunta (o en el párrafo de la pantalla, con `purpose`). */
const guideWith = (change: { answer?: string; purpose?: string; extra?: boolean }): HelpTopic[] =>
  GUIDE.map((topic) => ({
    ...topic,
    purpose: change.purpose ?? topic.purpose,
    faqs: [
      ...(topic.faqs ?? []).map((faq) => (faq.id === "tareas-crear" && change.answer ? { ...faq, a: change.answer } : faq)),
      ...(change.extra ? [{ id: "tareas-borrar", q: "¿Cómo borro una tarea?", a: "Una tarea no se borra: se marca «Hecha»." }] : []),
    ],
  }))
const CREATE_ANSWER = GUIDE[0]!.faqs![0]!.a
const ASSIGN_ANSWER = GUIDE[0]!.faqs![1]!.a

const video = (youtubeId: string, description: string, day = "2026-01-01", durationSeconds: number | null = 120): HelpVideoItem => ({
  youtubeId,
  title: `Video ${youtubeId}`,
  description,
  publishedAt: new Date(`${day}T12:00:00Z`),
  durationSeconds,
})

const videosOf = (product: ClinicalProduct) => ownerDb.select().from(helpVideo).where(eq(helpVideo.product, product)).orderBy(asc(helpVideo.youtubeId))
const videoOf = async (product: ClinicalProduct, youtubeId: string) => {
  const [row] = await ownerDb.select().from(helpVideo).where(and(eq(helpVideo.product, product), eq(helpVideo.youtubeId, youtubeId)))
  if (!row) throw new Error(`No se leyó el video ${youtubeId}`)
  return row
}
const linksOf = (product: ClinicalProduct, youtubeId: string) =>
  ownerDb
    .select({ target: helpVideoLink.target, startSeconds: helpVideoLink.startSeconds, known: helpVideoLink.known, answerHash: helpVideoLink.answerHash, review: helpVideoLink.review })
    .from(helpVideoLink)
    .innerJoin(helpVideo, eq(helpVideo.id, helpVideoLink.videoId))
    .where(and(eq(helpVideo.product, product), eq(helpVideo.youtubeId, youtubeId)))
    .orderBy(asc(helpVideoLink.target))

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: USER, name: "Rosa Recepción", email: "rosa@videos.test", emailVerified: true },
    { id: STAFF.userId, name: "Soporte videos", email: "soporte@videos.test", emailVerified: true },
  ])
})

describe("leer la lista de un producto", () => {
  const A = video("vid-a", "Cómo se crea una tarea.\n#ayuda:tareas-crear #ayuda:tareas-asignar@90", "2026-02-01", 185)
  const B = video("vid-b", "La pantalla entera #ayuda:tema:tareas@1m30s y algo que no existe #ayuda:tareas-borrar", "2026-03-01", null)
  const C = video("vid-c", "Un video sin etiquetas #odontología", "2026-04-01")

  it("une cada etiqueta a su respuesta, y lo que no nombra nada queda sin unir", async () => {
    // El video de otro producto, para ver al final que nadie lo toca.
    await syncHelpVideos(ownerDb, "optical", [video("vid-otro", "#ayuda:tareas-crear")], NOW, GUIDE)

    expect(await syncHelpVideos(ownerDb, "medical", [A, B, C], NOW, GUIDE)).toEqual({ videos: 3, gone: 0, linked: 3, unknown: 1, review: 0 })
    expect((await videosOf("medical")).map((row) => [row.youtubeId, row.title, row.durationSeconds, row.publishedAt.toISOString(), row.seenAt.toISOString(), row.gone])).toEqual([
      ["vid-a", "Video vid-a", 185, "2026-02-01T12:00:00.000Z", NOW.toISOString(), false],
      ["vid-b", "Video vid-b", null, "2026-03-01T12:00:00.000Z", NOW.toISOString(), false],
      ["vid-c", "Video vid-c", 120, "2026-04-01T12:00:00.000Z", NOW.toISOString(), false],
    ])
    expect(await linksOf("medical", "vid-a")).toEqual([
      { target: "tareas-asignar", startSeconds: 90, known: true, answerHash: helpAnswerHash(ASSIGN_ANSWER), review: false },
      { target: "tareas-crear", startSeconds: null, known: true, answerHash: helpAnswerHash(CREATE_ANSWER), review: false },
    ])
    expect(await linksOf("medical", "vid-b")).toEqual([
      { target: "tareas-borrar", startSeconds: null, known: false, answerHash: null, review: false },
      { target: "tema:tareas", startSeconds: 90, known: true, answerHash: helpAnswerHash("Los pendientes del equipo."), review: false },
    ])
    expect(await linksOf("medical", "vid-c")).toEqual([])
  })

  it("leer otra vez no duplica nada, y deja el título, el segundo y las etiquetas como están hoy en YouTube", async () => {
    const before = await videosOf("medical")
    const later = new Date(NOW.getTime() + 86_400_000)
    const renamed = { ...A, title: `${"Título nuevo ".repeat(40)}`, description: "#ayuda:tareas-crear@15", durationSeconds: 200 }
    expect(await syncHelpVideos(ownerDb, "medical", [renamed, B, C], later, GUIDE)).toEqual({ videos: 3, gone: 0, linked: 2, unknown: 1, review: 0 })
    const after = await videosOf("medical")
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(after[0]).toMatchObject({ youtubeId: "vid-a", durationSeconds: 200, gone: false })
    expect(after[0]?.title).toHaveLength(300)
    expect(after.every((row) => row.seenAt.getTime() === later.getTime())).toBe(true)
    // La etiqueta que se quitó de la descripción deja de estar unida; la que sigue, con su segundo nuevo.
    expect(await linksOf("medical", "vid-a")).toEqual([{ target: "tareas-crear", startSeconds: 15, known: true, answerHash: helpAnswerHash(CREATE_ANSWER), review: false }])
    await syncHelpVideos(ownerDb, "medical", [A, B, C], NOW, GUIDE)
    expect((await linksOf("medical", "vid-a")).map((link) => [link.target, link.startSeconds])).toEqual([["tareas-asignar", 90], ["tareas-crear", null]])
  })

  it("una etiqueta sin unir se une sola el día que la guía tiene esa respuesta", async () => {
    expect(await syncHelpVideos(ownerDb, "medical", [A, B, C], NOW, guideWith({ extra: true }))).toMatchObject({ linked: 4, unknown: 0, review: 0 })
    expect((await linksOf("medical", "vid-b"))[0]).toEqual({
      target: "tareas-borrar", startSeconds: null, known: true, answerHash: helpAnswerHash("Una tarea no se borra: se marca «Hecha»."), review: false,
    })
    // Y si la guía la pierde, vuelve a quedar sin unir: no se muestra ni pide revisión.
    expect(await syncHelpVideos(ownerDb, "medical", [A, B, C], NOW, GUIDE)).toMatchObject({ linked: 3, unknown: 1, review: 0 })
    expect((await linksOf("medical", "vid-b"))[0]).toMatchObject({ target: "tareas-borrar", known: false, review: false })
  })

  it("lo que dejó de venir queda fuera de la lista sin borrarse, y vuelve si vuelve", async () => {
    expect(await syncHelpVideos(ownerDb, "medical", [A, C], NOW, GUIDE)).toEqual({ videos: 2, gone: 1, linked: 2, unknown: 0, review: 0 })
    expect((await videosOf("medical")).map((row) => [row.youtubeId, row.gone])).toEqual([["vid-a", false], ["vid-b", true], ["vid-c", false]])
    // No pierde a qué estaba unido.
    expect((await linksOf("medical", "vid-b")).map((link) => link.target)).toEqual(["tareas-borrar", "tema:tareas"])
    // Lo que ya estaba fuera no se cuenta otra vez.
    expect((await syncHelpVideos(ownerDb, "medical", [A, C], NOW, GUIDE)).gone).toBe(0)

    expect(await syncHelpVideos(ownerDb, "medical", [A, B, C], NOW, GUIDE)).toEqual({ videos: 3, gone: 0, linked: 3, unknown: 1, review: 0 })
    expect((await videoOf("medical", "vid-b")).gone).toBe(false)

    // Una lista vacía los deja a todos fuera; los de otro producto no se tocan.
    expect(await syncHelpVideos(ownerDb, "medical", [], NOW, GUIDE)).toEqual({ videos: 0, gone: 3, linked: 0, unknown: 0, review: 0 })
    expect((await videosOf("medical")).every((row) => row.gone)).toBe(true)
    expect((await videosOf("optical")).map((row) => [row.youtubeId, row.gone])).toEqual([["vid-otro", false]])
  })
})

describe("la respuesta cambió después de unir el video", () => {
  const V = video("vid-revisar", "#ayuda:tareas-crear #ayuda:tema:tareas", "2026-05-01")
  const sync = (topics: HelpTopic[]) => syncHelpVideos(ownerDb, "optical", [V], NOW, topics)
  const link = async (target: string) => (await linksOf("optical", "vid-revisar")).find((item) => item.target === target)
  const JOINED = helpAnswerHash(CREATE_ANSWER)

  it("queda «por revisar» sin pisar la huella de cuando se unió, y el video se sigue mostrando", async () => {
    expect(await sync(GUIDE)).toMatchObject({ linked: 2, review: 0 })
    // Corregir una coma o una tilde no es cambiar lo que dice.
    expect(await sync(guideWith({ answer: "en Tareas «Nueva tarea» — escribe que hay que hacer, y pulsa «Guardar»" }))).toMatchObject({ review: 0 })
    expect(await link("tareas-crear")).toMatchObject({ answerHash: JOINED, review: false })

    const changed = guideWith({ answer: "En Tareas, «Nueva tarea»: escribe qué hay que hacer, elige quién la lleva y pulsa «Crear»." })
    expect(await sync(changed)).toMatchObject({ linked: 2, review: 1 })
    expect(await link("tareas-crear")).toMatchObject({ known: true, answerHash: JOINED, review: true })
    expect(await link("tema:tareas")).toMatchObject({ review: false })
    // Otra lectura no la da por vista ni cambia la huella: sigue pidiendo que alguien la mire.
    expect(await sync(changed)).toMatchObject({ review: 1 })
    expect(await link("tareas-crear")).toMatchObject({ answerHash: JOINED, review: true })
    expect((await helpVideosFor(ownerDb, "optical", ["tareas-crear"])).get("tareas-crear")).toEqual([
      { title: "Video vid-revisar", url: "https://www.youtube.com/watch?v=vid-revisar", minutes: 2 },
    ])

    // El párrafo de la pantalla también tiene su huella.
    expect(await sync(guideWith({ purpose: "Los pendientes del equipo, con búsqueda." }))).toMatchObject({ review: 1 })
    expect(await link("tema:tareas")).toMatchObject({ answerHash: helpAnswerHash("Los pendientes del equipo."), review: true })
    expect(await link("tareas-crear")).toMatchObject({ review: false })
    // Si la respuesta vuelve a decir lo de antes, no hay nada que revisar.
    expect(await sync(GUIDE)).toMatchObject({ review: 0 })
    expect(await link("tema:tareas")).toMatchObject({ review: false })
  })
})

describe("lo que ve quien pregunta", () => {
  const REAL = helpTopicsFor("dental")
  const realAnswer = (id: string) => {
    const faq = REAL.flatMap((topic) => topic.faqs ?? []).find((item) => item.id === id)
    if (!faq) throw new Error(`La guía no tiene ${id}`)
    return faq
  }
  const CREATE = realAnswer("tareas-crear")
  const asker: HelpAsker = { userId: USER, roleLabel: "Propietario", canOpen: () => true, can: () => true, whoCan: () => [] }

  const OLD = video("vid-viejo", "#ayuda:tareas-crear", "2026-01-01", 600)
  const MID = video("vid-medio", "#ayuda:tareas-crear@90", "2026-03-01", 200)
  const RECENT = video("vid-reciente", "#ayuda:tareas-crear@1m5s #ayuda:tema:agenda", "2026-05-01", 20)
  const NEWEST = video("vid-ultimo", "#ayuda:tareas-crear", "2026-06-01", 300)
  const STRAY = video("vid-suelto", "#ayuda:no-existe-en-la-guia", "2026-07-01")
  /** Lo que se muestra bajo «¿Cómo creo una tarea?» cuando el último ya no está en la lista. */
  const SHOWN = [
    { title: "Video vid-reciente", url: "https://www.youtube.com/watch?v=vid-reciente&t=65s", minutes: 1 },
    { title: "Video vid-medio", url: "https://www.youtube.com/watch?v=vid-medio&t=90s", minutes: 3 },
  ]

  it("«Sigue valiendo» deja la huella de hoy y quita el «por revisar»", async () => {
    // El video se unió cuando la respuesta decía otra cosa; hoy la guía de verdad dice la suya.
    const earlier = REAL.map((topic) => ({ ...topic, faqs: (topic.faqs ?? []).map((faq) => (faq.id === "tareas-crear" ? { ...faq, a: "En Tareas, pulsa «Nueva tarea»." } : faq)) }))
    expect(await syncHelpVideos(ownerDb, "dental", [OLD], NOW, earlier)).toMatchObject({ linked: 1, review: 0 })
    expect(await syncHelpVideos(ownerDb, "dental", [OLD], NOW)).toMatchObject({ linked: 1, review: 1 })
    const { id } = await videoOf("dental", "vid-viejo")
    expect(await linksOf("dental", "vid-viejo")).toEqual([{ target: "tareas-crear", startSeconds: null, known: true, answerHash: helpAnswerHash("En Tareas, pulsa «Nueva tarea»."), review: true }])

    // Solo una unión que existe: ni otro video, ni una respuesta a la que no está unido, ni algo que la guía no tiene.
    await expect(keepHelpVideoLink(ownerDb, STAFF, randomUUID(), "tareas-crear")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(keepHelpVideoLink(ownerDb, STAFF, id, "tareas-asignar")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(keepHelpVideoLink(ownerDb, STAFF, id, "no-existe-en-la-guia")).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await linksOf("dental", "vid-viejo"))[0]?.review).toBe(true)

    await keepHelpVideoLink(ownerDb, STAFF, id, "tareas-crear")
    expect(await linksOf("dental", "vid-viejo")).toEqual([{ target: "tareas-crear", startSeconds: null, known: true, answerHash: helpAnswerHash(CREATE.a), review: false }])
    // La lectura siguiente no vuelve a pedirlo.
    expect(await syncHelpVideos(ownerDb, "dental", [OLD], NOW)).toMatchObject({ linked: 1, review: 0 })
    const audit = await ownerDb.execute<{ total: number }>(sql`select count(*)::int as total from admin_audit where action = 'support.help_videos.keep' and actor_user_id = ${STAFF.userId}`)
    expect(audit[0]?.total).toBe(1)
  })

  it("hasta dos por respuesta, los más nuevos primero, desde su segundo; nada de lo que salió de la lista o quedó sin unir", async () => {
    expect(await syncHelpVideos(ownerDb, "dental", [OLD, MID, RECENT, NEWEST, STRAY], NOW)).toEqual({ videos: 5, gone: 0, linked: 5, unknown: 1, review: 0 })
    const org = randomUUID()
    await insertOrg(ownerDb, org, `videos-${org}`)
    const read = (product: ClinicalProduct, targets: string[]) => withOrgContext(appDb, org, (tx) => helpVideosFor(tx, product, targets))

    const all = await read("dental", ["tareas-crear", "tema:agenda", "tareas-asignar", "no-existe-en-la-guia", "tareas-crear"])
    expect(all.get("tareas-crear")).toEqual([
      { title: "Video vid-ultimo", url: "https://www.youtube.com/watch?v=vid-ultimo", minutes: 5 },
      { title: "Video vid-reciente", url: "https://www.youtube.com/watch?v=vid-reciente&t=65s", minutes: 1 },
    ])
    // El mismo video va en dos respuestas, cada una desde su segundo.
    expect(all.get("tema:agenda")).toEqual([{ title: "Video vid-reciente", url: "https://www.youtube.com/watch?v=vid-reciente", minutes: 1 }])
    // Una respuesta sin videos y una etiqueta sin unir no están.
    expect([...all.keys()].sort()).toEqual(["tareas-crear", "tema:agenda"])

    // El más nuevo sale de la lista de YouTube: deja de mostrarse y entra el siguiente.
    expect(await syncHelpVideos(ownerDb, "dental", [OLD, MID, RECENT, STRAY], NOW)).toMatchObject({ videos: 4, gone: 1 })
    expect((await read("dental", ["tareas-crear"])).get("tareas-crear")).toEqual(SHOWN)
    // Sin nada que buscar no hay nada; y los de un producto no salen en otro.
    expect((await read("dental", [])).size).toBe(0)
    expect((await read("medical", ["tareas-crear", "tema:agenda"])).size).toBe(0)
  })

  it("la Ayuda los devuelve en su respuesta, también a quien no abre esa pantalla", async () => {
    const org = randomUUID()
    await insertOrg(ownerDb, org, `videos-${org}`)
    const reply = await askHelp(appDb, org, asker, { question: CREATE.q, screen: "/home" })
    expect(reply.kind).toBe("guia")
    expect(reply.answers).toEqual([{ topicId: "tareas", where: "Tareas", text: CREATE.a, path: "/tasks", restriction: null, videos: SHOWN }])
    // El párrafo de una pantalla lleva los videos de la pantalla entera, no los de sus preguntas.
    const screen = await askHelp(appDb, org, asker, { question: "¿Qué es Agenda?", screen: "/home" })
    expect(screen.answers[0]).toMatchObject({ topicId: "agenda", videos: [{ title: "Video vid-reciente", url: "https://www.youtube.com/watch?v=vid-reciente", minutes: 1 }] })
    // Una respuesta sin videos trae la lista vacía.
    expect((await askHelp(appDb, org, asker, { question: realAnswer("tareas-asignar").q, screen: "/home" })).answers[0]?.videos).toEqual([])
    // Son de odentIA y públicos: se muestran aunque el rol no abra esa pantalla.
    const outside = await askHelp(appDb, org, { ...asker, roleLabel: "Caja", canOpen: () => false }, { question: CREATE.q, screen: "/home" })
    expect(outside.answers[0]).toMatchObject({ path: null, restriction: expect.stringContaining("no tiene acceso"), videos: SHOWN })

    // Una clínica de otro producto no ve los videos de odentIA, aunque su guía tenga la misma respuesta.
    const medical = randomUUID()
    await insertOrg(ownerDb, medical, `videos-${medical}`)
    await ownerDb.execute(sql`update org_profile set product = 'medical' where organization_id = ${medical}`)
    const other = await askHelp(appDb, medical, asker, { question: CREATE.q, screen: "/home" })
    expect(other).toMatchObject({ kind: "guia" })
    expect(other.answers[0]).toMatchObject({ topicId: "tareas", videos: [] })
  })
})

describe("el rol de la aplicación", () => {
  it("lee los videos y sus uniones, y no puede escribirlos", async () => {
    const [row] = await appDb.select().from(helpVideo).where(and(eq(helpVideo.product, "dental"), eq(helpVideo.youtubeId, "vid-medio")))
    expect(row).toMatchObject({ title: "Video vid-medio", gone: false })
    expect(await appDb.select().from(helpVideoLink).where(eq(helpVideoLink.videoId, row!.id))).toEqual([
      { videoId: row!.id, target: "tareas-crear", startSeconds: 90, known: true, answerHash: expect.any(String), review: false },
    ])

    const denied = { cause: { code: "42501" } }
    await expect(appDb.insert(helpVideo).values({ product: "dental", youtubeId: "vid-de-la-app", title: "No", publishedAt: NOW })).rejects.toMatchObject(denied)
    await expect(appDb.update(helpVideo).set({ gone: true }).where(eq(helpVideo.id, row!.id))).rejects.toMatchObject(denied)
    await expect(appDb.delete(helpVideo).where(eq(helpVideo.id, row!.id))).rejects.toMatchObject(denied)
    await expect(appDb.insert(helpVideoLink).values({ videoId: row!.id, target: "tareas-asignar" })).rejects.toMatchObject(denied)
    await expect(appDb.update(helpVideoLink).set({ review: true }).where(eq(helpVideoLink.videoId, row!.id))).rejects.toMatchObject(denied)
    await expect(appDb.delete(helpVideoLink).where(eq(helpVideoLink.videoId, row!.id))).rejects.toMatchObject(denied)
    // Tampoco dentro de la clínica, ni con el servicio que lee la lista.
    await expect(withOrgContext(appDb, "org_a", (tx) => tx.update(helpVideo).set({ gone: true }).where(eq(helpVideo.id, row!.id)))).rejects.toMatchObject(denied)
    await expect(syncHelpVideos(appDb, "dental", [video("vid-de-la-app", "#ayuda:tareas-crear")], NOW)).rejects.toMatchObject(denied)
    await expect(keepHelpVideoLink(appDb, STAFF, row!.id, "tareas-crear")).rejects.toMatchObject(denied)

    // Nada cambió.
    expect((await videosOf("dental")).map((item) => [item.youtubeId, item.gone])).toEqual([
      ["vid-medio", false], ["vid-reciente", false], ["vid-suelto", false], ["vid-ultimo", true], ["vid-viejo", false],
    ])
  })
})
