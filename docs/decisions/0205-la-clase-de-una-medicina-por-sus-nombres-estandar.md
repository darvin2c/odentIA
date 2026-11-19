# 0205 · La clase de una medicina se reconoce por sus nombres estándar

Fecha: 2026-11-18 · Estado: aceptada · Precisa ADR 0072 (la sustancia de la lista o «sin codificar») y ADR 0143 (el aviso de la receta por código ATC)

## Problema

Las marcas «Anticoagulante» y «Medicina para los huesos», el aviso de la cirugía y los riesgos del consentimiento salen del código ATC de la medicina. La medicación habitual solo lo tenía si se elegía de la lista por su DCI exacta. Lo que se escribe a mano casi nunca es eso: «alendronato 70 mg semanal», «Eliquis», «Sintrom 4 mg». Quedaba sin código, la franja decía «no se le preguntó» y la exodoncia no avisaba la osteonecrosis. Al mismo tiempo, reconocer una clase por cualquier palabra escrita es adivinar: «la pastilla del hueso» no dice qué medicina es.

## Decisión y motivo

- **Cada medicina de la lista habitual lleva sus otros nombres estándar como datos** (`HabitualMedicationEntry.names`), igual que las alergias llevan sus sinónimos: la DCI de la OMS, el nombre con que se escribe en el Perú y Latinoamérica («alendronato») y la marca registrada («Fosamax»). Todos llevan al código ATC de la DCI. Por ahora, los anticoagulantes, los antiagregantes y las medicinas para los huesos de la lista (grupos ATC B01A y M05B).
- **Lo escrito se reconoce si empieza por uno de esos nombres, entero, seguido de lo que no es una letra** (la dosis o la frecuencia), con `matchHabitualMedication`. Gana el nombre más largo. Un trozo («alendro», «ácido»), un nombre dentro de otro texto o un texto cualquiera no se reconoce: queda «sin código», como antes.
- **Lo escrito se conserva siempre**; solo se llena el código. Lo guardado antes del cambio recibe su código con la migración 0150, con los mismos nombres (una prueba compara las dos listas). Lo que la persona declaró (`patient_health_declaration`) no se toca.
- Es la misma regla para guardar los antecedentes, lo que declara la persona, la receta y la pantalla de elegir la medicina.

## Alternativas descartadas

- *Reconocer la clase al leer, por el nombre:* obliga a cambiar unos quince lectores, entre ellos la copia FHIR, que emitiría como codificado lo escrito a mano.
- *Sumar solo «alendronato»:* deja fuera «Eliquis», «Sintrom» o «Prolia», que tienen la misma causa.
- *Una regla por palabra o por expresión:* adivina, y lo que adivina mal marca a alguien con una clase que no tiene.

## Consecuencias

- La persona que escribe su medicina como la conoce queda con su marca y sus avisos, sin elegir de la lista.
- Hay más filas con código: la receta avisa más duplicados.
- Una marca nueva se agrega como dato de la lista, con su fuente. Quedan fuera, anotados: la aspirina diaria frente a la analgésica (B01AC06 frente a N02BA01) y los antiangiogénicos.

## Referencias

- `packages/clinical/src/allergens.ts` (`HABITUAL_MEDICATIONS`, `matchHabitualMedication`).
- `packages/db/drizzle/0150_medicinas_por_su_nombre.sql`.
- WHO Collaborating Centre for Drug Statistics Methodology, *ATC/DDD Index*; Ruggiero SL y col., *J Oral Maxillofac Surg* 2022;80:920-943 (AAOMS 2022).
