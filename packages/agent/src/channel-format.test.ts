import { expect, it } from "vitest"
import { channelFormatRule, formatForChannel } from "./channel-format.js"

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
