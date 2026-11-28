import { cn } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { ImageOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api } from "./lib/api"

/**
 * Lo que gestorIA necesita y lo común no tiene: las fotos del catálogo y la captura de un pago
 * (que se piden con la sesión), achicar una foto antes de subirla y descargar un archivo.
 */
/** Una foto del catálogo: se pide con la sesión (no es pública) y se muestra al llegar. */
export function Photo({
  storeId,
  photoId,
  alt,
  className,
}: {
  storeId: string
  photoId: string | null
  alt: string
  className?: string
}) {
  // Se pide al acercarse a la vista: un catálogo largo no baja todas sus fotos de una vez.
  const [seen, setSeen] = useState(false)
  const holder = useRef<HTMLSpanElement>(null)
  // Se vuelve a mirar si la foto llega después (antes no había dónde observar).
  // biome-ignore lint/correctness/useExhaustiveDependencies: photoId cambia qué se dibuja
  useEffect(() => {
    const node = holder.current
    if (!node || seen) return
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      { rootMargin: "200px" },
    )
    watch.observe(node)
    return () => watch.disconnect()
  }, [seen, photoId])
  const blob = useQuery({
    queryKey: ["foto", storeId, photoId],
    queryFn: () => api<Blob>(`/api/tiendas/${storeId}/fotos/${photoId}`, { as: "blob" }),
    enabled: Boolean(photoId) && seen,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data) return
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data])
  const box = cn("shrink-0 overflow-hidden rounded-lg bg-muted", className)
  if (!photoId)
    return (
      <span className={cn(box, "flex items-center justify-center text-muted-foreground")}>
        <ImageOff className="size-4" aria-hidden />
        <span className="sr-only">Sin foto</span>
      </span>
    )
  return url ? (
    <img src={url} alt={alt} className={cn(box, "object-cover")} />
  ) : (
    <span ref={holder} className={box} />
  )
}

/**
 * La dirección de una foto de la tienda para mostrarla o leer sus colores: la misma que pide
 * `Photo`, una sola vez por foto. Vacía mientras llega.
 */
export function usePhotoUrl(storeId: string, photoId: string | null): string | null {
  const blob = useQuery({
    queryKey: ["foto", storeId, photoId],
    queryFn: () => api<Blob>(`/api/tiendas/${storeId}/fotos/${photoId}`, { as: "blob" }),
    enabled: Boolean(photoId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data) return
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data])
  return photoId ? url : null
}

/**
 * Achica una foto antes de subirla (hasta 1600 px por lado, WebP o, si el navegador no lo
 * escribe, JPEG): llega más rápido y pesa menos de lo que acepta el servidor.
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("No se pudo abrir esa imagen. Prueba con una foto en JPG, PNG o WebP.")
  })
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85))
  const webp = await encode("image/webp")
  const blob = webp?.type === "image/webp" ? webp : await encode("image/jpeg")
  if (!blob) throw new Error("No se pudo preparar la foto. Prueba con otra.")
  return blob
}

/** Descarga un archivo que llegó del servidor. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** La captura (o el voucher) de un pago, que se abre en grande con un toque. */
export function ReceiptImage({
  storeId,
  orderId,
  paymentId,
}: {
  storeId: string
  orderId: string
  paymentId: string
}) {
  const blob = useQuery({
    queryKey: ["captura", storeId, paymentId],
    queryFn: () =>
      api<Blob>(`/api/tiendas/${storeId}/pedidos/${orderId}/pagos/${paymentId}/captura`, {
        as: "blob",
      }),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data) return
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data])
  if (blob.isError)
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <ImageOff className="size-4" aria-hidden /> No se pudo abrir la captura
      </span>
    )
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={url} alt="Captura del pago" className="max-h-64 rounded-lg border object-contain" />
    </a>
  ) : (
    <span className="block h-24 w-40 animate-pulse rounded-lg bg-muted" />
  )
}
