import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  toast,
  useIsMobile,
} from "@odentia/ui"
import {
  AiQuestion,
  AiSuggestionBar,
  AiSuggestionMark,
  aiSuggestedClass,
  FormDrawer,
  PageNotice,
} from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Camera, ImagePlus, Sparkles, X } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { readSizes } from "./cargar"
import { CATALOG_KEY, CategoryOptions } from "./catalogo"
import { Swatch } from "./ficha/piezas"
import { ApiError, api } from "./lib/api"
import type { RubroTemplate } from "./lib/ficha"
import {
  applyProposal,
  type Cap,
  type ColorValue,
  discardProposal,
  keyOf,
  type LoadProposals,
  type Proposal,
  useCap,
} from "./lib/ia"
import { isImageFile, MAX_PHOTOS, preparePhoto } from "./lib/medios"
import { currencySymbol, money, readMoney } from "./lib/tienda"
import { useStoreContext } from "./tiendas"

/**
 * «Agregar desde fotos» (prototipo `agregar.tsx` y `camara.tsx`; lienzo «La ficha del producto»,
 * decisiones 3, 7 y 10): se eligen o se toman fotos, la IA las mira y propone el nombre, la
 * categoría, los colores, la descripción y pregunta lo que no ve. Lo punteado es de la IA hasta
 * que se usa (✦); el precio lo pone la persona y la IA nunca lo propone. Si la IA no está o llegó
 * a su tope, lo dice y se sigue a mano.
 *
 * Por dentro es una carga de un solo producto (`cargas.ts`): las fotos van al almacenamiento, la
 * IA propone sobre ese producto y «Guardar» lo crea con «Crear». Lo que no se usó pasa a la ficha
 * como propuesta (✦), y lo que se respondió de las preguntas se guarda en la ficha.
 */

type Step = "elegir" | "mirando" | "propuesta"
type Decision = "usar" | "descartar"

interface Picked {
  file: File
  url: string
}

const TEXT_FIELDS = ["nombre", "categoria", "descripcion"] as const
type TextField = (typeof TEXT_FIELDS)[number]

function PhotoStrip({ photos, onRemove }: { photos: Picked[]; onRemove?: (i: number) => void }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Las fotos">
      {photos.map((p, i) => (
        <li key={p.url} className="relative">
          <img
            src={p.url}
            alt={`Foto ${i + 1}`}
            className="size-16 rounded-xl border object-cover"
          />
          {onRemove ? (
            <button
              type="button"
              aria-label={`Quitar la foto ${i + 1}`}
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full border bg-card shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** Lo que va a decir la ficha y cómo se vería: en la vitrina por link y en WhatsApp. */
function PreviewDialog({
  onClose,
  photo,
  name,
  priceCents,
  colors,
  description,
}: {
  onClose: () => void
  photo: string | null
  name: string
  priceCents: number | null
  colors: ColorValue[]
  description: string
}) {
  const { store } = useStoreContext()
  const price = priceCents ? money(priceCents, store.currency) : "Sin precio todavía"
  const frame =
    "mx-auto flex w-full max-w-72 flex-col overflow-hidden rounded-[2rem] border-[6px] border-foreground/85 bg-card shadow-lg"
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Así quedaría en tu vitrina</DialogTitle>
          <DialogDescription>
            Con lo que tiene la ficha ahora, también lo propuesto. Nada se guardó todavía.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <figure className="flex flex-col gap-2">
            <figcaption className="text-center text-sm text-muted-foreground">
              En la vitrina, por link
            </figcaption>
            <div className={frame}>
              <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold">
                {store.name}
              </div>
              {photo ? (
                <img src={photo} alt="" className="aspect-square w-full object-cover" />
              ) : (
                <div className="aspect-square w-full bg-muted" />
              )}
              <div className="flex flex-col gap-1.5 p-3">
                <span className="text-lg leading-tight font-bold">{name || "Sin nombre"}</span>
                <span className="font-semibold tabular-nums">{price}</span>
                {colors.length ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {colors.map((c) => (
                      <Swatch key={c.name} hex={c.hex} hex2={c.hex2} className="size-4" />
                    ))}
                    {colors.map((c) => c.name).join(", ")}
                  </span>
                ) : null}
                {description ? (
                  <p className="line-clamp-4 text-xs text-muted-foreground">{description}</p>
                ) : null}
              </div>
            </div>
          </figure>
          <figure className="flex flex-col gap-2">
            <figcaption className="text-center text-sm text-muted-foreground">
              En WhatsApp, cuando la piden
            </figcaption>
            <div className={cn(frame, "bg-[#efeae2] p-3 dark:bg-[#0b141a]")}>
              <div className="flex flex-col gap-2 self-start rounded-xl bg-card p-2 text-xs shadow-xs">
                <span className="font-semibold text-primary">Sofi</span>
                {photo ? (
                  <img src={photo} alt="" className="aspect-square w-48 rounded-lg object-cover" />
                ) : null}
                <span>
                  {name || "Este producto"}: {price}.
                </span>
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Es una muestra: no se envía nada.
              </p>
            </div>
          </figure>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AddFromPhotos({
  onClose,
  initial = [],
  templates,
}: {
  onClose: () => void
  /** Las fotos que ya se tomaron con la cámara (en el celular, la cámara va primero). */
  initial?: File[]
  templates: RubroTemplate[]
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const cap = useCap(store.id)
  const apply = (id: string, value?: unknown) => applyProposal(store.id, id, value)
  const [step, setStep] = useState<Step>("elegir")
  const [photos, setPhotos] = useState<Picked[]>([])
  const [error, setError] = useState<string | null>(null)
  const [aiOff, setAiOff] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<{ loadId: string; itemId: string } | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [text, setText] = useState<Record<TextField, string>>({
    nombre: "",
    categoria: "",
    descripcion: "",
  })
  const [decided, setDecided] = useState<Record<string, Decision>>({})
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [sizes, setSizes] = useState("")
  const [price, setPrice] = useState("")
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const saved = useRef(false)
  const gallery = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const ids = {
    name: useId(),
    category: useId(),
    description: useId(),
    price: useId(),
    sizes: useId(),
    list: useId(),
  }

  const add = (files: FileList | File[]) => {
    const images = [...files].filter(isImageFile)
    if (!images.length) return
    setError(null)
    setPhotos((now) => {
      const room = MAX_PHOTOS - now.length
      if (images.length > room)
        toast(`Hasta ${MAX_PHOTOS} fotos por producto: tomé las primeras ${room}.`)
      return [
        ...now,
        ...images
          .slice(0, Math.max(0, room))
          .map((file) => ({ file, url: URL.createObjectURL(file) })),
      ]
    })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo las fotos con que se abrió
  useEffect(() => {
    if (initial.length) add(initial)
  }, [])
  // Pegar una foto (Ctrl+V) mientras se eligen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `add` solo usa los setters del estado
  useEffect(() => {
    if (step !== "elegir") return
    const paste = (e: ClipboardEvent) => {
      if (e.clipboardData?.files.length) add(e.clipboardData.files)
    }
    window.addEventListener("paste", paste)
    return () => window.removeEventListener("paste", paste)
  }, [step])
  useEffect(
    () => () => {
      for (const p of photos) URL.revokeObjectURL(p.url)
    },
    [photos],
  )

  const of = (field: string) => proposals.find((p) => p.field === field)
  const colors = proposals.filter((p) => p.kind === "color")
  const questions = proposals.filter((p) => p.kind === "pregunta")
  const waiting = proposals.filter((p) => p.waitsForProduct && p.kind !== "pregunta")
  const undecided = [...TEXT_FIELDS.map((f) => of(f)), ...colors].filter(
    (p): p is Proposal => !!p && !decided[p.id],
  )
  const rubroOf = (id: string) => templates.find((t) => t.id === id)
  const proposedRubro = of("rubro")?.value as string | undefined
  const template = proposedRubro ? rubroOf(proposedRubro) : undefined

  /** Las fotos van a una carga de un producto; la IA mira ese producto. */
  async function look() {
    if (!photos.length) {
      setError("Elige o toma al menos una foto.")
      return
    }
    setError(null)
    setStep("mirando")
    try {
      const { load } = await api<{ load: { id: string } }>(`/api/tiendas/${store.id}/cargas`, {
        method: "POST",
      })
      let itemId = ""
      for (const [i, photo] of photos.entries()) {
        const blob = await preparePhoto(photo.file)
        const sent = await api<{ photo: { itemId: string } }>(
          `/api/tiendas/${store.id}/cargas/${load.id}/fotos?archivo=${encodeURIComponent(photo.file.name.slice(0, 200))}&producto=${i === 0 ? "nuevo" : itemId}`,
          { method: "POST", raw: { type: blob.type || "image/jpeg", data: blob } },
        )
        itemId = sent.photo.itemId
      }
      setTarget({ loadId: load.id, itemId })
      try {
        const data = await api<LoadProposals>(
          `/api/tiendas/${store.id}/cargas/${load.id}/productos/${itemId}/ia`,
          { method: "POST" },
        )
        const mine = data.proposals.filter((p) => p.itemId === itemId)
        setProposals(mine)
        setNotice(data.look?.notice ?? null)
        setText({
          nombre: stringOf(mine.find((p) => p.field === "nombre")),
          categoria: stringOf(mine.find((p) => p.field === "categoria")),
          descripcion: stringOf(mine.find((p) => p.field === "descripcion")),
        })
      } catch (problem) {
        // La IA apagada, en su tope o sin responder: se sigue a mano, nada se frena.
        setAiOff(
          problem instanceof ApiError
            ? problem.message
            : "La IA no respondió. Sigue a mano: tus fotos ya están.",
        )
      }
      void queryClient.invalidateQueries({ queryKey: ["ia-tope", store.id] })
      setStep("propuesta")
    } catch (problem) {
      setStep("elegir")
      setError(problem instanceof Error ? problem.message : "No se pudieron subir las fotos")
    }
  }

  const decide = (p: Proposal, d: Decision) => setDecided((now) => ({ ...now, [p.id]: d }))
  const acceptAll = () =>
    setDecided((now) =>
      Object.fromEntries([...Object.entries(now), ...undecided.map((p) => [p.id, "usar"])]),
    )

  async function save() {
    if (!target) return
    const name = text.nombre.trim()
    const nameProposal = of("nombre")
    if (!name) return setError("Escribe el nombre o usa el que propone la IA.")
    if (nameProposal && !decided[nameProposal.id] && name === stringOf(nameProposal))
      return setError("Usa el nombre que propone la IA (✦ Usar) o escribe otro.")
    const cents = readMoney(price, store.currency)
    if (!cents) return setError("Pon el precio: lo pones tú, la IA nunca propone precios.")
    setError(null)
    setSaving(true)
    const base = `/api/tiendas/${store.id}/cargas/${target.loadId}/productos/${target.itemId}`
    try {
      // Lo decidido del producto de la carga, por su operación: usar, cambiar o descartar.
      const patch: Record<string, unknown> = { listPriceCents: cents }
      for (const field of TEXT_FIELDS) {
        const p = of(field)
        const value = text[field].trim()
        const key = { nombre: "name", categoria: "category", descripcion: "description" }[field]
        if (!p) {
          if (value) patch[key] = value
          continue
        }
        const choice = decided[p.id]
        if (choice === "descartar") {
          await discardProposal(store.id, p.id)
          if (value && value !== stringOf(p)) patch[key] = value
        } else if (choice === "usar" || value !== stringOf(p))
          await apply(p.id, value === stringOf(p) ? undefined : value)
        // Sin decidir: queda propuesto y pasa a la ficha (✦).
      }
      for (const p of colors) {
        if (decided[p.id] === "usar") await apply(p.id)
        else if (decided[p.id] === "descartar") await discardProposal(store.id, p.id)
      }
      if (sizes.trim()) patch.sizes = readSizes(sizes)
      await api(base, { method: "PATCH", body: patch })
      const created = await api<{ productIds: string[]; errors: { message: string }[] }>(
        `/api/tiendas/${store.id}/cargas/${target.loadId}/crear`,
        { method: "POST" },
      )
      saved.current = true
      const productId = created.productIds[0]!
      // Lo que respondió de lo que la IA no ve: a la ficha, con el rubro que propuso.
      for (const q of questions)
        if (answers[q.id]) await apply(q.id, answers[q.id]).catch(() => undefined)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Producto agregado. Lo punteado que no usaste sigue en la ficha (✦).")
      onClose()
      await navigate({
        to: "/tiendas/$id/catalogo/$productId",
        params: { id: store.id, productId },
      })
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "No se pudo guardar")
    } finally {
      setSaving(false)
    }
  }

  // Cerrar sin guardar (o irse a otra pantalla) descarta la carga: sus fotos se borran y no
  // aparece en «Cargar muchos».
  const pendingLoad = useRef<string | null>(null)
  pendingLoad.current = target && !saved.current ? target.loadId : null
  useEffect(
    () => () => {
      if (pendingLoad.current)
        void api(`/api/tiendas/${store.id}/cargas/${pendingLoad.current}`, {
          method: "DELETE",
        }).catch(() => undefined)
    },
    [store.id],
  )
  const close = () => onClose()

  const capNote = cap.data && !cap.data.available ? cap.data.message : null
  const firstColor = colors.map((p) => p.value as ColorValue)
  const previewColors = useMemo(
    () => colors.filter((p) => decided[p.id] !== "descartar").map((p) => p.value as ColorValue),
    [colors, decided],
  )

  return (
    <FormDrawer
      open
      onClose={close}
      title="Agregar desde fotos"
      description={
        step === "propuesta" && !aiOff
          ? "Lo punteado lo propone la IA. Nada se guarda hasta que lo guardes."
          : "Empieza por las fotos: la IA propone el resto."
      }
      isDirty={photos.length > 0}
      unsavedDescription="Las fotos que subiste se borran."
      submitLabel={
        step === "propuesta"
          ? "Guardar y abrir la ficha"
          : photos.length
            ? `Mirar ${photos.length} ${photos.length === 1 ? "foto" : "fotos"}`
            : "Mirar las fotos"
      }
      isSubmitting={step === "mirando" || saving}
      error={error}
      secondaryAction={
        step === "propuesta"
          ? { label: "Ver cómo queda", onClick: () => setPreview(true) }
          : undefined
      }
      onSubmit={(e) => {
        e.preventDefault()
        if (step === "elegir") void look()
        else if (step === "propuesta") void save()
      }}
    >
      {step === "elegir" ? (
        <div className="flex flex-col gap-5">
          {capNote ? (
            <PageNotice tone="aviso" label="La IA no mira ahora">
              {capNote}
            </PageNotice>
          ) : null}
          {isMobile ? (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" onClick={() => camera.current?.click()}>
                <Camera aria-hidden />
                Tomar fotos
              </Button>
              <Button type="button" variant="outline" onClick={() => gallery.current?.click()}>
                <ImagePlus aria-hidden />
                De la galería
              </Button>
            </div>
          ) : (
            <label
              className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-input-border p-4 text-center text-sm transition-colors hover:border-primary/50 hover:bg-primary-soft/30 focus-within:ring-3 focus-within:ring-ring/40"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                add(e.dataTransfer.files)
              }}
            >
              <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
              <span className="font-medium">Suelta o elige tus fotos</span>
              <span className="text-muted-foreground">
                De distintos lados, hasta {MAX_PHOTOS}. También con Ctrl+V.
              </span>
              <input
                ref={gallery}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) add(e.target.files)
                  e.target.value = ""
                }}
              />
            </label>
          )}
          {isMobile ? (
            <>
              <input
                ref={camera}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                aria-label="Tomar una foto"
                onChange={(e) => {
                  if (e.target.files) add(e.target.files)
                  e.target.value = ""
                }}
              />
              <input
                ref={gallery}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                aria-label="Elegir fotos de la galería"
                onChange={(e) => {
                  if (e.target.files) add(e.target.files)
                  e.target.value = ""
                }}
              />
            </>
          ) : null}
          {photos.length ? (
            <PhotoStrip
              photos={photos}
              onRemove={(i) => setPhotos((now) => now.filter((_, j) => j !== i))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              De frente, de lado, el detalle y puesto. La IA propone el nombre, los colores y lo que
              se ve; lo que no se ve, lo pregunta. El precio lo pones tú.
            </p>
          )}
        </div>
      ) : step === "mirando" ? (
        <div
          className="flex flex-col gap-5"
          role="status"
          aria-label="La IA está mirando las fotos"
        >
          <PhotoStrip photos={photos} />
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="size-4 motion-safe:animate-pulse" aria-hidden />
            Mirando las fotos…
          </span>
          {["Nombre", "Categoría", "Color", "Descripción"].map((label, i) => (
            <div key={label} className="flex flex-col gap-2">
              <span className="text-sm font-medium">{label}</span>
              <span
                className="h-9 animate-pulse rounded-3xl bg-muted motion-reduce:animate-none"
                style={{ width: `${[85, 50, 65, 100][i]}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <PhotoStrip photos={photos} />
          {aiOff ? (
            <PageNotice tone="aviso" label="Sigue a mano">
              {aiOff}
            </PageNotice>
          ) : null}
          {notice ? (
            <PageNotice tone="aviso" label="Ojo con las fotos">
              {notice}
            </PageNotice>
          ) : null}
          <AiSuggestionBar count={undecided.length} onAcceptAll={acceptAll}>
            La IA propone {undecided.length} {undecided.length === 1 ? "cosa" : "cosas"}
            {questions.length ? " y pregunta lo que no ve" : ""}.
          </AiSuggestionBar>

          <TextRow
            id={ids.name}
            label="Nombre"
            proposal={of("nombre")}
            decision={decided[of("nombre")?.id ?? ""]}
            value={text.nombre}
            onChange={(v) => setText((t) => ({ ...t, nombre: v }))}
            onDecide={decide}
            maxLength={120}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextRow
              id={ids.category}
              label="Categoría"
              list={ids.list}
              proposal={of("categoria")}
              decision={decided[of("categoria")?.id ?? ""]}
              value={text.categoria}
              onChange={(v) => setText((t) => ({ ...t, categoria: v }))}
              onDecide={decide}
              maxLength={60}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.sizes} className="text-sm font-medium">
                {template?.columnLabel ? `${template.columnLabel}s` : "Tallas"}
              </label>
              <Input
                id={ids.sizes}
                value={sizes}
                placeholder="35 a 42, o S, M, L"
                onChange={(e) => setSizes(e.target.value)}
              />
            </div>
          </div>
          <CategoryOptions id={ids.list} storeId={store.id} />

          {colors.length ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {template?.rowLabel ?? "Color"}
                {colors.length > 1 ? "es" : ""}, sacados de las fotos
              </span>
              <ul className="flex flex-wrap gap-2">
                {colors.map((p) => {
                  const color = p.value as ColorValue
                  const choice = decided[p.id]
                  if (choice === "descartar") return null
                  return (
                    <li
                      key={p.id}
                      className={cn(
                        "inline-flex h-9 items-center gap-2 rounded-full border bg-card pr-1.5 pl-2 text-sm font-medium",
                        !choice && aiSuggestedClass,
                      )}
                    >
                      <Swatch hex={color.hex} hex2={color.hex2} className="size-5" />
                      {color.name}
                      <span className="text-xs text-muted-foreground">
                        {color.photos.length} {color.photos.length === 1 ? "foto" : "fotos"}
                      </span>
                      {choice ? null : (
                        <AiSuggestionMark
                          reason={p.reason}
                          label={`el color ${color.name}`}
                          onAccept={() => decide(p, "usar")}
                          onDiscard={() => decide(p, "descartar")}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {questions.map((q) => {
            const field = template?.fields.find((f) => f.key === keyOf(q.field))
            const answer = answers[q.id]
            return field?.type === "opcion" && field.options?.length ? (
              <AiQuestion
                key={q.id}
                question={answer ? `${field.label}: ${answer}` : q.reason}
                reason={
                  answer ? "Se guarda en la ficha." : "Lo respondes ahora o después, en la ficha."
                }
                options={field.options.map((o) => ({ value: o, label: o }))}
                onAnswer={(value) => setAnswers((a) => ({ ...a, [q.id]: value }))}
              />
            ) : (
              <AiQuestion key={q.id} question={q.reason} reason="Lo respondes en la ficha." />
            )
          })}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.price} className="text-sm font-medium">
              Precio
            </label>
            <div className="relative w-44">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
              >
                {currencySymbol(store.currency)}
              </span>
              <Input
                id={ids.price}
                inputMode="decimal"
                value={price}
                className="pl-9"
                aria-describedby={`${ids.price}-d`}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <span id={`${ids.price}-d`} className="text-xs text-muted-foreground">
              Lo pones tú. La IA nunca propone precios.
            </span>
          </div>

          <TextRow
            id={ids.description}
            label="Descripción para vender"
            proposal={of("descripcion")}
            decision={decided[of("descripcion")?.id ?? ""]}
            value={text.descripcion}
            onChange={(v) => setText((t) => ({ ...t, descripcion: v }))}
            onDecide={decide}
            maxLength={2000}
            long
          />

          {waiting.length ? (
            <p className="flex items-start gap-2 rounded-xl bg-agent-soft px-3 py-2 text-sm">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Además propone{" "}
                {waiting
                  .map((p) =>
                    p.kind === "rubro"
                      ? `el rubro ${rubroOf(String(p.value))?.label ?? p.value}`
                      : p.kind === "palabras"
                        ? "las palabras con que la buscan"
                        : p.kind === "dato"
                          ? `${template?.fields.find((f) => f.key === keyOf(p.field))?.label.toLowerCase() ?? "un dato"}: ${String(p.value)}`
                          : null,
                  )
                  .filter(Boolean)
                  .join(", ")}
                . Lo ves en la ficha (✦) para usarlo o no.
              </span>
            </p>
          ) : null}
        </div>
      )}
      {preview ? (
        <PreviewDialog
          onClose={() => setPreview(false)}
          photo={photos[0]?.url ?? null}
          name={text.nombre}
          priceCents={readMoney(price, store.currency)}
          colors={previewColors.length ? previewColors : firstColor}
          description={text.descripcion}
        />
      ) : null}
    </FormDrawer>
  )
}

const stringOf = (p: Proposal | undefined) => (typeof p?.value === "string" ? p.value : "")

/** Un campo de texto con lo que propone la IA: punteado hasta que se usa, se cambia o se descarta. */
function TextRow({
  id,
  label,
  proposal,
  decision,
  value,
  onChange,
  onDecide,
  maxLength,
  long = false,
  list,
}: {
  id: string
  label: string
  proposal: Proposal | undefined
  decision: Decision | undefined
  value: string
  onChange: (value: string) => void
  onDecide: (p: Proposal, d: Decision) => void
  maxLength: number
  long?: boolean
  list?: string
}) {
  const proposed = !!proposal && !decision && value === stringOf(proposal) && !!value
  const Field = long ? Textarea : Input
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-6 items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {proposed && proposal ? (
          <AiSuggestionMark
            reason={proposal.reason}
            label={label.toLowerCase()}
            fieldId={id}
            onAccept={() => onDecide(proposal, "usar")}
            onDiscard={() => {
              onDecide(proposal, "descartar")
              onChange("")
            }}
          />
        ) : null}
      </div>
      <Field
        id={id}
        value={value}
        maxLength={maxLength}
        list={list}
        {...(long ? { rows: 3 } : {})}
        className={cn(proposed && aiSuggestedClass)}
        onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
          onChange(e.target.value)
        }
      />
    </div>
  )
}

export type { Cap }
