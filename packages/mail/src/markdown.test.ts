import { describe, expect, it } from "vitest"
import { renderEmail } from "./layout.js"
import { markdownText, parseInline, parseMarkdown, safeHref } from "./markdown.js"

describe("formato básico de lo que escribe el equipo", () => {
  it("negrita, cursiva con * y con _, y enlaces", () => {
    expect(
      parseInline("Hola **Rosa**, *gracias* y _saludos_ [la web](https://odentia32.com)"),
    ).toEqual([
      { kind: "text", text: "Hola " },
      { kind: "strong", children: [{ kind: "text", text: "Rosa" }] },
      { kind: "text", text: ", " },
      { kind: "em", children: [{ kind: "text", text: "gracias" }] },
      { kind: "text", text: " y " },
      { kind: "em", children: [{ kind: "text", text: "saludos" }] },
      { kind: "text", text: " " },
      { kind: "link", href: "https://odentia32.com", text: "la web" },
    ])
  })

  it("no corta palabras con guion bajo ni toma un asterisco suelto", () => {
    expect(markdownText(parseMarkdown("mi_archivo_final.xlsx y 2 * 3 = 6"))).toBe(
      "mi_archivo_final.xlsx y 2 * 3 = 6",
    )
  })

  it("la dirección suelta es enlace sin el punto que cierra la oración", () => {
    expect(parseInline("Entra a https://odentia32.com/precios.")).toEqual([
      { kind: "text", text: "Entra a " },
      {
        kind: "link",
        href: "https://odentia32.com/precios",
        text: "https://odentia32.com/precios",
      },
      { kind: "text", text: "." },
    ])
  })

  it("solo https y mailto: lo demás queda como texto", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("http://odentia32.com")).toBeNull()
    expect(safeHref("mailto:hola@odentia32.com")).toBe("mailto:hola@odentia32.com")
    expect(parseInline("[clic](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[clic](javascript:alert(1))" },
    ])
  })

  it("listas con «- » y «1. », y párrafos con saltos de línea", () => {
    expect(parseMarkdown("Lo que incluye:\n- Agenda\n- Cobros\n\n1. Uno\n2. Dos")).toEqual([
      { kind: "paragraph", lines: [[{ kind: "text", text: "Lo que incluye:" }]] },
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "Agenda" }], [{ kind: "text", text: "Cobros" }]],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "Uno" }], [{ kind: "text", text: "Dos" }]],
      },
    ])
  })

  it("en el correo: HTML escapado con el formato, y el texto plano sin marcas", () => {
    const mail = renderEmail({
      subject: "Re: Hola",
      preview: "Hola",
      title: "Re: Hola",
      formatted:
        "Hola **<b>Rosa</b>** [precios](https://odentia32.com/precios)\n# no es título\n- uno",
      paragraphs: ["Darvin Cotrina · odentIA"],
      reason: "Le escribimos.",
    })
    expect(mail.html).toContain("<strong>&lt;b&gt;Rosa&lt;/b&gt;</strong>")
    expect(mail.html).toContain('href="https://odentia32.com/precios"')
    expect(mail.html).toContain("# no es título")
    expect(mail.html).toContain("<ul")
    expect(mail.html).not.toContain("<b>Rosa")
    expect(mail.text).toContain(
      "Hola <b>Rosa</b> precios (https://odentia32.com/precios)\n# no es título\n\n- uno",
    )
    expect(mail.text.indexOf("- uno")).toBeLessThan(mail.text.indexOf("Darvin Cotrina"))
  })
})
