import { cn, Dialog, DialogContent, DialogDescription, DialogTitle } from "@odentia/ui"
import { Maximize2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { foto } from "../datos"
import { money, type Pago, type Pedido } from "./modelo"

/**
 * Las imágenes de ejemplo del prototipo: la captura de un pago, el voucher del POS y las fotos de
 * una falla y de un recojo. Diseño neutro, sin el logo, los colores ni la forma de ninguna app de
 * pagos ni de ningún banco: solo el monto, el nombre, la hora y un número de operación inventados.
 * Todas dicen «Ejemplo». En la app serán la imagen real que mandó la clienta o tomó el repartidor.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"

/** Un número de operación inventado, siempre el mismo para el mismo pago. */
function operacion(semilla: string) {
  let h = 7
  for (const c of semilla) h = (h * 31 + c.charCodeAt(0)) % 99999999
  return String(h).padStart(8, "0")
}

function Sello({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width="84" height="26" rx="13" fill="#fff" stroke="#b91c1c" strokeWidth="2" />
      <text x={x + 42} y={y + 18} textAnchor="middle" fontFamily={SANS} fontSize="13" fontWeight="700" fill="#b91c1c">
        EJEMPLO
      </text>
    </g>
  )
}

/** La captura de un pago por Yape o Plin, como la manda la clienta por WhatsApp. */
export function CapturaPago({ p, g, tienda, className }: { p: Pedido; g: Pago; tienda: string; className?: string }) {
  const c = g.captura
  const monto = c?.monto ?? g.monto
  const filas: [string, string][] = [
    ["Para", tienda],
    ["Número", "9** *** 455"],
    ["De", c?.nombre ?? p.clienta],
    ["Fecha", `Jue 27 nov · ${c?.hora ?? "10:42 a. m."}`],
    ["N.º de operación", c?.numero?.replace(/\D/g, "") || operacion(`${p.id}${g.id}`)],
  ]
  return (
    <svg
      viewBox="0 0 300 520"
      role="img"
      aria-label={`Captura de ejemplo: ${money(monto)} de ${c?.nombre ?? p.clienta}, ${c?.hora ?? ""}`}
      className={cn("h-auto w-full", className)}
    >
      <rect x="1" y="1" width="298" height="518" rx="22" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="2" />
      <text x="22" y="38" fontFamily={SANS} fontSize="12" fill="#64748b">
        10:43
      </text>
      <rect x="250" y="29" width="28" height="11" rx="3" fill="none" stroke="#94a3b8" />
      <rect x="252" y="31" width="18" height="7" rx="1.5" fill="#94a3b8" />
      <text x="150" y="78" textAnchor="middle" fontFamily={SANS} fontSize="15" fill="#334155" fontWeight="600">
        Pago enviado
      </text>
      <circle cx="150" cy="128" r="30" fill="#e2e8f0" />
      <path d="M136 128 l10 10 l19 -20" fill="none" stroke="#334155" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="150" y="208" textAnchor="middle" fontFamily={SANS} fontSize="46" fontWeight="800" fill="#0f172a">
        {money(monto)}
      </text>
      <line x1="24" y1="236" x2="276" y2="236" stroke="#e2e8f0" strokeWidth="2" />
      {filas.map(([k, v], i) => (
        <g key={k}>
          <text x="24" y={268 + i * 42} fontFamily={SANS} fontSize="12" fill="#64748b">
            {k}
          </text>
          <text x="24" y={286 + i * 42} fontFamily={SANS} fontSize="15" fontWeight="600" fill="#0f172a">
            {v.length > 30 ? `${v.slice(0, 29)}…` : v}
          </text>
        </g>
      ))}
      <rect x="24" y="478" width="252" height="2" fill="#e2e8f0" />
      <text x="150" y="502" textAnchor="middle" fontFamily={SANS} fontSize="11" fill="#94a3b8">
        Imagen de ejemplo del prototipo
      </text>
      <Sello x={108} y={20} />
    </svg>
  )
}

/** El voucher del POS que el repartidor fotografía en la puerta. */
export function VoucherPos({ p, g, tienda, className }: { p: Pedido; g: Pago; tienda: string; className?: string }) {
  const filas: [string, string][] = [
    ["FECHA", "27/11/2025"],
    ["HORA", g.cuando.split("· ")[1] ?? "3:12 p. m."],
    ["TARJETA", "**** **** **** 4821"],
    ["OPERACION", operacion(`${p.id}${g.id}`).slice(0, 6)],
    ["AUTORIZACION", operacion(g.id).slice(2, 8)],
  ]
  const zig = "l-10 10 l-10 -10 ".repeat(15)
  return (
    <svg
      viewBox="0 0 300 470"
      role="img"
      aria-label={`Voucher de ejemplo: venta aprobada por ${money(g.monto)}`}
      className={cn("h-auto w-full", className)}
    >
      <path d={`M0 0 H300 V450 ${zig}Z`} fill="#fdfdfb" stroke="#d6d3d1" strokeWidth="2" />
      <text x="150" y="40" textAnchor="middle" fontFamily={MONO} fontSize="15" fontWeight="700" fill="#1c1917">
        {tienda.toUpperCase().slice(0, 24)}
      </text>
      <text x="150" y="62" textAnchor="middle" fontFamily={MONO} fontSize="12" fill="#57534e">
        COMPROBANTE DE VENTA
      </text>
      <line x1="20" y1="80" x2="280" y2="80" stroke="#a8a29e" strokeDasharray="4 4" />
      {filas.map(([k, v], i) => (
        <g key={k}>
          <text x="22" y={108 + i * 26} fontFamily={MONO} fontSize="13" fill="#57534e">
            {k}
          </text>
          <text x="278" y={108 + i * 26} textAnchor="end" fontFamily={MONO} fontSize="13" fill="#1c1917">
            {v}
          </text>
        </g>
      ))}
      <line x1="20" y1="244" x2="280" y2="244" stroke="#a8a29e" strokeDasharray="4 4" />
      <text x="22" y="282" fontFamily={MONO} fontSize="16" fill="#1c1917">
        VENTA
      </text>
      <text x="278" y="282" textAnchor="end" fontFamily={MONO} fontSize="22" fontWeight="700" fill="#1c1917">
        {money(g.monto)}
      </text>
      <text x="150" y="330" textAnchor="middle" fontFamily={MONO} fontSize="20" fontWeight="700" fill="#1c1917">
        APROBADO
      </text>
      <text x="150" y="360" textAnchor="middle" fontFamily={MONO} fontSize="11" fill="#57534e">
        PEDIDO {p.id} · {p.clienta.toUpperCase().slice(0, 18)}
      </text>
      <text x="150" y="400" textAnchor="middle" fontFamily={MONO} fontSize="11" fill="#a8a29e">
        IMAGEN DE EJEMPLO DEL PROTOTIPO
      </text>
      <Sello x={196} y={88} />
    </svg>
  )
}

/** La foto de un producto con lo que hay que mirar: la falla que mandó la clienta o el recojo. */
export function FotoMarcada({
  src,
  tipo,
  pie,
  className,
}: {
  src: string
  tipo: "falla" | "recojo" | "producto"
  pie: string
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={`Foto de ejemplo: ${pie}`}
      className={cn("relative block aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted", className)}
    >
      <img src={foto(src)} alt="" className="absolute inset-0 size-full object-cover" />
      {tipo === "falla" ? (
        <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" aria-hidden>
          <ellipse cx="300" cy="228" rx="62" ry="34" fill="none" stroke="#dc2626" strokeWidth="5" strokeDasharray="12 7" />
          <path d="M300 194 L270 120" stroke="#dc2626" strokeWidth="4" />
        </svg>
      ) : null}
      <span className="absolute top-2 right-2 rounded-full border-2 border-red-700 bg-white px-2.5 py-0.5 text-[11px] font-bold text-red-700">
        EJEMPLO
      </span>
      <span className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-1.5 text-xs font-medium text-white">{pie}</span>
    </span>
  )
}

/** Una imagen que se amplía al tocarla. */
export function Ampliable({
  titulo,
  children,
  grande,
  className,
}: {
  titulo: string
  children: ReactNode
  /** Lo que se ve ampliado; si no, la misma imagen. */
  grande?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Ampliar: ${titulo}`}
        className={cn(
          "group relative block w-full cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-medium text-white opacity-90 group-hover:opacity-100">
          <Maximize2 className="size-3" aria-hidden />
          Ampliar
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] w-[min(34rem,calc(100vw-2rem))] max-w-none overflow-y-auto">
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription className="sr-only">Imagen ampliada</DialogDescription>
          <div className="mx-auto w-full max-w-md">{grande ?? children}</div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** La imagen de un pago: la captura (Yape o Plin) o el voucher (POS). */
export function ImagenPago({ p, g, tienda, className }: { p: Pedido; g: Pago; tienda: string; className?: string }) {
  return g.medio === "pos" ? (
    <VoucherPos p={p} g={g} tienda={tienda} className={className} />
  ) : (
    <CapturaPago p={p} g={g} tienda={tienda} className={className} />
  )
}
