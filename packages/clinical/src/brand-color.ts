/**
 * El color de la marca de la clínica (ADR 0162): la clínica elige un solo color y de
 * él salen el de la app, el de lo que ve el paciente, el del chat de su web y el de
 * la línea del membrete. La cuenta es una sola y vive aquí porque la usan igual la
 * pantalla (`clinic-app`), el chat y el papel (`services`), como la firma dibujada.
 *
 * - Se puede usar cualquier color: nada se rechaza. Lo que cuida la cuenta es que se
 *   lea (WCAG 2.2, 4,5:1 para el texto).
 * - El relleno de los botones lleva letra blanca siempre que se pueda: un color fuerte
 *   (un naranja) se oscurece apenas para que se lea; uno claro (un amarillo) queda
 *   exacto con letra oscura, porque oscurecerlo lo cambiaría demasiado.
 * - Textos, enlaces, foco y la línea del papel van directo sobre el fondo: usan el
 *   tono legible, más oscuro en claro y más claro en oscuro.
 * - Se guarda solo el color elegido; todo lo demás se calcula al mostrarlo, así la
 *   cuenta puede mejorar sin migrar datos.
 *
 * Contraste y luminancia relativa según WCAG 2.2 (sRGB); las mezclas son lineales en
 * sRGB, suficientes para tintes y tonos.
 */

/** El color tal como se guarda: seis cifras hexadecimales en minúsculas. */
export const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/

/** El color de fábrica de cada producto: el primario de odentIA y el de latidIA en `globals.css`. */
export const PRODUCT_BRAND_COLORS = { dental: "#0e7490", medical: "#6d3fc0" } as const

/**
 * Los sugeridos: los más usados en salud, ordenados por familia. Rojo y ámbar no se
 * sugieren porque son los de error y aviso; se pueden poner igual con el código.
 */
export const SUGGESTED_BRAND_COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#0e7490", name: "Turquesa" },
  { hex: "#14b8a6", name: "Aguamarina" },
  { hex: "#38bdf8", name: "Celeste" },
  { hex: "#2563eb", name: "Azul" },
  { hex: "#1e3a8a", name: "Azul marino" },
  { hex: "#15803d", name: "Verde" },
  { hex: "#6ee7b7", name: "Menta" },
  { hex: "#a78bfa", name: "Lila" },
  { hex: "#7c3aed", name: "Morado" },
  { hex: "#db2777", name: "Rosa" },
  { hex: "#ea580c", name: "Naranja" },
  { hex: "#334155", name: "Pizarra" },
]

/** Los sugeridos de un producto: el de fábrica primero (en latidIA, su morado en lugar del otro morado). */
export function suggestedBrandColors(product: keyof typeof PRODUCT_BRAND_COLORS): Array<{ hex: string; name: string; factory: boolean }> {
  if (product === "medical") {
    const rest = SUGGESTED_BRAND_COLORS.filter((color) => color.name !== "Morado")
    return [{ hex: PRODUCT_BRAND_COLORS.medical, name: "Morado", factory: true }, ...rest.map((color) => ({ ...color, factory: false }))]
  }
  return SUGGESTED_BRAND_COLORS.map((color) => ({ ...color, factory: color.hex === PRODUCT_BRAND_COLORS.dental }))
}

/** Un color escrito a mano, como se guarda; null si no son seis cifras hexadecimales. */
export function normalizeBrandColor(value: string): string | null {
  const text = value.trim().toLowerCase()
  const hex = text.startsWith("#") ? text : `#${text}`
  return BRAND_COLOR_PATTERN.test(hex) ? hex : null
}

type Rgb = readonly [number, number, number]

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
/** Tinta de la app (`--foreground` en claro). */
const INK: Rgb = [15, 23, 42]
/** Fondo y tarjeta de la app en oscuro (`--background`, `--card`). */
const DARK_BG: Rgb = [12, 17, 24]
const DARK_CARD: Rgb = [23, 30, 43]
/**
 * La superficie más exigente donde va texto del color: `--secondary` (botón secundario,
 * menú al pasar el mouse). Es la más oscura en claro y la más clara en oscuro, así que si
 * se lee ahí, se lee sobre el fondo, la tarjeta y lo apagado.
 */
const LIGHT_SECONDARY: Rgb = [232, 238, 244]
const DARK_SECONDARY: Rgb = [38, 48, 65]
const TEXT = 4.5

function rgbOf(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function hexOf(color: Rgb): string {
  return `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`
}

/** Luminancia relativa (WCAG 2.2). */
function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contraste entre dos colores (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  return contrastOf(rgbOf(a), rgbOf(b))
}

function contrastOf(a: Rgb, b: Rgb): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Redondea en cada paso: el contraste se comprueba sobre el color que de verdad se escribe. */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ]
}

/** El primer tono, yendo hacia `toward`, que llega al contraste pedido contra `against`. */
function shiftUntil(color: Rgb, toward: Rgb, against: Rgb, ratio: number): Rgb {
  if (contrastOf(color, against) >= ratio) return color
  for (let step = 1; step <= 100; step++) {
    const next = mix(color, toward, step / 100)
    if (contrastOf(next, against) >= ratio) return next
  }
  return toward
}

/**
 * Un tinte que se note sobre el fondo: lo más cerca del fondo que llegue al contraste
 * pedido. Con una mezcla fija, un color claro daba un tinte casi blanco (el menú activo
 * no se veía) y uno oscuro, en modo oscuro, uno casi negro.
 */
function tintUntil(base: Rgb, background: Rgb, ratio: number): Rgb {
  for (let amount = 0.94; amount >= 0.3; amount -= 0.02) {
    const tint = mix(base, background, amount)
    if (contrastOf(tint, background) >= ratio) return tint
  }
  return mix(base, background, 0.3)
}

/** El relleno al pasar el mouse: más oscuro bajo letra blanca, más claro bajo letra oscura. */
function hoverOf(fill: Rgb, foreground: string): string {
  return hexOf(foreground === hexOf(WHITE) ? mix(fill, BLACK, 0.12) : mix(fill, WHITE, 0.18))
}


/** Lo que el color le pone a cada modo: los nombres son los de `globals.css`. */
export interface BrandTokens {
  /** Textos, enlaces, bordes y foco: legible sobre el fondo. */
  primary: string
  primaryForeground: string
  /** El relleno de botones, chat y todo lo que lleva el color con letra encima: con letra blanca siempre que se pueda. */
  fill: string
  fillForeground: string
  /** Al pasar el mouse: se aleja de la letra, así el contraste no baja. */
  fillHover: string
  soft: string
  softForeground: string
  agentSoft: string
  agentBorder: string
}

export interface BrandPalette {
  light: BrandTokens
  dark: BrandTokens
  /** La línea del membrete y el cuadro de iniciales: legible en papel blanco y en fotocopia. */
  paper: string
  /** Es claro: textos y papel usan un tono más oscuro que el elegido. */
  lightened: boolean
  /** Casi blanco: no se distingue del fondo y los botones salen en el tono legible. */
  nearWhite: boolean
  /** Se parece al rojo de los errores. */
  reddish: boolean
  /** Los grises de la app en el tono de la marca (`canvas`, `muted`, `border`…), por modo, con sus nombres de `globals.css`. */
  neutrals: { light: Record<string, string>; dark: Record<string, string> }
}

function hueAndSaturation(color: Rgb): { hue: number; saturation: number } {
  const [r, g, b] = color.map((channel) => channel / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return { hue: 0, saturation: 0 }
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  const lightness = (max + min) / 2
  return { hue, saturation: delta / (1 - Math.abs(2 * lightness - 1)) }
}

/** Lo más que se oscurece un color para llevar letra blanca: más allá ya no se reconoce. */
const WHITE_TEXT_MAX_DARKEN = 0.24

/**
 * El relleno y su letra. Letra blanca siempre que se pueda: si el color exacto no la
 * sostiene pero oscurecerlo apenas basta, se oscurece. La fórmula de WCAG 2 da por mejor
 * la letra oscura sobre los naranjas y rojos intensos, y a la vista es al revés (lo mismo
 * mide APCA, la de WCAG 3). Solo un color claro (amarillo, celeste, menta), que habría que
 * cambiar demasiado, queda exacto con letra oscura. Null si ninguna letra se lee.
 */
function fillWithText(base: Rgb, dark: Rgb): { fill: Rgb; text: string } | null {
  if (contrastOf(base, WHITE) >= TEXT) return { fill: base, text: hexOf(WHITE) }
  for (let step = 1; step <= WHITE_TEXT_MAX_DARKEN * 100; step++) {
    const darker = mix(base, BLACK, step / 100)
    if (contrastOf(darker, WHITE) >= TEXT) return { fill: darker, text: hexOf(WHITE) }
  }
  return contrastOf(base, dark) >= TEXT ? { fill: base, text: hexOf(dark) } : null
}

function lightTokens(base: Rgb, nearWhite: boolean, secondary: Rgb = LIGHT_SECONDARY): BrandTokens {
  const primary = shiftUntil(base, BLACK, secondary, TEXT)
  const chosen = nearWhite ? null : fillWithText(base, INK)
  const fill = chosen?.fill ?? primary
  const fillForeground = chosen?.text ?? hexOf(WHITE)
  // Los mismos contrastes que los tintes de fábrica de odentIA sobre blanco.
  const soft = tintUntil(base, WHITE, 1.18)
  return {
    primary: hexOf(primary),
    primaryForeground: hexOf(WHITE),
    fill: hexOf(fill),
    fillForeground,
    fillHover: hoverOf(fill, fillForeground),
    soft: hexOf(soft),
    softForeground: hexOf(shiftUntil(primary, BLACK, soft, TEXT)),
    agentSoft: hexOf(tintUntil(base, WHITE, 1.08)),
    agentBorder: hexOf(tintUntil(base, WHITE, 1.35)),
  }
}

/** Las superficies del modo oscuro contra las que se mide el color: las de la clínica, si se tiñeron. */
interface DarkSurfaces {
  background: Rgb
  card: Rgb
  secondary: Rgb
}

const SLATE_DARK_SURFACES: DarkSurfaces = { background: DARK_BG, card: DARK_CARD, secondary: DARK_SECONDARY }

function darkTokens(base: Rgb, surfaces: DarkSurfaces = SLATE_DARK_SURFACES): BrandTokens {
  const { background, card, secondary } = surfaces
  // Legible también sobre lo secundario, la superficie más clara del modo oscuro.
  const primary = shiftUntil(base, WHITE, secondary, TEXT)
  const onPrimary = shiftUntil(mix(primary, BLACK, 0.82), BLACK, primary, TEXT)
  // El color de la clínica solo si se distingue del fondo oscuro y tiene una letra que se lea;
  // si no, el tono claro del primario con su letra oscura.
  const chosen = contrastOf(base, background) >= 3 ? fillWithText(base, background) : null
  const usable = chosen && contrastOf(chosen.fill, background) >= 3 ? chosen : null
  const soft = tintUntil(base, background, 1.4)
  const fill = usable?.fill ?? primary
  const fillForeground = usable?.text ?? hexOf(onPrimary)
  return {
    primary: hexOf(primary),
    primaryForeground: hexOf(onPrimary),
    fill: hexOf(fill),
    fillForeground,
    fillHover: hoverOf(fill, fillForeground),
    soft: hexOf(soft),
    softForeground: hexOf(shiftUntil(primary, WHITE, soft, TEXT)),
    agentSoft: hexOf(tintUntil(base, card, 1.15)),
    agentBorder: hexOf(tintUntil(base, background, 1.6)),
  }
}

/**
 * Un nombre para un color sin nombre (los del logo, uno escrito a mano): lo que dice el
 * botón y el lector de pantalla. Aproximado por tono y luz; nunca es el código.
 */
export function brandColorName(hex: string): string {
  const color = rgbOf(hex)
  const { hue, saturation } = hueAndSaturation(color)
  const light = (Math.max(...color) + Math.min(...color)) / 510
  if (saturation < 0.28 || light < 0.08) return light > 0.85 ? "Blanco" : light < 0.25 ? "Negro" : "Gris"
  if (hue < 15 || hue >= 345) return light > 0.75 ? "Rosa" : "Rojo"
  if (hue < 40) return light > 0.75 ? "Durazno" : light < 0.3 ? "Café" : "Naranja"
  if (hue < 65) return light < 0.35 ? "Oliva" : "Amarillo"
  if (hue < 160) return light > 0.6 ? "Menta" : "Verde"
  if (hue < 190) return light > 0.55 ? "Aguamarina" : "Turquesa"
  if (hue < 215) return light > 0.6 ? "Celeste" : "Azul"
  if (hue < 250) return light < 0.3 ? "Azul marino" : light > 0.7 ? "Celeste" : "Azul"
  if (hue < 290) return light > 0.7 ? "Lila" : "Morado"
  return "Rosa"
}

// --- Los grises en el tono de la marca ---------------------------------------
//
// Los grises de la app (slate) son un azul con muy poco color: con un naranja, los
// botones secundarios, los bordes y el texto gris se ven azulados. Toman el tono exacto
// de la marca con un tope de color muy bajo, y cada uno conserva su luz, así los
// contrastes no cambian. En claro, las tarjetas, el fondo de las ventanas y el papel
// siguen blancos. Es la regla del estudio de diseño (tablero 12 del lienzo, ADR 0162):
//   gris = oklch(luz de hoy, min(croma de hoy, 0,012) × min(1, croma de la marca / 0,08), tono de la marca)

/** Los grises de `globals.css` (slate) que siguen a la marca en claro, con su valor de hoy. */
const SLATE_LIGHT: Readonly<Record<string, string>> = {
  canvas: "#f6f8fb",
  sidebar: "#f8fafc",
  muted: "#f1f5f9",
  secondary: "#e8eef4",
  accent: "#e8eef4",
  "sidebar-accent": "#e8eef4",
  border: "#e2e8f0",
  "sidebar-border": "#e2e8f0",
  input: "#cbd5e1",
  "muted-foreground": "#475569",
  "sidebar-foreground": "#1e293b",
  foreground: "#0f172a",
  "card-foreground": "#0f172a",
  "popover-foreground": "#0f172a",
  "secondary-foreground": "#0f172a",
  "accent-foreground": "#0f172a",
  "sidebar-accent-foreground": "#0f172a",
}

/** En oscuro el fondo, la tarjeta y las ventanas también son slate: también siguen a la marca. */
const SLATE_DARK: Readonly<Record<string, string>> = {
  canvas: "#0c1118",
  background: "#0c1118",
  card: "#171e2b",
  popover: "#171e2b",
  sidebar: "#111722",
  muted: "#1e2633",
  secondary: "#263041",
  accent: "#263041",
  "sidebar-accent": "#263041",
  border: "#263041",
  "sidebar-border": "#263041",
  input: "#3b475a",
  "muted-foreground": "#94a3b8",
  "sidebar-foreground": "#e2e8f0",
  foreground: "#f1f5f9",
  "card-foreground": "#f1f5f9",
  "popover-foreground": "#f1f5f9",
  "secondary-foreground": "#f1f5f9",
  "accent-foreground": "#f1f5f9",
  "sidebar-accent-foreground": "#f1f5f9",
}

const NEUTRAL_CHROMA_MAX = 0.012
/** Desde este color de la marca, los grises llevan todo su tono; una marca gris da grises puros. */
const BRAND_CHROMA_FULL = 0.08

function toLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function fromLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return Math.round((clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255)
}

/** sRGB a OKLCH (Ottosson, 2020). */
function oklchOf(color: Rgb): { l: number; c: number; h: number } {
  const r = toLinear(color[0])
  const g = toLinear(color[1])
  const b = toLinear(color[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: lightness, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

function rgbOfOklch(lightness: number, chroma: number, hue: number): Rgb {
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function tintSlate(slate: Readonly<Record<string, string>>, share: number, hue: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, hex] of Object.entries(slate)) {
    const { l, c } = oklchOf(rgbOf(hex))
    out[name] = hexOf(rgbOfOklch(l, Math.min(c, NEUTRAL_CHROMA_MAX) * share, hue))
  }
  return out
}

/**
 * El texto gris se lee (4,5:1) sobre todo fondo donde va: si no llega, se corre su luz de
 * a poco, hacia la tinta en claro y hacia el blanco en oscuro.
 */
function readableMutedText(muted: string, backgrounds: string[], dark: boolean): string {
  const surfaces = backgrounds.map(rgbOf)
  const { c, h } = oklchOf(rgbOf(muted))
  let { l } = oklchOf(rgbOf(muted))
  for (let step = 0; step < 80; step++) {
    const color = rgbOfOklch(l, c, h)
    if (surfaces.every((surface) => contrastOf(color, surface) >= TEXT)) return hexOf(color)
    l += dark ? 0.005 : -0.005
  }
  return muted
}

/** Los grises de la clínica en claro y en oscuro: el tono de la marca, muy suave. */
function brandNeutrals(base: Rgb): BrandPalette["neutrals"] {
  const { c, h } = oklchOf(base)
  const share = Math.min(1, c / BRAND_CHROMA_FULL)
  const light = tintSlate(SLATE_LIGHT, share, h)
  const dark = tintSlate(SLATE_DARK, share, h)
  const pick = (tokens: Record<string, string>, names: string[], fallback: string) =>
    names.map((name) => tokens[name] ?? fallback)
  light["muted-foreground"] = readableMutedText(
    light["muted-foreground"] ?? "#475569",
    [...pick(light, ["canvas", "muted", "secondary"], "#ffffff"), "#ffffff"],
    false,
  )
  dark["muted-foreground"] = readableMutedText(
    dark["muted-foreground"] ?? "#94a3b8",
    pick(dark, ["canvas", "muted", "card", "secondary"], "#0c1118"),
    true,
  )
  return { light, dark }
}

/** Todo lo que sale del color elegido (ya normalizado con `normalizeBrandColor`). */
export function brandPalette(hex: string): BrandPalette {
  const base = rgbOf(hex)
  const nearWhite = contrastOf(base, WHITE) < 1.25
  const neutrals = brandNeutrals(base)
  // Los tonos de la marca se miden contra los grises de la clínica, no contra los de fábrica.
  const light = lightTokens(base, nearWhite, rgbOf(neutrals.light.secondary ?? "#e8eef4"))
  const { hue, saturation } = hueAndSaturation(base)
  return {
    light,
    dark: darkTokens(base, {
      background: rgbOf(neutrals.dark.background ?? "#0c1118"),
      card: rgbOf(neutrals.dark.card ?? "#171e2b"),
      secondary: rgbOf(neutrals.dark.secondary ?? "#263041"),
    }),
    neutrals,
    paper: light.primary,
    // Solo se avisa cuando se nota: un color claro, que no sostiene la letra blanca.
    lightened: !nearWhite && contrastOf(base, WHITE) < TEXT,
    nearWhite,
    reddish: saturation > 0.35 && (hue >= 345 || hue <= 15),
  }
}
