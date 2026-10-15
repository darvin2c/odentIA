import { expect, it } from "vitest"
import { channelFormatRule, formatForChannel, stripEmojis } from "./channel-format.js"

it("en WhatsApp la negrita va con un asterisco; el doble se convierte", () => {
  expect(formatForChannel("Promoción **S/ 79.00** hasta el *12 de noviembre*", "whatsapp")).toBe(
    "Promoción *S/ 79.00* hasta el *12 de noviembre*",
  )
  expect(formatForChannel("__Limpieza__ en promoción", "whatsapp")).toBe("*Limpieza* en promoción")
  expect(channelFormatRule("whatsapp")).toContain("*así*")
})

it("en un canal sin formato las marcas se quitan y el texto queda intacto", () => {
  for (const channel of ["telegram", "messenger", "instagram", "web", "email", null]) {
    expect(formatForChannel("Promoción **S/ 79.00** hasta el *12 de noviembre*.", channel)).toBe(
      "Promoción S/ 79.00 hasta el 12 de noviembre.",
    )
    expect(channelFormatRule(channel)).toContain("sin formato")
  }
  // Un asterisco que no marca nada (una nota, una cuenta) no se toca.
  expect(formatForChannel("Precio* sujeto a evaluación; 2 * 3", "telegram")).toBe("Precio* sujeto a evaluación; 2 * 3")
})

it("encabezados y enlaces de Markdown no llegan como símbolos a ningún canal", () => {
  for (const channel of ["whatsapp", "telegram"]) {
    expect(formatForChannel("## Promociones\nReserva aquí: [tu cita](https://clinica.example/reserva?token=ab12)", channel)).toBe(
      "Promociones\nReserva aquí: tu cita: https://clinica.example/reserva?token=ab12",
    )
  }
})

it("sin emojis: se quitan con sus añadidos y sin dejar espacios de más", () => {
  expect(stripEmojis("¡Hola! 😊 Soy Sofi.")).toBe("¡Hola! Soy Sofi.")
  expect(stripEmojis("Listo 👍🏽✨\n🦷 Tu cita es el *martes*.")).toBe("Listo\nTu cita es el *martes*.")
  expect(stripEmojis("Familia 👨‍👩‍👧 y bandera 🇨🇱 fuera ❤️")).toBe("Familia y bandera fuera")
  // Lo que no se dibuja como emoji se queda: marcas, números y signos.
  expect(stripEmojis("Dental® 2 × 3 = 6 #1 © ™")).toBe("Dental® 2 × 3 = 6 #1 © ™")
  expect(formatForChannel("Hola 😊", "whatsapp", { emojis: "no" })).toBe("Hola")
  expect(formatForChannel("Hola 😊", "whatsapp", { emojis: "pocos" })).toBe("Hola 😊")
  expect(formatForChannel("Hola 😊", "whatsapp")).toBe("Hola 😊")
})
