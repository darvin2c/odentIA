import { describe, expect, it } from "vitest"
import { withoutGuide } from "./figures"
import latidiaDeck from "./latidia/deck.html?raw"
import odentiaDeck from "./odentia/deck.html?raw"

describe("la presentación que reciben las clínicas", () => {
  for (const [name, deck] of [["odentIA", odentiaDeck], ["latidIA", latidiaDeck]] as const) {
    it(`${name}: sale sin el guion ni su botón, con todas sus partes`, () => {
      const out = withoutGuide(deck)
      expect(deck).toContain('<aside class="notes">')
      expect(out).not.toContain('<aside class="notes">')
      expect(out).not.toContain("Guion (N)")
      expect(out).not.toContain('id="notesPanel"')
      expect(out.match(/<section class="slide"/g)?.length).toBe(deck.match(/<section class="slide"/g)?.length)
      // El resto de los controles sigue.
      expect(out).toContain('id="next"')
      expect(out).toContain('id="full"')
    })
  }
})
