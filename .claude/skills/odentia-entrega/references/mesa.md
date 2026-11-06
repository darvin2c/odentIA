# La mesa

Cinco voces critican el cambio. Sirve para encontrar a tiempo lo que sería caro corregir después, no para aprobar: una voz simulada no es una clínica real ni prueba que algo sea fácil o seguro. Lo que diga la mesa nunca se presenta como evidencia.

Su lugar es decidir qué construir y mirar la pantalla real. Para buscar errores en código ya escrito no rindió más que un solo revisor: eso es la etapa 6.

## Cada voz por separado

Si una sola cabeza escribe las cinco seguidas, termina de acuerdo consigo misma, y el novato ya entiende lo que el experto explicó. Por eso cada voz corre como subagente aparte, sin ver a las otras. Sin subagentes: escribir cada voz completa antes de empezar la siguiente, y el novato primero.

La mesa no debe costar más que el cambio. El novato no lee el repositorio, clínica lee solo lo que necesite, y las voces corren con menos esfuerzo si la herramienta lo permite (`effort: "lower"`). Desarrollo es quien lee el código a fondo. Hay un tope de subagentes a la vez: si la mesa corre junto a otros trabajos largos, lanzar las voces cuando haya lugar y no reemplazarlas escribiéndolas seguidas.

## Lo que recibe cada una

Una ficha corta: actor, tarea y resultado observable; de dónde viene (enlace al lienzo, pedido o error); a qué producto afecta; y lo ya decidido, que no se reabre. Además, lo que dice cada voz abajo.

## Las voces

### Desarrollo

Conoce el código de este repositorio y lo lee: el `AGENTS.md` del área, los servicios y `packages/auth/src/permissions.ts`.

- ¿Ya existe algo que sirva? ¿Qué operación de negocio lo hace?
- ¿Lo prometido se puede hacer, y con qué permiso?
- ¿Qué se rompe? ¿Hay migración? ¿Cómo queda en odentIA y en latidIA?
- ¿Qué parte cuesta mucho y aporta poco?

Cita `archivo:línea`.

### Clínica

Odontólogo en odentIA, médico en latidIA, los dos si el cambio es común. Piensa en un día real de consulta.

- ¿Dónde estorba o ayuda en plena atención?
- ¿Qué riesgo clínico trae? Alergias, menores con apoderado, firmas, recetas.
- ¿Quién debe ver esto y quién no?
- ¿Los términos son los que se usan? ¿Hay un estándar internacional o nacional?

Marca como **supuesto** lo que depende de cómo trabaja una clínica y no tiene fuente: lo tendrá que confirmar una persona real. Lo legal lo deja como pendiente, no da visto bueno jurídico.

### Experto en UX

Diseñador de producto con experiencia en software clínico. Lee el objetivo de la UX del `AGENTS.md` raíz y `.claude/skills/odentia-ux/SKILL.md`, mira el lienzo o las capturas y puede consultar los componentes que ya existen en `packages/ui-patterns`. No lee servicios ni permisos: eso es de desarrollo.

Juzga si el cambio es fluido e intuitivo para quien lo va a usar (el odontólogo o el médico, recepción, caja o el paciente) y dice para quién.

- **Fluido:** ¿cuántos pasos hay hasta el resultado? ¿Algo interrumpe la atención, obliga a cambiar de pantalla o pide decidir sin necesidad?
- **Intuitivo:** ¿lo frecuente se descubre sin que nadie lo explique? ¿Lo poco frecuente está a mano sin estorbar? ¿Las palabras son las de quien lo usa, no las técnicas?
- **Qué se puede y qué no:** ¿cada límite se dice donde ocurre y con la salida, en vez de un botón que desaparece sin motivo?
- **Coherente:** ¿se comporta como el resto de odentIA? ¿Funciona en el celular, con teclado y con lector de pantalla?

A diferencia del novato, propone cómo resolverlo: qué quitar, mover, agrupar o decir, y con qué patrón existente.

### Novato

La persona menos técnica que tocará esto: la recepcionista que además atiende el teléfono, quien cobra en caja, o el paciente en su celular. Dice cuál es.

Recibe solo lo que esa persona vería: capturas, tableros del lienzo o, si aún no existen, una descripción en sus palabras. No recibe código, nombres técnicos ni la justificación del cambio, porque entenderla le quitaría la utilidad.

Cuenta en primera persona qué haría, paso a paso: «¿qué significa esto?», «¿qué aprieto?», «¿ya se guardó?», «¿por qué me pide esto?». Señala dónde se detiene, qué palabra no entiende, qué botón no apretaría y qué quitaría. No propone soluciones técnicas.

### Auditor

Desconfía del valor y pide pruebas. Puede leer el código y los permisos.

- Aplica la pregunta del `AGENTS.md` raíz: qué valor aporta al cliente o al equipo, cómo se integra con lo existente y si justifica la complejidad.
- A cada elemento: qué problema real resuelve y por qué no basta lo que ya hay. ¿Hay un caso real o una suposición?
- Busca promesas sin servicio o sin permiso, cosas que están porque otros CRM las tienen, pasos que traban el trabajo diario y estados que confunden pendiente con confirmado.

Puede concluir «no hacerlo» o «hacer solo esta parte».

## Lo que devuelve cada voz

Hasta 5 hallazgos, el más grave primero. Cada uno: qué, a quién afecta, qué propone (quitar, cambiar o mantener) y su sustento (`archivo:línea`, captura o «supuesto»). Sin elogios ni resumen. Si no encuentra nada serio, lo dice: inventar un problema para cumplir hace más daño que no decir nada.

## Reunir

1. Comprobar en el código lo que las voces afirman del código y los permisos: pueden equivocarse con mucha seguridad.
2. Si dos voces chocan (la clínica pide un campo que el novato quitaría), una sola ronda de respuesta entre esas dos.
3. Decidir con este orden: seguridad clínica y permisos primero, después lo más simple que cumpla. Un problema real pesa más que uno hipotético.
4. Lo que sigue dependiendo del producto va al usuario, con una recomendación.

## El acta

Se le muestra al usuario, en lo posible en menos de 8 líneas, y va como tablero si hay lienzo y en «Decisiones y límites que quedan» del PR.

```markdown
**La mesa**
- **Se queda:** …
- **Se quita:** … (por qué)
- **Cambia:** …
- **Por confirmar con una clínica real:** …
- **Para tu decisión:** … (solo si hay; con recomendación)
```

## La segunda mesa

Después de implementar, sobre la pantalla real (etapa 7). Solo experto en UX, novato y auditor, y clínica si el cambio es clínico.

- **Experto en UX:** recibe las capturas de escritorio y móvil, la tarea y el acta. ¿Quedó fluido e intuitivo en la pantalla real, no solo en el lienzo? ¿Cada límite se dice donde ocurre?
- **Novato:** recibe las capturas de escritorio y móvil y la tarea, otra vez sin explicación, y cuenta qué haría.
- **Auditor:** recibe las capturas, el acta y el diff. ¿Volvió algo que se quitó? ¿Entrega el valor prometido? ¿Entró algo sin motivo?

Lo que traba se corrige ahora. Lo demás se anota como pendiente en el PR.
