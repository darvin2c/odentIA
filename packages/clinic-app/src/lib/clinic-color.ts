import { BRAND_COLOR_PATTERN, type BrandTokens, brandPalette } from "@odentia/clinical"
import { apiFetch } from "./api"
import { orgSlugFromHostname, requestHostname } from "./host"

/**
 * El color de la marca de la clínica en su app y en sus páginas públicas (ADR 0157).
 *
 * La raíz de cada app lo pide al servidor y lo escribe en el `<head>` del primer
 * pintado, así nada parpadea en el color del producto. Solo redefine el bloque
 * «Marca» de `globals.css` (y el tinte del agente, que sigue a la clínica): estados,
 * gráficos y la identidad de odentIA o latidIA no cambian. Sin color elegido no se
 * escribe nada y queda el del producto.
 */

export interface ClinicAppearance {
  brandColor: string | null
}

/** Una página no espera al color: pasado este rato sale con el del producto. */
const APPEARANCE_TIMEOUT_MS = 1500

/**
 * En el navegador, lo que respondió el servidor vale para toda la pestaña: la raíz no
 * vuelve a pedirlo en cada navegación. Lo que falló no se guarda, así la siguiente
 * navegación lo intenta otra vez en vez de quedar con el color del producto.
 */
let known: ClinicAppearance | null = null

/** Lo pide la raíz; si la API no responde a tiempo, queda el color del producto y se reintenta después. */
export async function loadClinicAppearance(): Promise<ClinicAppearance> {
  const browser = typeof window !== "undefined"
  if (browser && known) return known
  const slug = orgSlugFromHostname(requestHostname())
  if (!slug) return { brandColor: null }
  try {
    const { data } = await apiFetch<{ data: ClinicAppearance }>(`/api/public/appearance/${encodeURIComponent(slug)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(APPEARANCE_TIMEOUT_MS),
    })
    const appearance = { brandColor: data.brandColor ?? null }
    if (browser) known = appearance
    return appearance
  } catch {
    return { brandColor: null }
  }
}

/** Al guardar el color: la próxima carga de la raíz lo vuelve a pedir. */
export function forgetClinicAppearance(): void {
  known = null
}

function tokens(t: BrandTokens): string {
  return [
    `--primary:${t.primary}`,
    `--primary-foreground:${t.primaryForeground}`,
    `--primary-fill:${t.fill}`,
    `--primary-fill-foreground:${t.fillForeground}`,
    `--primary-fill-hover:${t.fillHover}`,
    `--primary-soft:${t.soft}`,
    `--primary-soft-foreground:${t.softForeground}`,
    `--ring:${t.primary}`,
    `--sidebar-primary:${t.primary}`,
    `--sidebar-primary-foreground:${t.primaryForeground}`,
    `--sidebar-ring:${t.primary}`,
    `--agent-soft:${t.agentSoft}`,
    `--agent-border:${t.agentBorder}`,
  ].join(";")
}

/**
 * Las reglas del color de la clínica. `:root:root:root` pesa más que `[data-brand]` y
 * que `.dark`, así no depende del orden de las hojas. Lo que se ve como papel
 * (`.theme-light`) queda claro también con la app en oscuro: `.dark` solo va en la raíz.
 */
export function clinicColorCss(brandColor: string | null | undefined): string | null {
  if (!brandColor || !BRAND_COLOR_PATTERN.test(brandColor)) return null
  const { light, dark } = brandPalette(brandColor)
  return `:root:root:root,:root:root:root .theme-light{${tokens(light)}}:root:root:root.dark{${tokens(dark)}}`
}

/** Para el `head` de la raíz: el `<style>` del color, o nada. */
export function clinicColorStyles(appearance: ClinicAppearance | undefined): Array<{ children: string }> {
  const css = clinicColorCss(appearance?.brandColor)
  return css ? [{ children: css }] : []
}
