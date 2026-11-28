import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { DetailDrawer, ErrorState } from "@odentia/ui-patterns"
import { Monitor, Smartphone } from "lucide-react"
import { useEffect, useState } from "react"
import { type Choice, firstChoice } from "../lib/vitrina"
import { ChatSample } from "../vitrina/chat"
import { BrowserFrame, PhoneFrame } from "../vitrina/marcos"
import { ProductPhone, ProductWeb } from "../vitrina/producto"
import { useFichaContext } from "./contexto"
import { useShowcase } from "./probar"

/**
 * Vista previa (prototipo aprobado, `ficha/vista-previa.tsx`): el producto como lo ve la clienta,
 * en el celular (la vitrina por link y cómo lo manda Sofi en WhatsApp) y en la web de la tienda,
 * con «Tu marca». Es la misma página que da el servidor a la vitrina (`apps/api/src/vitrina.ts`),
 * con la ficha de ahora: solo lo vendible.
 */
export function PreviewDrawer({ onClose }: { onClose: () => void }) {
  const { store, sheet } = useFichaContext()
  const [mode, setMode] = useState<"celular" | "web">("celular")
  const showcase = useShowcase(store.id, sheet.id)
  const page = showcase.data ?? null
  const [choice, setChoice] = useState<Choice | null>(null)
  useEffect(() => {
    if (page && !choice) setChoice(firstChoice(page))
  }, [page, choice])
  const url = page?.store.link
    ? `${page.store.link}.gestoria24.com/${page.product.slug ?? sheet.id}`
    : "Tu link todavía no tiene nombre"
  return (
    <DetailDrawer
      open
      onClose={onClose}
      dock={false}
      title="Vista previa"
      description={`${url} · con la ficha de ahora${page && !page.product.visible ? " · todavía no se muestra en tu catálogo" : ""}`}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(76rem,calc(100vw-2rem))]"
      headerContent={
        <ToggleGroup
          value={[mode]}
          onValueChange={(value) => value[0] && setMode(value[0] as "celular" | "web")}
          className="w-fit rounded-full bg-muted p-1"
          aria-label="Dónde verlo"
        >
          <ToggleGroupItem
            value="celular"
            className="h-8 rounded-full px-4 text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs"
          >
            <Smartphone className="size-3.5" aria-hidden />
            Celular
          </ToggleGroupItem>
          <ToggleGroupItem
            value="web"
            className="h-8 rounded-full px-4 text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs"
          >
            <Monitor className="size-3.5" aria-hidden />
            Web
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      {showcase.isError ? (
        <ErrorState error={showcase.error} onRetry={() => void showcase.refetch()} />
      ) : !page || !choice ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Armando la vista previa…</p>
      ) : mode === "celular" ? (
        <div className="grid h-[min(840px,calc(100dvh-12rem))] gap-6 py-2 md:grid-cols-2">
          <figure className="flex min-h-0 flex-col items-center gap-2">
            <figcaption className="text-sm font-medium text-muted-foreground">
              En la vitrina, por link
            </figcaption>
            <PhoneFrame height={800}>
              <ProductPhone page={page} choice={choice} onChoose={setChoice} />
            </PhoneFrame>
          </figure>
          <figure className="hidden min-h-0 flex-col items-center gap-2 md:flex">
            <figcaption className="text-sm font-medium text-muted-foreground">
              En WhatsApp, cuando la piden
            </figcaption>
            <PhoneFrame height={800}>
              <ChatSample page={page} />
            </PhoneFrame>
          </figure>
        </div>
      ) : (
        <div className="py-2">
          <BrowserFrame url={url}>
            <ProductWeb page={page} choice={choice} onChoose={setChoice} />
          </BrowserFrame>
        </div>
      )}
    </DetailDrawer>
  )
}
