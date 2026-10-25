// La portada de la presentación de odentIA es la escena real de las 32 piezas de la web
// (@odentia/brand-scene); deck.js la toma de `window.BrandScene`, como cuando era un solo archivo.
// Se importan solo la escena y sus datos: el índice del paquete trae también componentes de React.
import { AGENTS, CHANS, DAY, dir, via } from "@odentia/brand-scene/hero-data"
import { ToothScene } from "@odentia/brand-scene/tooth-scene"

;(window as unknown as { BrandScene: unknown }).BrandScene = {
  AGENTS,
  CHANS,
  DAY,
  dir,
  via,
  ToothScene,
}
