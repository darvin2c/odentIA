// El ícono de la pestaña: el isotipo [24] de la marca común, en el naranja de gestorIA (un archivo
// suelto no lee las variables de color de la página).
import type { APIRoute } from "astro"
import isotipo from "../assets/isotipo.svg?raw"

export const GET: APIRoute = () =>
  new Response(isotipo.replace("var(--identity-accent)", "#ea580c"), {
    headers: { "Content-Type": "image/svg+xml" },
  })
