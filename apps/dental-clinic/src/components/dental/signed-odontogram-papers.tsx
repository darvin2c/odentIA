import { SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/dental"
import { buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { fetchSignedOdontograms } from "../../lib/dental/odontogram"
import { useDentalProfile } from "../../lib/dental/profile"
import type { ProductPapers } from "@odentia/clinic-app/product/product-ui"

/**
 * El odontograma firmado en Documentos (NTS 188; ADR 0036): solo en clínicas
 * de Perú. Se ve e imprime con el gráfico de la norma, en su hoja, en otra
 * pestaña; fuera de Perú no hay papel ni filtro «Odontogramas».
 */
export function useSignedOdontogramPapers(patientId: string): ProductPapers {
  const signs = useDentalProfile().odontogram?.signedOdontogram === true
  const queryKey = ["odontogram-assessments", patientId]
  const query = useQuery({
    queryKey,
    queryFn: () => fetchSignedOdontograms(patientId),
    enabled: signs,
  })
  if (!signs) return { query: null, queryKey, papers: [] }
  return {
    query,
    queryKey,
    papers: (query.data?.data ?? []).map((item) => {
      const title = `Odontograma firmado · ${SIGNED_ODONTOGRAM_PURPOSE_LABELS[item.purpose]}`
      return {
        key: `odontograma-${item.id}`,
        title,
        detail: `${formatDate(item.createdAt)} · ${item.examinerName} · ${item.registrationNumber}`,
        date: item.createdAt,
        action: (
          <Link
            to="/patients/$patientId/odontogram/$assessmentId/print"
            params={{ patientId, assessmentId: item.id }}
            target="_blank"
            aria-label={`Ver ${title}`}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Ver
          </Link>
        ),
      }
    }),
  }
}
