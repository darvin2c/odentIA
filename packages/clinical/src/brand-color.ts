/**
 * El color de la marca de la clínica (ADR 0162): la clínica elige un solo color y de
 * él salen el de la app, el de lo que ve el paciente, el del chat de su web y el de
 * la línea del membrete. La cuenta es una sola y vive aquí porque la usan igual la
 * pantalla (`clinic-app`), el chat y el papel (`services`), como la firma dibujada.
 *
 * - Se puede usar cualquier color: nada se rechaza. Lo que cuida la cuenta es que se
 *   lea (WCAG 2.2, 4,5:1 para el texto).
 * - El relleno de los botones conserva el color exacto, con letra blanca o, si no se
 *   lee, oscura: un amarillo sigue siendo amarillo.
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

/** El color de texto que se lee encima de un relleno, o null si ni blanco ni tinta llegan. */
function textOn(fill: Rgb, light: Rgb, dark: Rgb): string | null {
  if (contrastOf(fill, light) >= TEXT) return hexOf(light)
  if (contrastOf(fill, dark) >= TEXT) return hexOf(dark)
  return null
}

/** Lo que el color le pone a cada modo: los nombres son los de `globals.css`. */
export interface BrandTokens {
  /** Textos, enlaces, bordes y foco: legible sobre el fondo. */
  primary: string
  primaryForeground: string
  /** El relleno de los botones: el color exacto cuando se puede. */
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

function lightTokens(base: Rgb, nearWhite: boolean): BrandTokens {
  const primary = shiftUntil(base, BLACK, WHITE, TEXT)
  let fill = base
  let fillForeground = nearWhite ? null : textOn(base, WHITE, INK)
  if (!fillForeground) {
    fill = primary
    fillForeground = hexOf(WHITE)
  }
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

function darkTokens(base: Rgb): BrandTokens {
  // Legible también sobre la tarjeta, que es un poco más clara que el fondo.
  const primary = shiftUntil(base, WHITE, DARK_CARD, TEXT)
  const onPrimary = shiftUntil(mix(primary, BLACK, 0.82), BLACK, primary, TEXT)
  // El color exacto solo si se distingue del fondo oscuro y tiene un texto que se lea.
  const exactText = contrastOf(base, DARK_BG) >= 3 ? textOn(base, WHITE, DARK_BG) : null
  const soft = tintUntil(base, DARK_BG, 1.4)
  const fill = exactText ? base : primary
  const fillForeground = exactText ?? hexOf(onPrimary)
  return {
    primary: hexOf(primary),
    primaryForeground: hexOf(onPrimary),
    fill: hexOf(fill),
    fillForeground,
    fillHover: hoverOf(fill, fillForeground),
    soft: hexOf(soft),
    softForeground: hexOf(shiftUntil(primary, WHITE, soft, TEXT)),
    agentSoft: hexOf(tintUntil(base, DARK_CARD, 1.15)),
    agentBorder: hexOf(tintUntil(base, DARK_BG, 1.6)),
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

/** Todo lo que sale del color elegido (ya normalizado con `normalizeBrandColor`). */
export function brandPalette(hex: string): BrandPalette {
  const base = rgbOf(hex)
  const nearWhite = contrastOf(base, WHITE) < 1.25
  const light = lightTokens(base, nearWhite)
  const { hue, saturation } = hueAndSaturation(base)
  return {
    light,
    dark: darkTokens(base),
    paper: light.primary,
    lightened: !nearWhite && light.primary !== hex,
    nearWhite,
    reddish: saturation > 0.35 && (hue >= 345 || hue <= 15),
  }
}
