import type { StorybookConfig } from "@storybook/react-vite"
import tailwindcss from "@tailwindcss/vite"

/**
 * Storybook del platform: maquetas con los componentes REALES (odontograma,
 * ficha de la pieza, paneles clínicos). Solo se sustituye el acceso a datos —
 * `lib/api` (transporte) y `lib/crm` (permisos y usuario del router)— por los
 * mocks de `.storybook/mocks`; tipos, cálculos clínicos y paneles son el código
 * real de la app, así que las maquetas corren sin stack ni sesión.
 *
 * El alias se resuelve por el especificador escrito (`../lib/api`,
 * `../../lib/api`, `./api`), que es lo único estable entre profundidades, y
 * apunta a los mocks por el mapa `imports` del package (`#storybook/api`), así
 * que la misma lista sirve en cualquier Storybook que compile este árbol.
 */
const DATA_MOCKS: Array<{ find: RegExp; replacement: string }> = [
  // Cualquier profundidad: `../lib/api`, `../../lib/api`, `../../../lib/api`.
  { find: /^(?:\.\.\/)+lib\/api$/, replacement: "#storybook/api" },
  { find: /^\.\/api$/, replacement: "#storybook/api" },
  { find: /^#lib\/api$/, replacement: "#storybook/api" },
  { find: /^(?:\.\.\/)+lib\/crm$/, replacement: "#storybook/crm" },
  { find: /^\.\/crm$/, replacement: "#storybook/crm" },
  { find: /^#lib\/crm$/, replacement: "#storybook/crm" },
]

const config: StorybookConfig = {
  stories: ["../src/dev/**/*.stories.tsx"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Mismo plugin de Tailwind v4 que la app: sin él `globals.css` no resuelve y
  // los componentes reales se ven sin estilos.
  async viteFinal(viteConfig) {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()]
    viteConfig.resolve = {
      ...viteConfig.resolve,
      alias: [...DATA_MOCKS, ...((viteConfig.resolve?.alias as unknown[]) ?? [])],
    }
    return viteConfig
  },
}

export default config
