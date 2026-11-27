import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@odentia/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ImagePlus, MoreHorizontal, Star, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import { CATALOG_KEY } from "../catalogo"
import { api } from "../lib/api"
import { type GridRow, type Sheet, sameText } from "../lib/ficha"
import { Photo, shrinkPhoto, usePhotoUrl } from "../piezas"
import { useFichaContext } from "./contexto"
import { PRODUCT_KEY } from "./datos"
import { Section, Swatch } from "./piezas"

/**
 * Las fotos de la ficha (prototipo `ficha/fotos.tsx`, solo lo que ya guarda la base): la primera
 * es la portada; cada una dice de qué color es (el que Sofi manda cuando piden ese color). Subir
 * una foto es como hasta hoy; soltar, pegar, reordenar y el video llegan con su propio cambio.
 */

const MAX_PHOTOS = 8

/** El color de una foto: el que la tiene como su foto, o el que la base le asignó. */
function colorOf(sheet: Sheet, rows: GridRow[], photoId: string): GridRow | undefined {
  const byRow = rows.find((r) => r.photoId === photoId)
  if (byRow) return byRow
  const assigned = sheet.photos.find((p) => p.id === photoId)?.colorId
  const look = sheet.colors.find((c) => c.id === assigned)
  return look ? rows.find((r) => sameText(r.value, look.value)) : undefined
}

export function PhotosCard() {
  const { sheet, draft, store, edit, change } = useFichaContext()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const rows = draft.grid?.rowName ? draft.grid.rows : []
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, sheet.id) })
    await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
  }
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const blob = await shrinkPhoto(file)
        await api(`/api/tiendas/${store.id}/productos/${sheet.id}/fotos`, {
          method: "POST",
          raw: { type: blob.type, data: blob },
        })
      }
    },
    onSuccess: async (_, files) => {
      await refresh()
      toast.success(files.length === 1 ? "Foto agregada" : `${files.length} fotos agregadas`)
    },
    onError: async (error) => {
      await refresh()
      toast.error(error.message)
    },
  })
  const remove = useMutation({
    mutationFn: (photoId: string) =>
      api(`/api/tiendas/${store.id}/fotos/${photoId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refresh()
      toast.success("Foto quitada")
    },
    onError: (error) => toast.error(error.message),
  })
  const full = sheet.photos.length >= MAX_PHOTOS
  const withColor = sheet.photos.filter((p) => colorOf(sheet, rows, p.id)).length
  return (
    <Section
      id="fotos"
      title="Fotos"
      summary={`${sheet.photos.length} ${sheet.photos.length === 1 ? "foto" : "fotos"}${rows.length ? ` · ${withColor} con su color` : ""}`}
    >
      {sheet.photos.length === 0 ? (
        <button
          type="button"
          disabled={!edit || upload.isPending}
          onClick={() => input.current?.click()}
          className="flex min-h-48 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-input-border text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50 disabled:hover:bg-transparent"
        >
          <ImagePlus className="size-6" aria-hidden />
          <span className="font-medium text-foreground">
            {edit ? (upload.isPending ? "Subiendo…" : "Sube sus fotos") : "Sin fotos todavía"}
          </span>
          {edit ? (
            <span>JPG, PNG o WebP · la primera es la portada · hasta {MAX_PHOTOS}</span>
          ) : null}
        </button>
      ) : (
        <ul
          aria-label="Fotos, la primera es la portada"
          className="grid grid-cols-3 gap-3 sm:grid-cols-4"
        >
          {sheet.photos.map((photo, i) => {
            const color = colorOf(sheet, rows, photo.id)
            const cover = i === 0
            return (
              <li
                key={photo.id}
                className={cn(
                  "group relative overflow-hidden rounded-xl bg-muted",
                  cover ? "col-span-2 row-span-2 aspect-square" : "aspect-square",
                )}
              >
                <Photo
                  storeId={store.id}
                  photoId={photo.id}
                  alt={`Foto ${i + 1} de ${draft.name}${color ? `, ${color.value}` : ""}`}
                  className="size-full rounded-none"
                />
                {cover ? (
                  <Badge
                    variant="secondary"
                    className="absolute top-2 left-2 bg-background/90 backdrop-blur"
                  >
                    <Star aria-hidden />
                    Portada
                  </Badge>
                ) : null}
                {color ? (
                  <span className="absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
                    <Swatch hex={color.hex} hex2={color.hex2} />
                    <span className="truncate">{color.value}</span>
                  </span>
                ) : null}
                {edit ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="secondary"
                          aria-label={`Opciones de la foto ${i + 1}`}
                          className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                        />
                      }
                    >
                      <MoreHorizontal aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      {rows.map((row) => (
                        <DropdownMenuItem
                          key={row.id}
                          onClick={() =>
                            change(`La foto de «${row.value}»`, (d) => {
                              for (const r of d.grid?.rows ?? []) {
                                if (r.id === row.id) r.photoId = photo.id
                                else if (r.photoId === photo.id) r.photoId = null
                              }
                            })
                          }
                        >
                          <Swatch hex={row.hex} hex2={row.hex2} />
                          La que manda Sofi de «{row.value}»
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(photo.id)}
                      >
                        <Trash2 aria-hidden />
                        Quitar la foto
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            )
          })}
          {edit && !full ? (
            <li className="aspect-square">
              <button
                type="button"
                disabled={upload.isPending}
                onClick={() => input.current?.click()}
                className="flex size-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-input-border text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-primary-soft/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <ImagePlus className="size-5" aria-hidden />
                {upload.isPending ? "Subiendo…" : "Agregar"}
              </button>
            </li>
          ) : null}
        </ul>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTOS - sheet.photos.length)
          if (files.length > 0) upload.mutate(files)
          e.target.value = ""
        }}
      />
    </Section>
  )
}

/** En el celular, arriba de todo: las fotos para pasar con el dedo. */
export function PhotoCarousel() {
  const { sheet, draft, store } = useFichaContext()
  const [index, setIndex] = useState(0)
  const rows = draft.grid?.rowName ? draft.grid.rows : []
  return (
    <div className="-mx-4 flex flex-col gap-2">
      <div
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 [scrollbar-width:none]"
        onScroll={(e) => {
          const el = e.currentTarget
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth - 24)))
        }}
      >
        {sheet.photos.length === 0 ? (
          <div className="flex aspect-[6/5] w-full shrink-0 items-center justify-center rounded-2xl bg-muted text-sm text-muted-foreground">
            Sin fotos todavía
          </div>
        ) : (
          sheet.photos.map((photo, j) => (
            <CarouselPhoto
              key={photo.id}
              storeId={store.id}
              photoId={photo.id}
              alt={j === 0 ? `${draft.name}, portada` : ""}
              color={colorOf(sheet, rows, photo.id)}
            />
          ))
        )}
      </div>
      {sheet.photos.length > 1 ? (
        <div className="flex justify-center gap-1.5" aria-hidden>
          {sheet.photos.map((photo, j) => (
            <span
              key={photo.id}
              className={cn(
                "h-1.5 rounded-full bg-foreground/20 transition-all duration-300",
                j === index ? "w-4 bg-foreground/70" : "w-1.5",
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CarouselPhoto({
  storeId,
  photoId,
  alt,
  color,
}: {
  storeId: string
  photoId: string
  alt: string
  color?: GridRow
}) {
  const url = usePhotoUrl(storeId, photoId)
  return (
    <div className="relative aspect-[6/5] w-[calc(100%-1.5rem)] shrink-0 snap-center overflow-hidden rounded-2xl bg-muted first:w-full">
      {url ? <img src={url} alt={alt} className="size-full object-cover" /> : null}
      {color ? (
        <span className="absolute bottom-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
          <Swatch hex={color.hex} hex2={color.hex2} />
          {color.value}
        </span>
      ) : null}
    </div>
  )
}
