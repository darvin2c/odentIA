import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { DetailDrawer } from "@odentia/ui-patterns"
import { Monitor, Smartphone } from "lucide-react"
import { useState } from "react"
import type { Dato, Producto, Rubro } from "../datos"
import { ChatMuestra } from "../vitrina/chat"
import { nueva } from "../vitrina/compra"
import { BrowserFrame, PhoneFrame } from "../vitrina/marcos"
import { TiendaCelular, TiendaWeb } from "../vitrina/tienda"

/**
 * Vista previa: el producto como lo ve la clienta, en el celular (la vitrina por link) y en la web
 * de la tienda (computadora), con «Tu marca». Sale de la ficha de ahora: se pinta de nuevo con cada
 * cambio.
 */
export function VistaPrevia({ p, R, tpl, all, open, onClose, title = "Vista previa" }: { p: Producto; R: Rubro; tpl: Dato[]; all: Producto[]; open: boolean; onClose: () => void; title?: string }) {
  const [modo, setModo] = useState<"celular" | "web">("celular")
  const [c, set] = useState(() => nueva(p))
  const x = { p, R, tpl, all: all.some((q) => q.id === p.id) ? all : [...all, p] }
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title={title}
      description={`${R.store.slug}.gestoria24.com/${p.web.slug || "nuevo"} · con la ficha de ahora`}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(76rem,calc(100vw-2rem))]"
      headerContent={
        <ToggleGroup value={[modo]} onValueChange={(v) => v[0] && setModo(v[0] as "celular" | "web")} className="w-fit rounded-full bg-muted p-1" aria-label="Dónde verlo">
          <ToggleGroupItem value="celular" className="h-8 rounded-full px-4 text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs">
            <Smartphone className="size-3.5" aria-hidden />
            Celular
          </ToggleGroupItem>
          <ToggleGroupItem value="web" className="h-8 rounded-full px-4 text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs">
            <Monitor className="size-3.5" aria-hidden />
            Web
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      {modo === "celular" ? (
        <div className="grid h-[min(840px,calc(100dvh-12rem))] gap-6 py-2 md:grid-cols-2">
          <figure className="flex min-h-0 flex-col items-center gap-2">
            <figcaption className="text-sm font-medium text-muted-foreground">En la vitrina, por link</figcaption>
            <PhoneFrame height={800}>
              <TiendaCelular x={x} c={c} set={set} />
            </PhoneFrame>
          </figure>
          <figure className="hidden min-h-0 flex-col items-center gap-2 md:flex">
            <figcaption className="text-sm font-medium text-muted-foreground">En WhatsApp, cuando la piden</figcaption>
            <PhoneFrame height={800}>
              <ChatMuestra x={x} />
            </PhoneFrame>
          </figure>
        </div>
      ) : (
        <div className="py-2">
          <BrowserFrame url={`${R.store.slug}.gestoria24.com/${p.web.slug || "nuevo"}`}>
            <TiendaWeb x={x} c={c} set={set} />
          </BrowserFrame>
        </div>
      )}
    </DetailDrawer>
  )
}
