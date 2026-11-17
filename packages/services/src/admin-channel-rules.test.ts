import { describe, expect, it } from "vitest"
import {
  CHANNEL_RULES,
  channelFileProblem,
  channelFileRuleOf,
  channelFilesProblem,
  channelRulesOf,
  channelTextProblem,
  textForChannel,
  utf8Bytes,
} from "./admin-channel-rules.js"

/** Lo que acepta cada canal y lo que sale por él (ADR 0196), sin base: reglas puras. */

const MB = 1024 * 1024

describe("textForChannel", () => {
  const written =
    "Hola *Ana*, te mando el _resumen_ ~viejo~ y **lo nuevo**: [la guía](https://odentia32.com/guia)"

  it("el correo lo recibe tal cual: lo dibuja al enviarlo", () => {
    expect(textForChannel(written, "correo")).toBe(written)
  })

  it("WhatsApp manda sus marcas, pasa **x** a *x* y el enlace a «texto: dirección»", () => {
    expect(textForChannel(written, "whatsapp")).toBe(
      "Hola *Ana*, te mando el _resumen_ ~viejo~ y *lo nuevo*: la guía: https://odentia32.com/guia",
    )
  })

  it("Instagram y Messenger reciben el texto sin marcas", () => {
    const plain =
      "Hola Ana, te mando el resumen viejo y lo nuevo: la guía: https://odentia32.com/guia"
    expect(textForChannel(written, "instagram")).toBe(plain)
    expect(textForChannel(written, "messenger")).toBe(plain)
  })

  it("no toca lo que no es una marca: cuentas, viñetas, palabras_con_guion ni direcciones", () => {
    const text =
      "2 * 3 * 4 = 24\n* uno\n* dos\nmi_archivo_final.xlsx en https://x.test/~ana/_borrador_/a*b*"
    expect(textForChannel(text, "messenger")).toBe(text)
    expect(textForChannel(text, "whatsapp")).toBe(text)
  })

  it("una marca no cruza de línea y no se queda a medias", () => {
    expect(textForChannel("*hola\nmundo*", "instagram")).toBe("*hola\nmundo*")
    expect(textForChannel("**a** y *b*", "instagram")).toBe("a y b")
    expect(textForChannel("(*nota*)", "messenger")).toBe("(nota)")
  })

  it("un enlace cuyo texto ya es la dirección queda solo como dirección", () => {
    expect(textForChannel("[odentia32.com](https://odentia32.com)", "whatsapp")).toBe(
      "https://odentia32.com",
    )
  })
})

describe("channelTextProblem", () => {
  it("WhatsApp y Messenger cuentan caracteres con la firma, y dicen cuánto queda", () => {
    const signature = "\n\n— Ana · odentIA"
    expect(
      channelTextProblem("whatsapp", "a".repeat(4096 - signature.length), signature),
    ).toBeNull()
    expect(channelTextProblem("whatsapp", "a".repeat(4097 - signature.length), signature)).toBe(
      `WhatsApp deja como mucho 4096 caracteres con la firma: usa como máximo ${4096 - signature.length}`,
    )
    expect(channelTextProblem("messenger", "a".repeat(2000))).toBeNull()
    expect(channelTextProblem("messenger", "a".repeat(2001))).toContain("2000 caracteres")
  })

  it("Instagram cuenta bytes: una tilde ocupa dos", () => {
    expect(utf8Bytes("á")).toBe(2)
    expect(channelTextProblem("instagram", "a".repeat(1000))).toBeNull()
    expect(channelTextProblem("instagram", "á".repeat(501))).toContain("1000 bytes")
    expect(channelTextProblem("instagram", "a".repeat(990), "\n\n— Ana · odentIA")).toContain(
      "con la firma",
    )
  })

  it("el correo llega a 5000, el tope del envío", () => {
    expect(CHANNEL_RULES.correo.maxChars).toBe(5000)
    expect(channelTextProblem("correo", "a".repeat(5000))).toBeNull()
    expect(channelTextProblem("correo", "a".repeat(5001))).toContain("5000")
  })
})

describe("los archivos de cada canal", () => {
  const file = (filename: string, contentType: string, size = MB) => ({
    filename,
    contentType,
    size,
  })

  it("WhatsApp: imagen JPG o PNG hasta 5 MB, audio hasta 16 MB y documentos o video hasta 100 MB", () => {
    expect(channelFileRuleOf("whatsapp", "image/png")?.kind).toBe("imagen")
    expect(channelFileRuleOf("whatsapp", "audio/ogg; codecs=opus")?.kind).toBe("audio")
    expect(channelFileRuleOf("whatsapp", "application/pdf")?.kind).toBe("documento")
    expect(channelFileRuleOf("whatsapp", "video/mp4")?.kind).toBe("documento")
    expect(channelFileProblem("whatsapp", file("foto.png", "image/png", 5 * MB))).toBeNull()
    expect(channelFileProblem("whatsapp", file("foto.png", "image/png", 6 * MB))).toContain(
      "«foto.png» pesa 6 MB y WhatsApp manda imágenes de hasta 5 MB",
    )
    // Una imagen que no es JPG ni PNG saldría como imagen y Meta la rechazaría: no sale.
    expect(channelFileProblem("whatsapp", file("animado.gif", "image/gif"))).toContain(
      "«animado.gif» no sale por WhatsApp",
    )
    expect(
      channelFileProblem("whatsapp", file("propuesta.pdf", "application/pdf", 90 * MB)),
    ).toBeNull()
  })

  it("Messenger: lo que sea hasta 25 MB", () => {
    expect(channelFileRuleOf("messenger", "image/gif")?.kind).toBe("imagen")
    expect(channelFileRuleOf("messenger", "application/zip")?.kind).toBe("documento")
    expect(
      channelFileProblem("messenger", file("datos.zip", "application/zip", 26 * MB)),
    ).toContain("de hasta 25 MB")
  })

  it("Instagram: solo PDF como documento, y su lista de imagen, audio y video", () => {
    expect(channelFileProblem("instagram", file("contrato.pdf", "application/pdf"))).toBeNull()
    expect(channelFileProblem("instagram", file("foto.jpg", "image/jpeg", 9 * MB))).toContain(
      "de hasta 8 MB",
    )
    expect(channelFileProblem("instagram", file("video.mov", "video/quicktime"))).toBeNull()
    expect(
      channelFileProblem(
        "instagram",
        file("pacientes.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ),
    ).toContain("«pacientes.xlsx» no sale por Instagram")
  })

  it("el correo: cualquier archivo hasta 10 MB, 5 por respuesta y 10 MB juntos", () => {
    expect(
      channelFileProblem("correo", file("x.bin", "application/octet-stream", 10 * MB)),
    ).toBeNull()
    expect(channelFilesProblem("correo", [{ size: 6 * MB }, { size: 5 * MB }])).toContain(
      "pasan de 10 MB juntos",
    )
    expect(
      channelFilesProblem(
        "correo",
        Array.from({ length: 6 }, () => ({ size: 1 })),
      ),
    ).toBe("Manda como máximo 5 archivos")
  })

  it("un chat manda hasta 5 archivos, cada uno en su mensaje, sin tope entre todos", () => {
    expect(channelRulesOf("whatsapp")).toMatchObject({ maxFiles: 5, maxTotalBytes: null })
    expect(channelFilesProblem("whatsapp", [{ size: 90 * MB }, { size: 90 * MB }])).toBeNull()
  })

  it("las reglas dicen cómo se ve el formato de cada canal", () => {
    expect(channelRulesOf("correo").formatting).toBe("markdown")
    expect(channelRulesOf("whatsapp").formatting).toBe("whatsapp")
    expect(channelRulesOf("instagram")).toMatchObject({
      formatting: "texto",
      maxChars: null,
      maxBytes: 1000,
    })
    expect(channelRulesOf("messenger")).toMatchObject({ formatting: "texto", maxChars: 2000 })
  })
})
