import { Toaster } from "@odentia/ui"
import type { Preview } from "@storybook/react"
// Tokens reales del design system (colores, radios, tipografía) + las fuentes
// `@source` de los paquetes: sin esto Tailwind no genera las clases que solo
// se usan dentro de `packages/ui` (p. ej. el ancho variable del drawer).
import "./storybook.css"

// Toaster montado globalmente: el feedback de error/éxito de los patrones es
// por toast, y sin él las stories de guardado no mostrarían nada.
const preview: Preview = {
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster position="top-center" richColors />
      </>
    ),
  ],
}

export default preview
