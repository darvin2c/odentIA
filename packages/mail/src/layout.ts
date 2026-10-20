import { LOGOS } from "./logos.js"

/**
 * Un solo molde para todo correo que envía odentIA (issue 163, lienzo «Correos
 * de odentIA · diseño estándar»). Tablas con estilos en línea, que es lo que
 * Gmail, Outlook y Apple Mail dibujan igual; el botón también es una tabla para
 * que Outlook lo pinte como botón. Logotipo e isotipo van adjuntos por `cid`
 * (ver `logoAttachments`), nunca remotos. Todo texto se escapa aquí: quien arma
 * un correo pasa texto plano, nunca HTML.
 */

export interface MailTemplate {
  subject: string
  html: string
  text: string
  /** Buzón que recibe las respuestas; sin él, el correo dice que no se responde. */
  replyTo?: string
}

export interface EmailFact {
  label: string
  value: string
  /** La cifra que la persona busca (el total): más grande, con raya encima. */
  total?: boolean
}

export interface EmailSection {
  title: string
  rows: readonly (readonly [label: string, value: string])[]
}

export interface EmailContent {
  subject: string
  /** Lo que la bandeja muestra junto al asunto; va oculto en el correo. */
  preview: string
  title: string
  /** Línea pequeña sobre el título: «Libro de Reclamaciones virtual». */
  eyebrow?: string
  /** Aviso para el equipo de odentIA: etiqueta «Interno · <área>» y pie sin enlaces. */
  internal?: string
  /** Banda bajo la cabecera: ámbar mientras corre un plazo, roja cuando ya pasó. */
  band?: { tone: "plazo" | "vencido"; text: string }
  /** Párrafos de texto plano; un salto de línea se respeta. */
  paragraphs: readonly string[]
  list?: readonly string[]
  /** Texto de otra persona destacado en un recuadro: la respuesta a una hoja. */
  quote?: { title: string; text: string; caption?: string }
  /** Ficha de datos: etiqueta a la izquierda, valor a la derecha. */
  facts?: readonly EmailFact[]
  /** Documento largo por secciones: la Hoja de Reclamación. */
  sections?: readonly EmailSection[]
  /** Bloques con título después de la ficha: una lista corta o un párrafo («Lo que cambió»). */
  blocks?: readonly { title: string; items?: readonly string[]; text?: string }[]
  /** Un solo botón, al lugar donde se actúa. */
  action?: { label: string; url: string }
  /** Plazo, qué pasa si no hace nada o qué hacer si no fue la persona. */
  note?: string
  /** Textos fijos en un recuadro gris (los legales de la hoja). */
  notices?: readonly string[]
  /** Por qué lo recibe: «Te escribimos porque…». */
  reason: string
  /** Para un correo que la persona prendió para sí: el enlace para dejar de recibirlo, junto a `reason`. */
  unsubscribe?: { label: string; url: string }
  /** Quien recibe las respuestas. */
  replyTo?: string
  /** Qué pasa si responde; por defecto, que el correo no recibe respuestas. */
  replies?: string
}

/* ---------- Enlaces del pie ---------- */

let siteUrl: string | null = null

/**
 * Cada proceso que envía correos lo llama al arrancar con `WEB_URL` (el panel,
 * `app.`). La web de marketing ocupa el dominio raíz y, en local, `www.` (la
 * misma regla que `apps/web/astro.config.mjs`). Sin configurar, el pie no lleva
 * Términos, Privacidad ni Ayuda.
 */
export function configureMailLinks(webUrl: string): void {
  const url = new URL(webUrl)
  const root = url.hostname.replace(/^app\./, "")
  url.hostname = root.endsWith(".localhost") ? `www.${root}` : root
  siteUrl = url.origin
}

/** Solo para pruebas: deja el pie como si nadie hubiera configurado los enlaces. */
export function resetMailLinks(): void {
  siteUrl = null
}

function footerLinks(): { domain: string; links: { label: string; url: string }[] } | null {
  if (!siteUrl) return null
  return {
    domain: new URL(siteUrl).hostname.replace(/^www\./, ""),
    links: [
      { label: "Términos", url: `${siteUrl}/terminos` },
      { label: "Privacidad", url: `${siteUrl}/privacidad` },
      { label: "Ayuda", url: `${siteUrl}/contacto` },
    ],
  }
}

/* ---------- Imágenes adjuntas ---------- */

export const LOGO_CIDS = {
  logotipoClaro: "logotipo-claro@odentia",
  logotipoOscuro: "logotipo-oscuro@odentia",
  isotipoClaro: "isotipo-claro@odentia",
  isotipoOscuro: "isotipo-oscuro@odentia",
} as const

/**
 * Las imágenes que el HTML nombra por `cid:`, listas para Nodemailer. Se
 * calculan al enviar, no al armar: un correo guardado (avisos de Plan y pagos)
 * también sale con su logotipo.
 */
export function logoAttachments(html: string): { filename: string; content: Buffer; cid: string; contentType: string }[] {
  return (Object.keys(LOGO_CIDS) as (keyof typeof LOGO_CIDS)[])
    .filter((name) => html.includes(`cid:${LOGO_CIDS[name]}`))
    .map((name) => ({
      filename: `${LOGO_CIDS[name].split("@")[0]}.png`,
      content: Buffer.from(LOGOS[name].base64, "base64"),
      cid: LOGO_CIDS[name],
      contentType: "image/png",
    }))
}

/* ---------- HTML ---------- */

/** Escapa texto escrito por otra persona antes de ponerlo en el HTML de un correo (contenido y atributos). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const lines = (text: string) => escapeHtml(text).replace(/\r\n?/g, "\n").replaceAll("\n", "<br>")

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
const C = {
  fondo: "#f1f5f9",
  tarjeta: "#ffffff",
  borde: "#e2e8f0",
  pie: "#f8fafc",
  tinta: "#0f172a",
  cuerpo: "#1e293b",
  nota: "#334155",
  suave: "#475569",
  marca: "#0e7490",
  marcaTinta: "#0b5568",
}
const BANDS = {
  plazo: { fondo: "#fdf3df", borde: "#f0d9a8", tinta: "#7a4a00" },
  vencido: { fondo: "#fdeaea", borde: "#f2c4c4", tinta: "#8f1c1c" },
} as const

/**
 * Modo oscuro para quien lo respeta (Apple Mail, Outlook nuevo) y ajuste al
 * teléfono. Gmail oscurece por su cuenta: por eso el molde no depende de esto.
 */
const STYLE = `
.oscuro{display:none}
@media (max-width:620px){
.tarjeta{width:100%!important}
.marco{padding:0!important}
.px{padding-left:20px!important;padding-right:20px!important}
.cuerpo{font-size:16px!important;line-height:25px!important}
.boton,.boton td,.boton a{display:block!important;text-align:center!important}
.enlaces{display:block!important;padding:12px 0 0 0!important;text-align:left!important}
}
@media (prefers-color-scheme:dark){
body,.fondo{background-color:#0c1118!important}
.tarjeta{background-color:#171e2b!important;border-color:#263041!important}
.linea{border-color:#263041!important}
.pie,.recuadro{background-color:#111722!important}
.t1{color:#f1f5f9!important}
.t2{color:#e2e8f0!important}
.t3{color:#94a3b8!important}
.claro{display:none!important}
.oscuro{display:block!important}
.boton td{background-color:#4fc3d7!important}
.boton a{color:#03252e!important}
a.enlace{color:#8ad8e6!important}
}`

/** La versión clara y, oculta, la oscura: el modo oscuro la cambia; Outlook de escritorio ni la ve. */
function logo(kind: "logotipo" | "isotipo", alt: string): string {
  const { width, height } = LOGOS[`${kind}Claro`]
  const size = `width="${width}" height="${height}"`
  const base = `display:block;border:0;outline:none;text-decoration:none;width:${width}px;height:${height}px;`
  return (
    `<img class="claro" src="cid:${LOGO_CIDS[`${kind}Claro`]}" alt="${alt}" ${size} style="${base}">` +
    `<!--[if !mso]><!--><img class="oscuro" src="cid:${LOGO_CIDS[`${kind}Oscuro`]}" alt="${alt}" ${size} style="${base}display:none;mso-hide:all;"><!--<![endif]-->`
  )
}

function row(content: string, padding: string, extra = ""): string {
  return `<tr><td class="px" style="padding:${padding};${FONT}${extra}">${content}</td></tr>`
}

function button(action: { label: string; url: string }): string {
  const url = escapeHtml(action.url)
  return (
    `<table role="presentation" class="boton" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="${C.marca}" style="border-radius:6px;background-color:${C.marca};">` +
    `<a href="${url}" target="_blank" style="display:inline-block;padding:12px 24px;${FONT}font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>`
  )
}

function factsTable(facts: readonly EmailFact[]): string {
  const cell = `${FONT}font-size:14px;line-height:20px;`
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="linea" style="border-top:1px solid ${C.borde};">` +
    facts
      .map((fact) =>
        fact.total
          ? `<tr><td class="t1 linea" valign="bottom" style="padding:14px 0;border-top:2px solid ${C.tinta};${FONT}font-size:16px;line-height:22px;font-weight:bold;color:${C.tinta};">${escapeHtml(fact.label)}</td>` +
            `<td class="t1 linea" valign="bottom" align="right" style="padding:14px 0;border-top:2px solid ${C.tinta};${FONT}font-size:20px;line-height:26px;font-weight:bold;color:${C.tinta};">${escapeHtml(fact.value)}</td></tr>`
          : `<tr><td class="t3 linea" valign="top" style="padding:9px 16px 9px 0;border-bottom:1px solid ${C.borde};${cell}color:${C.suave};">${escapeHtml(fact.label)}</td>` +
            `<td class="t1 linea" valign="top" align="right" style="padding:9px 0;border-bottom:1px solid ${C.borde};${cell}font-weight:600;color:${C.tinta};">${lines(fact.value)}</td></tr>`,
      )
      .join("") +
    `</table>`
  )
}

function sectionsHtml(sections: readonly EmailSection[]): string {
  const cell = `${FONT}font-size:14px;line-height:20px;`
  return sections
    .map(
      (section, index) =>
        `<h2 class="t1" style="margin:${index === 0 ? 0 : 20}px 0 6px 0;${FONT}font-size:15px;line-height:20px;font-weight:bold;color:${C.tinta};">${escapeHtml(section.title)}</h2>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="linea" style="border-top:1px solid ${C.borde};">` +
        section.rows
          .map(
            ([label, value]) =>
              `<tr><td class="t3 linea" width="38%" valign="top" style="padding:8px 16px 8px 0;border-bottom:1px solid ${C.borde};${cell}color:${C.suave};">${escapeHtml(label)}</td>` +
              `<td class="t1 linea" valign="top" style="padding:8px 0;border-bottom:1px solid ${C.borde};${cell}color:${C.tinta};">${lines(value)}</td></tr>`,
          )
          .join("") +
        `</table>`,
    )
    .join("")
}

/** El correo en HTML y en texto plano, de las mismas piezas: nunca dicen cosas distintas. */
export function renderEmail(content: EmailContent): MailTemplate {
  const links = content.internal ? null : footerLinks()
  const replies =
    content.replies ?? "Este correo no recibe respuestas: si necesitas ayuda, escríbenos desde Ayuda, dentro de odentIA."
  const reasonText = content.internal ? content.reason : `${content.reason} ${replies}`
  const p = (text: string, style: string, cls = "t2") => `<p class="${cls}" style="margin:0;${FONT}${style}">${lines(text)}</p>`

  const body: string[] = []

  // Cabecera: solo el logotipo; en los internos, la etiqueta que lo dice antes de leer.
  const label = content.internal
    ? `<td align="right" valign="middle" style="${FONT}"><span style="display:inline-block;${FONT}font-size:12px;line-height:16px;font-weight:bold;color:${C.nota};background-color:${C.borde};border-radius:4px;padding:4px 8px;">Interno · ${escapeHtml(content.internal)}</span></td>`
    : ""
  body.push(
    `<tr><td class="px linea" style="padding:24px 32px;border-bottom:1px solid ${C.borde};">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${logo("logotipo", "odentIA")}</td>${label}</tr></table>` +
      `</td></tr>`,
  )

  if (content.band) {
    const band = BANDS[content.band.tone]
    body.push(
      `<tr><td class="px" style="padding:12px 32px;background-color:${band.fondo};border-bottom:1px solid ${band.borde};${FONT}font-size:14px;line-height:20px;font-weight:bold;color:${band.tinta};">${escapeHtml(content.band.text)}</td></tr>`,
    )
  }

  const head =
    (content.eyebrow
      ? `<p style="margin:0 0 4px 0;${FONT}font-size:13px;line-height:18px;font-weight:600;color:${C.marcaTinta};">${escapeHtml(content.eyebrow)}</p>`
      : "") +
    `<h1 class="t1" style="margin:0;${FONT}font-size:22px;line-height:28px;font-weight:bold;color:${C.tinta};">${escapeHtml(content.title)}</h1>` +
    content.paragraphs
      .map((text) => `<p class="t2 cuerpo" style="margin:16px 0 0 0;${FONT}font-size:15px;line-height:24px;color:${C.cuerpo};">${lines(text)}</p>`)
      .join("") +
    (content.list?.length
      ? `<ul class="t2 cuerpo" style="margin:12px 0 0 0;padding:0 0 0 20px;${FONT}font-size:15px;line-height:24px;color:${C.cuerpo};">${content.list.map((item) => `<li style="margin:0 0 4px 0;">${lines(item)}</li>`).join("")}</ul>`
      : "")
  body.push(row(head, "32px 32px 0 32px"))

  if (content.quote) {
    body.push(
      row(
        `<h2 class="t1" style="margin:0 0 8px 0;${FONT}font-size:15px;line-height:20px;font-weight:bold;color:${C.tinta};">${escapeHtml(content.quote.title)}</h2>` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="recuadro t2" style="padding:12px 14px;background-color:${C.fondo};border-radius:6px;${FONT}font-size:14px;line-height:22px;color:${C.cuerpo};">${lines(content.quote.text)}</td></tr></table>` +
          (content.quote.caption ? `<p class="t3" style="margin:8px 0 0 0;${FONT}font-size:13px;line-height:19px;color:${C.suave};">${escapeHtml(content.quote.caption)}</p>` : ""),
        "24px 32px 0 32px",
      ),
    )
  }
  if (content.facts?.length) body.push(row(factsTable(content.facts), "20px 32px 0 32px"))
  for (const block of content.blocks ?? []) {
    body.push(
      row(
        `<h2 class="t1" style="margin:0 0 8px 0;${FONT}font-size:15px;line-height:20px;font-weight:bold;color:${C.tinta};">${escapeHtml(block.title)}</h2>` +
          (block.items?.length
            ? `<ul class="t2 cuerpo" style="margin:0;padding:0 0 0 20px;${FONT}font-size:15px;line-height:24px;color:${C.cuerpo};">${block.items.map((item) => `<li style="margin:0 0 4px 0;">${lines(item)}</li>`).join("")}</ul>`
            : "") +
          (block.text ? `<p class="t2 cuerpo" style="margin:0;${FONT}font-size:15px;line-height:24px;color:${C.cuerpo};">${lines(block.text)}</p>` : ""),
        "24px 32px 0 32px",
      ),
    )
  }
  if (content.sections?.length) body.push(row(sectionsHtml(content.sections), "24px 32px 0 32px"))
  if (content.action) body.push(row(button(content.action), "24px 32px 0 32px"))
  if (content.note) body.push(row(p(content.note, `font-size:14px;line-height:22px;color:${C.nota};`), "20px 32px 0 32px"))
  if (content.notices?.length) {
    body.push(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="recuadro linea" style="padding:14px 16px;background-color:${C.pie};border:1px solid ${C.borde};border-radius:6px;">` +
          content.notices
            .map((text, index) => `<p class="t2" style="margin:${index ? 8 : 0}px 0 0 0;${FONT}font-size:13px;line-height:19px;color:${C.nota};">${escapeHtml(text)}</p>`)
            .join("") +
          `</td></tr></table>`,
        "24px 32px 0 32px",
      ),
    )
  }
  if (content.action) {
    const url = escapeHtml(content.action.url)
    body.push(
      row(
        `<p class="t3" style="margin:0;${FONT}font-size:13px;line-height:19px;color:${C.suave};">Si el botón no funciona, copia este enlace en tu navegador:<br><a class="enlace" href="${url}" target="_blank" style="color:${C.marca};word-break:break-all;">${url}</a></p>`,
        "20px 32px 0 32px",
      ),
    )
  }

  // Pie: por qué lo recibes, la firma y, salvo en los internos, Términos, Privacidad, Ayuda y el ©.
  const signature =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="padding:0 12px 0 0;">${logo("isotipo", "")}</td>` +
    `<td valign="middle" style="${FONT}"><p class="t1" style="margin:0;${FONT}font-size:14px;line-height:18px;font-weight:bold;color:${C.tinta};">odentIA</p>` +
    (links ? `<p class="t3" style="margin:0;${FONT}font-size:13px;line-height:18px;color:${C.suave};">${escapeHtml(links.domain)}</p>` : "") +
    `</td></tr></table>`
  const linkCell = links
    ? `<td class="enlaces" align="right" valign="middle" style="padding:16px 0 0 0;${FONT}font-size:12px;line-height:18px;">` +
      links.links
        .map((link, index) => `<a class="enlace" href="${escapeHtml(link.url)}" target="_blank" style="color:${C.marca};text-decoration:underline;${index ? "margin-left:14px;" : ""}">${link.label}</a>`)
        .join("") +
      `</td>`
    : ""
  body.push(
    `<tr><td style="padding:28px 0 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>` +
      `<tr><td class="px pie linea" style="padding:20px 32px;background-color:${C.pie};border-top:1px solid ${C.borde};border-radius:0 0 8px 8px;">` +
      `<p class="t3" style="margin:0;${FONT}font-size:12px;line-height:18px;color:${C.suave};">${escapeHtml(reasonText)}${
        content.unsubscribe
          ? ` <a class="enlace" href="${escapeHtml(content.unsubscribe.url)}" target="_blank" style="color:${C.marca};text-decoration:underline;">${escapeHtml(content.unsubscribe.label)}</a>`
          : ""
      }</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="linea" style="margin:16px 0 0 0;border-top:1px solid ${C.borde};"><tr>` +
      `<td valign="middle" style="padding:16px 0 0 0;">${signature}</td>` +
      linkCell +
      `</tr></table>` +
      (links ? `<p class="t3" style="margin:16px 0 0 0;${FONT}font-size:12px;line-height:18px;color:${C.suave};">© ${new Date().getUTCFullYear()} odentIA</p>` : "") +
      `</td></tr>`,
  )

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.subject)}</title>
<style>${STYLE}
</style>
</head>
<body class="fondo" style="margin:0;padding:0;background-color:${C.fondo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(content.preview)}${"&#8199;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fondo" style="background-color:${C.fondo};">
<tr><td align="center" class="marco" style="padding:32px 12px;">
<table role="presentation" class="tarjeta" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${C.tarjeta};border:1px solid ${C.borde};border-radius:8px;">
${body.join("\n")}
</table>
</td></tr>
</table>
</body>
</html>
`

  const text: string[] = [content.title, ""]
  if (content.band) text.push(content.band.text, "")
  for (const paragraph of content.paragraphs) text.push(paragraph, "")
  if (content.list?.length) text.push(...content.list.map((item) => `- ${item}`), "")
  if (content.quote) {
    text.push(content.quote.title.toUpperCase(), content.quote.text)
    if (content.quote.caption) text.push(content.quote.caption)
    text.push("")
  }
  if (content.facts?.length) text.push(...content.facts.map((fact) => `${fact.label}: ${fact.value}`), "")
  for (const block of content.blocks ?? []) {
    text.push(block.title.toUpperCase(), ...(block.items ?? []).map((item) => `- ${item}`), ...(block.text ? [block.text] : []), "")
  }
  for (const section of content.sections ?? []) {
    text.push(section.title.toUpperCase(), ...section.rows.map(([label, value]) => `${label}: ${value}`), "")
  }
  if (content.action) text.push(`${content.action.label}: ${content.action.url}`, "")
  if (content.note) text.push(content.note, "")
  if (content.notices?.length) text.push(...content.notices, "")
  text.push("--", reasonText)
  if (content.unsubscribe) text.push(`${content.unsubscribe.label}: ${content.unsubscribe.url}`)
  text.push(links ? `odentIA · ${links.domain}` : "odentIA")
  if (links) text.push(links.links.map((link) => `${link.label}: ${link.url}`).join(" · "))

  return {
    subject: content.subject,
    html,
    text: `${text.join("\n")}\n`,
    ...(content.replyTo ? { replyTo: content.replyTo } : {}),
  }
}
