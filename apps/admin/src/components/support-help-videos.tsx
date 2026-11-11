/**
 * «Videos de la Ayuda» en Soporte › Conocimiento (ADR 0178): lo que el trabajo
 * diario leyó de YouTube y a qué respuesta de la guía quedó unido cada video.
 * Aquí no se une nada a mano: se copia la etiqueta de una respuesta para
 * ponerla en la descripción del video, y se dice «Sigue valiendo» cuando la
 * respuesta cambió y el video sirve igual.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import { Button, FieldLabel, Input, toast } from "@odentia/ui"
import { EmptyState, ErrorState, SkeletonRegion, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { ProductDot, ProductMark } from "./product"
import { SupportKnowledgeSkeleton } from "./skeletons/support"

const videoLink = z.object({
  target: z.string(),
  label: z.string().nullable(),
  startSeconds: z.number().nullable(),
  review: z.boolean(),
})
const videoRow = z.object({
  id: z.string(),
  product: z.enum(CLINICAL_PRODUCTS),
  title: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  gone: z.boolean(),
  links: z.array(videoLink),
})
type VideoRow = z.infer<typeof videoRow>
type VideoLink = z.infer<typeof videoLink>
const videosPayload = z.object({ data: z.array(videoRow) })

const tagRow = z.object({ tag: z.string(), label: z.string(), where: z.string() })
const tagsPayload = z.object({ data: z.array(tagRow) })

/** Cuántas etiquetas se muestran a la vez; el resto se alcanza escribiendo. */
const TAGS_SHOWN = 30

const dateWords = new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" })

/** Sin tildes ni mayúsculas, para que «atencion» encuentre «Atención». */
const plain = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()

/** «desde 1:30», como se lee en YouTube. */
function startWords(seconds: number | null): string {
  if (!seconds) return ""
  return ` · desde ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

export function SupportHelpVideos() {
  return (
    <section aria-label="Videos de la Ayuda" className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Videos de la Ayuda</h2>
      <p className="text-sm text-muted-foreground">
        Una vez al día se lee la lista de reproducción de YouTube de cada producto. Cada video se une a una respuesta
        de la guía por la etiqueta que lleva en su descripción, y Ariadna lo muestra debajo de esa respuesta. Aquí no
        se une a mano: quien sube el video pone la etiqueta, y el cambio se ve tras la lectura siguiente.
      </p>
      <VideoList />
      <TagFinder />
    </section>
  )
}

function VideoList() {
  const queryClient = useQueryClient()
  const videos = useQuery({
    queryKey: ["admin-support-help-videos"],
    queryFn: () =>
      api("/api/admin/support/help-videos").then((body: unknown) => videosPayload.parse(body).data),
  })
  const keep = useMutation({
    mutationFn: (input: { video: VideoRow; link: VideoLink }) =>
      api(`/api/admin/support/help-videos/${input.video.id}/keep`, {
        method: "POST",
        body: JSON.stringify({ target: input.link.target }),
      }),
    onSuccess: (_data, input) => {
      toast.success(`«${input.video.title}» sigue valiendo para «${input.link.label ?? input.link.target}»`)
      void queryClient.invalidateQueries({ queryKey: ["admin-support-help-videos"] })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Videos leídos</h3>
      {videos.isPending ? (
        <SkeletonRegion message="Cargando los videos de la Ayuda…">
          <SupportKnowledgeSkeleton />
        </SkeletonRegion>
      ) : videos.isError ? (
        <ErrorState message="No pude cargar los videos de la Ayuda." onRetry={() => void videos.refetch()} />
      ) : videos.data.length === 0 ? (
        <EmptyState
          title="Aún no hay videos leídos"
          description="Hace falta la clave de YouTube y la lista de reproducción de cada producto: las configura quien despliega. Con eso puesto, los videos aparecen aquí tras la lectura del día."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {videos.data.map((video) => (
            <li key={video.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ProductMark product={video.product} />
                <span className="text-xs text-muted-foreground">{dateWords.format(new Date(video.publishedAt))}</span>
              </span>
              <a
                className="min-w-0 self-start font-semibold text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
                href={video.url}
                target="_blank"
                rel="noreferrer"
              >
                {video.title}
                <span className="sr-only"> (abre YouTube en otra pestaña)</span>
              </a>
              {video.gone ? (
                <p>
                  <span className="font-semibold">Ya no está en la lista</span> de YouTube: no se muestra en la Ayuda.
                </p>
              ) : video.links.length === 0 ? (
                <p>
                  <span className="font-semibold">Sin etiqueta:</span> no se muestra en la Ayuda hasta que su
                  descripción en YouTube lleve una.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {video.links.map((link) => (
                    <li key={link.target} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {link.label === null ? (
                        <p className="min-w-0 [overflow-wrap:anywhere]">
                          <span className="font-semibold">Sin unir:</span> la etiqueta{" "}
                          <code className="font-mono text-xs">#ayuda:{link.target}</code> no es de la guía de{" "}
                          {productWords(video.product).name}.
                        </p>
                      ) : link.review ? (
                        <>
                          <p className="min-w-0 [overflow-wrap:anywhere]">
                            <span className="font-semibold">Por revisar: la respuesta cambió.</span> Unido a: {link.label}
                            {startWords(link.startSeconds)}. Se sigue mostrando.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-9"
                            disabled={keep.isPending}
                            aria-label={`Sigue valiendo: el video «${video.title}» para «${link.label}»`}
                            onClick={() => keep.mutate({ video, link })}
                          >
                            Sigue valiendo
                          </Button>
                        </>
                      ) : (
                        <p className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                          Unido a: {link.label}
                          {startWords(link.startSeconds)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TagFinder() {
  const [product, setProduct] = useState<ClinicalProduct | null>(null)
  const [search, setSearch] = useState("")
  // La lista se pide al elegir producto, no al abrir la pestaña.
  const tags = useQuery({
    queryKey: ["admin-support-help-video-tags", product],
    queryFn: () =>
      api(`/api/admin/support/help-videos/tags?product=${product}`).then(
        (body: unknown) => tagsPayload.parse(body).data,
      ),
    enabled: product !== null,
    staleTime: 300_000,
  })
  const found = useMemo(() => {
    const words = plain(search).split(/\s+/).filter(Boolean)
    const all = tags.data ?? []
    if (words.length === 0) return all
    return all.filter((row) => {
      const text = plain(`${row.label} ${row.where}`)
      return words.every((word) => text.includes(word))
    })
  }, [tags.data, search])
  const shown = found.slice(0, TAGS_SHOWN)

  function copy(tag: string) {
    void navigator.clipboard.writeText(tag).then(
      () => toast.success(`Etiqueta copiada: ${tag}`),
      () => toast.error("No se pudo copiar: selecciónala y cópiala a mano"),
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Buscar una etiqueta para copiar</h3>
      <p className="text-sm text-muted-foreground">
        Pega la etiqueta en la descripción del video en YouTube. Para que empiece en un momento del video, añade al
        final el segundo: <code className="font-mono text-xs">@90</code> o{" "}
        <code className="font-mono text-xs">@1m30s</code>.
      </p>
      <div role="group" aria-label="Producto de la etiqueta" className="flex flex-wrap gap-2">
        {CLINICAL_PRODUCTS.map((option) => (
          <Button
            key={option}
            type="button"
            aria-pressed={product === option}
            variant={product === option ? "default" : "outline"}
            className="min-h-11 gap-1.5 sm:min-h-9"
            onClick={() => setProduct(option)}
          >
            <ProductDot product={option} />
            {productWords(option).name}
          </Button>
        ))}
      </div>
      {product === null ? (
        <p className="text-sm text-muted-foreground">Elige un producto para ver sus etiquetas.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="soporte-etiqueta-buscar">Buscar por la pregunta o la pantalla</FieldLabel>
            <Input
              id="soporte-etiqueta-buscar"
              type="search"
              className="w-full sm:w-96"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {tags.isPending ? (
            <SkeletonRegion message="Cargando las etiquetas…">
              <SupportKnowledgeSkeleton />
            </SkeletonRegion>
          ) : tags.isError ? (
            <ErrorState message="No pude cargar las etiquetas." onRetry={() => void tags.refetch()} />
          ) : (
            <>
              <p aria-live="polite" className="text-sm text-muted-foreground">
                {found.length === 0
                  ? `Ninguna etiqueta de ${productWords(product).name} coincide con lo escrito.`
                  : found.length > shown.length
                    ? `${found.length} etiquetas; se muestran las primeras ${shown.length}. Escribe para acotar.`
                    : `${found.length} ${found.length === 1 ? "etiqueta" : "etiquetas"}.`}
              </p>
              {shown.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {shown.map((row) => (
                    <li
                      key={row.tag}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2.5 text-sm"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-semibold [overflow-wrap:anywhere]">{row.label}</span>
                        <span className="text-muted-foreground [overflow-wrap:anywhere]">
                          Pantalla: {row.where} · <code className="font-mono text-xs">{row.tag}</code>
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 shrink-0 sm:min-h-9"
                        aria-label={`Copiar etiqueta de ${row.label}`}
                        onClick={() => copy(row.tag)}
                      >
                        Copiar etiqueta
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
