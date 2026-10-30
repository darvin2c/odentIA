import { Button, cn, Field, FieldLabel, Slider } from "@odentia/ui"
import { Camera, ImageUp, RotateCw } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import Cropper, { type Area, type Point } from "react-easy-crop"
import ReactCrop, { type PercentCrop } from "react-image-crop"
import { personInitials } from "./person-avatar.js"

/**
 * Qué se encuadra: la foto de una persona (cuadrada con máscara redonda) o el
 * logo de una clínica (un rectángulo libre sobre fondo de cuadros).
 */
export type ImageAdjustShape = "person" | "logo"

/** Lo elegido y cómo se recortó, en píxeles de la imagen original. */
export interface ImageAdjustValue {
  shape: ImageAdjustShape
  source: string
  area: Area
}

/** Lado mayor de lo que se sube: basta para el avatar grande y pesa poco (tablero 6). */
export const ADJUSTED_IMAGE_SIZE = 512
/** Lo que se puede elegir; se achica antes de subir, así que admite fotos grandes del teléfono. */
export const IMAGE_ADJUST_MAX_INPUT_BYTES = 20 * 1024 * 1024
const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.1
const PERSON_TYPES = ["image/jpeg", "image/png", "image/webp"]
const LOGO_TYPES = [...PERSON_TYPES, "image/svg+xml"]

/** Fondo de cuadros: lo transparente del logo se ve como transparente. */
const CHECKERBOARD =
  "bg-[repeating-conic-gradient(var(--color-muted)_0_25%,var(--color-background)_0_50%)] bg-[length:16px_16px]"

async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = "async"
  image.src = source
  await image.decode()
  return image
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>()
  canvas.toBlob(resolve, type, quality)
  return promise
}

/**
 * Pasa la imagen a un lienzo de píxeles. Un SVG se dibuja a 1024 px por su
 * lado mayor (sin medidas propias, cuadrado): se guarda como imagen, nunca
 * como SVG, porque un SVG puede llevar código y la carpeta de imágenes es
 * pública.
 */
async function rasterize(
  source: string,
  { rotateQuarter = false, vector = false }: { rotateQuarter?: boolean; vector?: boolean } = {},
): Promise<string> {
  const image = await loadImage(source)
  const naturalWidth = image.naturalWidth || 1024
  const naturalHeight = image.naturalHeight || 1024
  // Un dibujo vectorial no pierde nada al agrandarse: se dibuja a 1024 px.
  const scale = vector ? 1024 / Math.max(naturalWidth, naturalHeight) : 1
  const width = Math.round(naturalWidth * scale)
  const height = Math.round(naturalHeight * scale)
  const canvas = document.createElement("canvas")
  canvas.width = rotateQuarter ? height : width
  canvas.height = rotateQuarter ? width : height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("No se pudo preparar la imagen.")
  if (rotateQuarter) {
    context.translate(canvas.width, 0)
    context.rotate(Math.PI / 2)
  }
  context.drawImage(image, 0, 0, width, height)
  const blob = await canvasBlob(canvas, "image/png")
  if (!blob) throw new Error("No se pudo preparar la imagen.")
  return URL.createObjectURL(blob)
}

/**
 * Lo que se sube: el recorte a 512 px por su lado mayor, en WebP. Un navegador
 * que no escribe WebP entrega JPEG la foto y PNG el logo (que conserva lo
 * transparente). La foto va sobre blanco, como cuando se imprime.
 */
export async function renderAdjustedImage(
  value: ImageAdjustValue,
  size = ADJUSTED_IMAGE_SIZE,
): Promise<{ blob: Blob; ext: "webp" | "jpg" | "png" }> {
  const image = await loadImage(value.source)
  const { area } = value
  const scale = Math.min(1, size / Math.max(area.width, area.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(value.shape === "person" ? size : area.width * scale))
  canvas.height = Math.max(1, Math.round(value.shape === "person" ? size : area.height * scale))
  const context = canvas.getContext("2d")
  if (!context) throw new Error("No se pudo preparar la imagen.")
  context.imageSmoothingQuality = "high"
  if (value.shape === "person") {
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  const webp = await canvasBlob(canvas, "image/webp", 0.86)
  if (webp?.type === "image/webp") return { blob: webp, ext: "webp" }
  const fallbackType = value.shape === "person" ? "image/jpeg" : "image/png"
  const fallback = await canvasBlob(canvas, fallbackType, 0.9)
  if (!fallback) throw new Error("No se pudo generar la imagen.")
  return { blob: fallback, ext: value.shape === "person" ? "jpg" : "png" }
}

export interface ImageAdjustProps {
  shape: ImageAdjustShape
  /** De quién es: las iniciales de la vista previa y los textos («Foto de Rosa»). */
  name: string
  /** Avisa lo elegido y su recorte, o null si aún no hay imagen. */
  onChange: (value: ImageAdjustValue | null) => void
  disabled?: boolean
  /** Imagen con la que empieza (stories y pruebas). */
  defaultSource?: string
  /** Del campo del formulario: va a la raíz (los botones conservan su propio nombre). */
  id?: string
  /** El campo tiene un error (falta la imagen, el servidor la rechazó). */
  invalid?: boolean
  "aria-describedby"?: string
}

/**
 * «Ajustar imagen» (tablero 6 del lienzo de Pacientes): elegir un archivo,
 * arrastrarlo o tomar la foto; encuadrar con el ratón, el dedo o el teclado
 * (las flechas mueven, + y − acercan: arrastrar nunca es la única forma,
 * WCAG 2.5.7); girar; y ver cómo queda antes de guardar. Lo mismo para la foto
 * del paciente, la de Mi perfil y el logo de la clínica. No sube nada: quien
 * lo usa guarda con `renderAdjustedImage`.
 */
export function ImageAdjust({
  shape,
  name,
  onChange,
  disabled = false,
  defaultSource,
  id: fieldId,
  invalid = false,
  "aria-describedby": describedBy,
}: ImageAdjustProps) {
  const id = useId()
  const errorId = `${id}-error`
  const types = shape === "logo" ? LOGO_TYPES : PERSON_TYPES
  const [source, setSource] = useState<string | null>(defaultSource ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const owned = useRef<string[]>([])
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Las direcciones `blob:` que se crearon aquí se liberan al salir.
  useEffect(
    () => () => {
      for (const url of owned.current) URL.revokeObjectURL(url)
    },
    [],
  )
  const own = (url: string): string => {
    if (url.startsWith("blob:")) owned.current.push(url)
    return url
  }

  const choose = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!types.includes(file.type)) {
      setError(
        shape === "logo"
          ? "Elige una imagen PNG, JPG, WebP o SVG."
          : "Elige una imagen JPG, PNG o WebP.",
      )
      return
    }
    if (file.size > IMAGE_ADJUST_MAX_INPUT_BYTES) {
      setError("La imagen pesa más de 20 MB. Elige otra o una más chica.")
      return
    }
    setBusy(true)
    try {
      const url = own(URL.createObjectURL(file))
      // Un SVG pasa a imagen antes de recortarlo (ver `rasterize`).
      const next = file.type === "image/svg+xml" ? own(await rasterize(url, { vector: true })) : url
      await loadImage(next)
      setSource(next)
      onChangeRef.current(null)
    } catch {
      setError("No se pudo abrir la imagen. Prueba con otra.")
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const rotate = async () => {
    if (!source) return
    setBusy(true)
    try {
      setSource(own(await rasterize(source, { rotateQuarter: true })))
      onChangeRef.current(null)
    } catch {
      setError("No se pudo girar la imagen.")
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setSource(null)
    setError(null)
    onChangeRef.current(null)
  }

  const locked = disabled || busy
  return (
    <div id={fieldId} className="flex flex-col gap-4">
      <input
        ref={fileInput}
        id={`${id}-file`}
        type="file"
        accept={types.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        disabled={locked}
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      {cameraOpen ? (
        <CameraCapture
          disabled={locked}
          onCancel={() => setCameraOpen(false)}
          onCapture={(url) => {
            setCameraOpen(false)
            setSource(own(url))
            onChangeRef.current(null)
          }}
          onError={(message) => {
            setCameraOpen(false)
            setError(message)
          }}
        />
      ) : source ? (
        <>
          {shape === "person" ? (
            <PersonCrop
              key={source}
              source={source}
              name={name}
              disabled={locked}
              onChange={onChange}
            />
          ) : (
            <LogoCrop
              key={source}
              source={source}
              name={name}
              disabled={locked}
              onChange={onChange}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => void rotate()}
            >
              <RotateCw aria-hidden />
              Girar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              disabled={locked}
              onClick={reset}
            >
              Volver a elegir
            </Button>
          </div>
        </>
      ) : (
        <section
          aria-labelledby={`${id}-drop`}
          onDragOver={(event) => {
            if (locked) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            if (!locked) void choose(event.dataTransfer.files[0])
          }}
          className={cn(
            "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors",
            dragging ? "border-primary bg-primary-soft" : invalid ? "border-destructive" : "border-border bg-muted/40",
          )}
        >
          <ImageUp aria-hidden className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <p id={`${id}-drop`} className="text-sm font-medium">
              {shape === "logo" ? "Arrastra el logo aquí" : "Arrastra una foto aquí"}
            </p>
            <p className="text-xs text-muted-foreground">
              {shape === "logo" ? "PNG, JPG, WebP o SVG." : "JPG, PNG o WebP."} Después la
              encuadras.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="secondary"
              aria-invalid={invalid || undefined}
              aria-describedby={[describedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined}
              disabled={locked}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "Abriendo…" : "Elegir archivo"}
            </Button>
            {shape === "person" ? (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => setCameraOpen(true)}
              >
                <Camera aria-hidden />
                Tomar la foto
              </Button>
            ) : null}
          </div>
        </section>
      )}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Miniatura del recorte para «Así se verá», pequeña para no pesar mientras se arrastra. */
function usePreview(source: string, area: Area | null): string | null {
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!area) return
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      void (async () => {
        const image = await loadImage(source).catch(() => null)
        if (!image || cancelled) return
        const scale = Math.min(1, 160 / Math.max(area.width, area.height))
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(area.width * scale))
        canvas.height = Math.max(1, Math.round(area.height * scale))
        canvas
          .getContext("2d")
          ?.drawImage(
            image,
            area.x,
            area.y,
            area.width,
            area.height,
            0,
            0,
            canvas.width,
            canvas.height,
          )
        if (!cancelled) setPreview(canvas.toDataURL("image/png"))
      })()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [source, area])
  return preview
}

function PersonCrop({
  source,
  name,
  disabled,
  onChange,
}: {
  source: string
  name: string
  disabled: boolean
  onChange: (value: ImageAdjustValue | null) => void
}) {
  const id = useId()
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(ZOOM_MIN)
  const [area, setArea] = useState<Area | null>(null)
  const preview = usePreview(source, area)
  const complete = useCallback(
    (_percent: Area, pixels: Area) => {
      setArea(pixels)
      onChange({ shape: "person", source, area: pixels })
    },
    [onChange, source],
  )
  const clampZoom = (value: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
  return (
    <div className="flex flex-col gap-3">
      <fieldset
        aria-label="Encuadre de la foto"
        className="relative h-72 overflow-hidden rounded-2xl bg-muted sm:h-80"
        // + y − acercan y alejan con el foco en el encuadre; las flechas las mueve el recorte.
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === "+" || event.key === "=") {
            event.preventDefault()
            setZoom((value) => clampZoom(value + ZOOM_STEP))
          } else if (event.key === "-" || event.key === "_") {
            event.preventDefault()
            setZoom((value) => clampZoom(value - ZOOM_STEP))
          }
        }}
      >
        <Cropper
          image={source}
          crop={crop}
          zoom={zoom}
          minZoom={ZOOM_MIN}
          maxZoom={ZOOM_MAX}
          aspect={1}
          cropShape="round"
          showGrid={false}
          onCropChange={disabled ? () => {} : setCrop}
          onZoomChange={disabled ? () => {} : setZoom}
          onCropComplete={complete}
          keyboardStep={8}
          cropperProps={{ "aria-label": `Encuadre de la foto de ${name}` }}
        />
      </fieldset>
      <p className="text-sm text-muted-foreground">
        Arrastra para acomodarla; también con las flechas del teclado.
      </p>
      <Field>
        <FieldLabel htmlFor={`${id}-zoom`}>Zoom (también con + y −)</FieldLabel>
        <Slider
          id={`${id}-zoom`}
          aria-label="Zoom de la foto"
          value={[zoom]}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP / 2}
          disabled={disabled}
          onValueChange={(value) =>
            setZoom(clampZoom(Array.isArray(value) ? (value[0] ?? ZOOM_MIN) : value))
          }
        />
      </Field>
      <PreviewRow>
        {[
          ["size-9", "text-xs"],
          ["size-16", "text-lg"],
        ].map(([size, text]) => (
          <span
            key={size}
            className={cn(
              "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-soft font-semibold text-primary-soft-foreground",
              size,
              text,
            )}
          >
            {preview ? (
              <img src={preview} alt="" className="size-full object-cover" />
            ) : (
              personInitials(name)
            )}
          </span>
        ))}
      </PreviewRow>
    </div>
  )
}

function LogoCrop({
  source,
  name,
  disabled,
  onChange,
}: {
  source: string
  name: string
  disabled: boolean
  onChange: (value: ImageAdjustValue | null) => void
}) {
  // Empieza con el logo entero: sin tocarlo, se guarda tal cual (decisión 8).
  const [crop, setCrop] = useState<PercentCrop>({ unit: "%", x: 0, y: 0, width: 100, height: 100 })
  const [area, setArea] = useState<Area | null>(null)
  const natural = useRef<{ width: number; height: number } | null>(null)
  const preview = usePreview(source, area)
  const report = (percent: PercentCrop) => {
    const size = natural.current
    if (!size || percent.width <= 0 || percent.height <= 0) return
    const pixels: Area = {
      x: Math.round((percent.x / 100) * size.width),
      y: Math.round((percent.y / 100) * size.height),
      width: Math.max(1, Math.round((percent.width / 100) * size.width)),
      height: Math.max(1, Math.round((percent.height / 100) * size.height)),
    }
    setArea(pixels)
    onChange({ shape: "logo", source, area: pixels })
  }
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("flex justify-center overflow-hidden rounded-2xl p-3", CHECKERBOARD)}>
        <ReactCrop
          crop={crop}
          disabled={disabled}
          keepSelection
          minWidth={16}
          minHeight={16}
          onChange={(_pixels, percent) => setCrop(percent)}
          onComplete={(_pixels, percent) => report(percent)}
          ariaLabels={{
            cropArea: `Recorte del logo de ${name}`,
            nwDragHandle: "Esquina de arriba a la izquierda",
            nDragHandle: "Borde de arriba",
            neDragHandle: "Esquina de arriba a la derecha",
            eDragHandle: "Borde derecho",
            seDragHandle: "Esquina de abajo a la derecha",
            sDragHandle: "Borde de abajo",
            swDragHandle: "Esquina de abajo a la izquierda",
            wDragHandle: "Borde izquierdo",
          }}
        >
          <img
            src={source}
            alt={`Logo de ${name}`}
            className="max-h-72 w-auto sm:max-h-80"
            onLoad={(event) => {
              const image = event.currentTarget
              natural.current = { width: image.naturalWidth, height: image.naturalHeight }
              report(crop)
            }}
          />
        </ReactCrop>
      </div>
      <p className="text-sm text-muted-foreground">
        Arrastra el recuadro o sus esquinas para dejar solo el logo; también con las flechas del
        teclado.
      </p>
      <PreviewRow>
        <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white p-1">
          {preview ? <img src={preview} alt="" className="size-full object-contain" /> : null}
        </span>
        <span className="flex h-10 w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white px-2">
          {preview ? (
            <img src={preview} alt="" className="max-h-8 max-w-full object-contain" />
          ) : null}
        </span>
      </PreviewRow>
    </div>
  )
}

function PreviewRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted-foreground">Así se verá:</span>
      {children}
    </div>
  )
}

/** La cámara del equipo, solo cuando se pide: se apaga al tomar la foto o al salir. */
function CameraCapture({
  disabled,
  onCapture,
  onCancel,
  onError,
}: {
  disabled: boolean
  onCapture: (url: string) => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    let cancelled = false
    let opened: MediaStream | null = null
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin cámara")
        opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        })
        if (cancelled)
          opened.getTracks().forEach((track) => {
            track.stop()
          })
        else setStream(opened)
      } catch {
        if (!cancelled)
          onErrorRef.current(
            "No se pudo abrir la cámara. Revisa el permiso del navegador o elige un archivo.",
          )
      }
    })()
    return () => {
      cancelled = true
      opened?.getTracks().forEach((track) => {
        track.stop()
      })
    }
  }, [])
  useEffect(() => {
    if (stream && video.current) video.current.srcObject = stream
  }, [stream])

  const capture = async () => {
    const element = video.current
    if (!element?.videoWidth || !element.videoHeight) return
    const canvas = document.createElement("canvas")
    canvas.width = element.videoWidth
    canvas.height = element.videoHeight
    canvas.getContext("2d")?.drawImage(element, 0, 0)
    const blob = await canvasBlob(canvas, "image/jpeg", 0.95)
    if (!blob) return onErrorRef.current("No se pudo tomar la foto.")
    onCapture(URL.createObjectURL(blob))
  }

  return (
    <div className="flex flex-col gap-3">
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        onLoadedData={() => setReady(true)}
        className="max-h-80 w-full rounded-2xl bg-black"
        aria-label="Vista de la cámara"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || !ready} onClick={() => void capture()}>
          <Camera aria-hidden />
          {ready ? "Tomar la foto" : "Abriendo la cámara…"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Volver
        </Button>
      </div>
    </div>
  )
}
