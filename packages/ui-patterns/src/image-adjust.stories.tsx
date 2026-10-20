import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { ImageAdjust, type ImageAdjustValue } from "./image-adjust.js"
import { PersonAvatar } from "./person-avatar.js"

// Imágenes dibujadas aquí mismo: un retrato y un logo con márgenes de sobra.
const PORTRAIT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600"><rect width="900" height="600" fill="#d9eff5"/><circle cx="450" cy="250" r="120" fill="#e8b98f"/><rect x="300" y="380" width="300" height="260" rx="140" fill="#0e7490"/><circle cx="410" cy="235" r="12" fill="#1f2937"/><circle cx="490" cy="235" r="12" fill="#1f2937"/><path d="M405 295 q45 35 90 0" stroke="#1f2937" stroke-width="8" fill="none"/></svg>`,
)}`
const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><text x="400" y="270" font-family="sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="#0e7490">Dental Smile</text></svg>`,
)}`

function WithResult(props: Omit<React.ComponentProps<typeof ImageAdjust>, "onChange">) {
  const [value, setValue] = useState<ImageAdjustValue | null>(null)
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <ImageAdjust {...props} onChange={setValue} />
      <p role="status" className="text-sm text-muted-foreground">
        {value
          ? `Recorte: ${value.area.width} × ${value.area.height} px desde (${value.area.x}, ${value.area.y})`
          : "Sin recorte todavía"}
      </p>
    </div>
  )
}

const meta = {
  title: "Patrones/Ajustar imagen",
  component: ImageAdjust,
  parameters: { layout: "padded" },
  args: { shape: "person", name: "Rosa Quispe Mamani", onChange: () => {} },
  render: (args) => <WithResult {...args} />,
} satisfies Meta<typeof ImageAdjust>
export default meta
type Story = StoryObj<typeof meta>

/** Sin imagen: arrastrar, elegir un archivo o tomar la foto. */
export const ParaElegir: Story = {}

/** La foto de una persona: cuadrada, con máscara redonda, zoom y vista previa chica y grande. */
export const FotoDePersona: Story = { args: { defaultSource: PORTRAIT } }

/** El logo: un rectángulo libre sobre cuadros, que empieza con la imagen entera. */
export const LogoDeLaClinica: Story = {
  args: { shape: "logo", name: "Dental Smile", defaultSource: LOGO },
}

/** El avatar sin foto: el mismo círculo en la barra lateral, en Mi perfil y en la ficha. */
export const AvatarSinFoto: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <PersonAvatar name="Dra. Ana Torres" className="size-8" fallbackClassName="text-xs" />
      <PersonAvatar name="Dra. Ana Torres" className="size-16" fallbackClassName="text-lg" />
      <PersonAvatar
        name="Juan de la Cruz Ríos"
        givenNames="Juan"
        familyName="de la Cruz Ríos"
        className="size-16"
        fallbackClassName="text-lg"
      />
    </div>
  ),
}
