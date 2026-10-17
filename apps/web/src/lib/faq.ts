export type FaqItem = { q: string; a: string }

/** Datos estructurados schema.org de las preguntas de una página. */
export function faqJsonLd(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a },
    })),
  }
}

/** Migas de pan schema.org: [["Inicio", "/"], ["Agentes", "/agentes"]…]. */
export function breadcrumbJsonLd(site: URL | undefined, trail: [string, string][]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, path], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: new URL(path, site).toString(),
    })),
  }
}
