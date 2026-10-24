import type { Meta, StoryObj } from "@storybook/react"
import { type BrandId, BrandProvider, Spinner } from "@odentia/ui"
import { type CSSProperties, type ReactNode, useEffect } from "react"
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

/** Pone la marca en `<html>` mientras se ve la historia, como lo hace la raíz de cada app. */
function OnHtml({ brand, children }: { brand: BrandId; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.brand = brand
    return () => {
      delete document.documentElement.dataset.brand
    }
  }, [brand])
  return <BrandProvider brand={brand}>{children}</BrandProvider>
}

/** Las dos marcas (issue 229): mismo diseño; cambian el nombre, el número y el color. */
export const Marcas: Story = {
  render: () => (
    <div className="grid gap-6 p-6 md:grid-cols-2">
      {(["odentia", "latidia"] as const).flatMap((brand) =>
        [false, true].map((dark) => (
          <section
            key={`${brand}-${dark}`}
            className={dark ? "dark" : ""}
            style={
              {
                "--identity-accent": brand === "latidia" ? (dark ? "#b79cf0" : "#6d3fc0") : dark ? "#4fc3d7" : "#0e7490",
                "--identity-ink": dark ? "#f1f5f9" : "#0f172a",
              } as CSSProperties
            }
          >
            <BrandProvider brand={brand}>
              <div className="flex flex-col gap-6 rounded-xl bg-background p-6 text-foreground">
                <h2>
                  {brand === "latidia" ? "latidIA" : "odentIA"} · {dark ? "oscuro" : "claro"}
                </h2>
                <Brand />
                <div className="flex items-center gap-6 text-[var(--identity-accent)]">
                  <Brand compact />
                  <Spinner className="size-10" />
                </div>
              </div>
            </BrandProvider>
          </section>
        )),
      )}
    </div>
  ),
}

/** El acceso de latidIA: noche morada, «Tu consultorio» y el pulso a 72 lpm (tablero «Marca y color»). */
export const AccesoLatidia: Story = {
  render: () => (
    <OnHtml brand="latidia">
      <AuthSplit
        title="Buenas noches."
        description="Qué bueno verte. Entra a tu consultorio."
        aside={
          <AuthAside tag="Tu consultorio" title="Omnicanal" accent="y agéntica.">
            <p>Tus agentes siguieron trabajando mientras no estabas.</p>
          </AuthAside>
        }
      >
        <PasswordInput id="pw-latidia" value="" onChange={() => {}} autoComplete="current-password" />
        <button type="button" className="h-10 rounded-full bg-primary font-semibold text-primary-foreground">
          Entrar
        </button>
      </AuthSplit>
    </OnHtml>
  ),
}
