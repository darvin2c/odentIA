/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Precios y condiciones comerciales de la administración (`src/middleware.ts`). */
    pricing: import("./lib/pricing").Pricing
  }
}
