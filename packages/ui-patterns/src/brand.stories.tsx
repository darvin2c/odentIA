import type { Meta, StoryObj } from "@storybook/react"
import type { CSSProperties } from "react"
import { Brand } from "./brand.js"
import { AuthAside, AuthSplit } from "./auth-split.js"
import { PasswordInput } from "./password-input.js"

const meta = { title: "Identidad/Marca", component: Brand, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Brand>
export default meta
type Story = StoryObj<typeof meta>

/** El primario personalizado cambia las acciones, nunca la identidad de la plataforma. */
export const Temas: Story = {
  render: () => <div className="grid gap-6 p-6 md:grid-cols-2">
    {[false, true].flatMap(dark => [false, true].map(custom =>
      <section key={`${dark}-${custom}`} className={dark ? "dark" : ""}>
        <div className="flex flex-col gap-6 rounded-xl bg-background p-6 text-foreground" style={custom ? { "--primary": dark ? "#c4b5fd" : "#6d28d9", "--primary-foreground": dark ? "#211144" : "#ffffff" } as CSSProperties : undefined}>
          <h2>{dark ? "Oscuro" : "Claro"} · {custom ? "Tema violeta de organización" : "Tema principal"}</h2>
          <Brand />
          <Brand compact />
          <button type="button" className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground">Acción de la organización</button>
        </div>
      </section>
    ))}
  </div>,
}

export const Acceso: Story = {
  render: () => (
    <AuthSplit
      title="Buenas tardes, Carmen."
      description="Clínica Dental Sonrisa"
      aside={<AuthAside tag="Tu clínica" title="Omnicanal" accent="y agéntica."><p>Tus agentes siguieron trabajando mientras no estabas.</p></AuthAside>}
      footer={<span>carmen@sonrisa.pe · <u>¿No eres tú?</u></span>}
    >
      <PasswordInput id="pw" value="" onChange={() => {}} autoComplete="current-password" />
    </AuthSplit>
  ),
}
