import { cn } from "cn"
import { useId, type ComponentProps } from "react"
import { BRAND_DIGITS, useBrand } from "../lib/brand.js"

/** Indicador indeterminado con el isotipo de la marca ([32] o [72]). El color se hereda para conservar contraste en botones. */
function Spinner({ className, ...props }: Omit<ComponentProps<"svg">, "children">) {
  const clipId = useId()
  const [first, second] = BRAND_DIGITS[useBrand()]
  const digits = <><path d={first} /><path d={second} /></>
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 0 136 112" data-slot="spinner" role="status" aria-label="Cargando…" className={cn("brand-loading size-6 shrink-0", className)} fill="currentColor" {...props}>
    <g transform="translate(20 12) scale(.8)">
      <g className="brand-loading-numbers">{digits}</g>
      <defs><clipPath id={clipId}>{digits}</clipPath></defs>
      <g clipPath={`url(#${clipId})`}><rect className="brand-loading-scan" x="-38" y="0" width="30" height="96" /></g>
    </g>
    <path d="M16 10H6V102H16M112 10H122V102H112" fill="none" stroke="currentColor" strokeWidth="5" opacity=".2" />
    <g fill="none" stroke="currentColor" strokeWidth="5">
      <path className="brand-loading-bracket" pathLength="100" d="M16 10H6V102H16" />
      <path className="brand-loading-bracket brand-loading-bracket-right" pathLength="100" d="M112 102H122V10H112" />
    </g>
  </svg>
}
export { Spinner }
