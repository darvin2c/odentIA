import {
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ImageOff } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError, api } from "./lib/api"
import { currencySymbol } from "./lib/tienda"

/** Las piezas que repiten las pantallas de la configuración de la tienda. */

/** Los errores que el servidor señala en un campo, y el resto junto a los botones. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fields : {}
}

export function generalError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError && Object.keys(error.fields).length > 0) return null
  return error instanceof Error ? error.message : "Algo falló. Inténtalo de nuevo."
}

export function FormAlert({ error }: { error: unknown }) {
  const message = generalError(error)
  return message ? (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  ) : null
}

export const SELECT_CLASSES =
  "h-9 w-full rounded-md border border-input-border bg-input/30 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"

/** Un campo de texto con su etiqueta, su ayuda y su error. */
export function TextField({
  label,
  value,
  onChange,
  error,
  help,
  placeholder,
  maxLength,
  autoFocus,
  inputMode,
  prefix,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  help?: ReactNode
  placeholder?: string
  maxLength?: number
  autoFocus?: boolean
  inputMode?: "decimal" | "numeric" | "text"
  /** Lo que va antes del valor, como el símbolo de la moneda. */
  prefix?: string
  className?: string
}) {
  const id = useId()
  const describedBy = error ? `${id}-error` : help ? `${id}-help` : undefined
  const input = (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      autoFocus={autoFocus}
      inputMode={inputMode}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      className={prefix ? "pl-9" : undefined}
    />
  )
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {prefix ? (
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
          >
            {prefix}
          </span>
          {input}
        </div>
      ) : (
        input
      )}
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : help ? (
        <FieldDescription id={`${id}-help`}>{help}</FieldDescription>
      ) : null}
    </Field>
  )
}

/** Un monto en la moneda de la tienda. */
export function MoneyField(
  props: Omit<Parameters<typeof TextField>[0], "prefix" | "inputMode"> & { currency: string },
) {
  const { currency, ...rest } = props
  return <TextField {...rest} prefix={currencySymbol(currency)} inputMode="decimal" />
}

/**
 * El panel lateral de un formulario: ocupa el ancho en el teléfono y deja ver la lista en el
 * escritorio. Enter en un campo de una línea guarda; Escape o «×» cierran.
 */
export function FormSheet({
  open,
  title,
  description,
  onClose,
  onSubmit,
  footer,
  dirty = false,
  wide = false,
  children,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  onSubmit: () => void
  footer: ReactNode
  children: ReactNode
  /** Hay algo escrito sin guardar: cerrar con × o Escape pregunta antes. */
  dirty?: boolean
  /** Un formulario largo (anotar un pedido) va en un panel más ancho. */
  wide?: boolean
}) {
  const [asking, setAsking] = useState(false)
  return (
    <>
      <ConfirmDialog
        open={asking}
        title="¿Salir sin guardar?"
        description="Lo que escribiste en este formulario se pierde."
        confirmLabel="Salir sin guardar"
        cancelLabel="Seguir aquí"
        onConfirm={() => {
          setAsking(false)
          onClose()
        }}
        onClose={() => setAsking(false)}
      />
      <Sheet
        open={open}
        onOpenChange={(next) => (next ? null : dirty ? setAsking(true) : onClose())}
      >
        <SheetContent
          className={cn(
            "data-[side=right]:w-full",
            wide ? "data-[side=right]:sm:max-w-2xl" : "data-[side=right]:sm:max-w-md",
          )}
        >
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              onSubmit()
            }}
          >
            <SheetHeader className="pr-14">
              <SheetTitle>{title}</SheetTitle>
              {description ? <SheetDescription>{description}</SheetDescription> : null}
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">{children}</div>
            <SheetFooter className="flex-row flex-wrap justify-end border-t py-4">
              {footer}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}

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
  }, [seen])
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

/** Un interruptor con su texto, que también lo enciende o apaga. */
export function SwitchField({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-3 text-sm">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id}>{label}</label>
    </div>
  )
}

/** Si lo del formulario cambió desde que se abrió (para preguntar antes de cerrarlo). */
export function useDirty(values: unknown): boolean {
  const [initial] = useState(() => JSON.stringify(values))
  return JSON.stringify(values) !== initial
}
