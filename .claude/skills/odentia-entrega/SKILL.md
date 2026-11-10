---
name: odentia-entrega
description: Llevar un cambio de odentIA o latidIA de punta a punta en un solo PR, hasta que esté unido y desplegado en producción. Cubre discutirlo en la mesa con las cinco voces de odentia-qa (novato, clínica, desarrollo, auditor y diseño UX), hacer el lienzo si hace falta, simplificar, implementar, probar, revisar, pasar la QA de odentia-qa antes de entregar, abrir el PR, pedir el sí, unir y seguir el despliegue. Usar cuando se aprueba un lienzo («aprobado», «empieza», «implementa el lienzo»), cuando piden construir una función nueva o corregir un error reportado, aunque no mencionen PR ni merge. No usar para preguntas, ideas o estudios sin construir, ni para una etapa suelta como «corre las pruebas» o «revisa este diff».
---

# Entregar un cambio

El recorrido de un cambio desde que se decide hasta que está en producción. Es un método: las reglas siguen en el `AGENTS.md` de cada área, que se lee antes de tocarla. Las rutas parten de la raíz del repositorio.

Una entrega es un solo PR y termina cuando ese PR está unido y su despliegue comprobado (etapa 11), no cuando se abre. Todo lo pedido va en ese PR: no se divide en entregas ni en fases, ni se deja la segunda mitad para otra sesión.

Pedir esta skill autoriza crear la rama, hacer commits, subirla y abrir el PR. No autoriza unir: unir despliega a producción sin ningún otro paso, y por eso se pide aparte (etapa 10). Con el sí, la misma sesión une, sigue el despliegue y cierra, sin otra parada.

Si el trabajo ya empezó, ubicar la etapa por el lienzo, la rama, el PR y el CI, y seguir desde ahí sin repetir lo hecho.

## Cuándo se detiene

Solo en estos casos. En el resto sigue sin pedir permiso y, al hablar con el usuario, dice qué cambia para la persona, no qué archivo tocó.

- La mesa deja una decisión que depende del producto.
- Hay un lienzo nuevo: espera el visto bueno antes de programar.
- Un lienzo aprobado choca con una regla vigente o con los permisos, o se equivoca en algo de dinero o firmas: lo dice con el caso concreto y propone cómo seguir. Una diferencia menor se resuelve y se informa, sin detenerse, porque el usuario ya dijo «empieza».
- Se va a gastar en una medición con modelo real: dice cuántas rondas y el costo aproximado.
- Hay que tocar algo real a mano: producción, mensajes a personas, contenedores de otras sesiones.
- Todo está listo para unir. Es la última parada: después del sí no se vuelve a esperar.

Cada parada pide una sola cosa, con una recomendación, para que se pueda responder en una línea. El detalle de las voces queda en el acta. Lo que depende de una respuesta pendiente no se planea archivo por archivo hasta tenerla.

## Por dónde entra cada cambio

| Qué llega | Mesa | Lienzo | QA antes de entregar |
|---|---|---|---|
| Lienzo aprobado | Completa, para buscar lo que falta o choca; lo ya decidido no se reabre | Ya está | Las cinco voces |
| Función nueva que cambia una pantalla o un recorrido | Completa | Si hay más de una forma razonable | Las cinco voces |
| Función pequeña dentro de un patrón que ya existe, o mover algo de lugar | Corta: quien hace la tarea (el novato en su rol) y desarrollo | No | Novato, desarrollo y diseño UX |
| Error | Corta, solo si el arreglo cambia lo que ve o hace la persona: las voces a las que afecte | No | Desarrollo y las voces a las que afecte |
| Cambio interno, sin efecto visible | Sin mesa | No | Desarrollo |

Los tamaños de la mesa están en `.claude/skills/odentia-qa/references/mesa.md`. Cualquier cambio sube de tamaño si toca dinero, firmas, datos clínicos o permisos, o si lo va a ver otro rol.

Las voces son las de `.claude/skills/odentia-qa/references/voces.md`. Clínica entra siempre que el cambio toque datos o decisiones clínicas, en la mesa y en la QA, con el catálogo de procesos de su producto.

Un error se explica antes de arreglarlo: qué le pasó a la persona, si es un error y de qué (falló el modelo o falló una regla nuestra), en palabras simples. Si la causa todavía no está comprobada, se dice así. Si afecta a una persona real, se dice primero quién debe avisarle; el agente no le escribe sin permiso. Después se arregla sin esperar respuesta, salvo que el arreglo sea una decisión de producto. Lo que ya está comprobado que es falso se corrige aunque la causa del caso siga en duda.

## Las etapas

Cada etapa aplica solo si el cambio la necesita; la que se salta se dice en el PR.

### 1. La mesa

Las voces de `odentia-qa` recorren el cambio antes de dibujar o programar. El proceso entero está en `.claude/skills/odentia-qa/references/mesa.md` y se sigue desde ahí; el método de cada voz, en `voces.md`. Sirve para encontrar a tiempo lo que sería caro corregir después, no para aprobar: una voz simulada no es una clínica real, y lo que diga la mesa nunca se presenta como evidencia. Para buscar errores en código ya escrito, la mesa no rinde más que un solo revisor: eso es la etapa 6.

En corto:

1. **El moderador** es esta sesión. Lee el código del área, recorre el caso principal en la pantalla de hoy, decide el tamaño de la mesa (sin mesa, corta o completa) y el modelo de cada voz, guarda los pendientes conocidos y arma una ficha neutra por voz.
2. **Primera vuelta, el problema:** quienes viven la tarea la recorren en la pantalla de hoy, con sus propios casos. Sale el banco de casos.
3. **La propuesta:** diseño UX arma una o dos formas de resolverlo, o es el lienzo.
4. **Segunda vuelta:** cada voz recorre los casos con la propuesta puesta y contesta su pregunta. Nadie opina sin caso.
5. **Comprobar y cruzar:** lo que se afirma del código se comprueba; dos voces que chocan se leen una vez; se cruza con los pendientes guardados. Lo que dependa del producto va al usuario, con una recomendación.
6. **El acta**, con el formato de `mesa.md`: lo que se queda, se quita y cambia, y los casos con su criterio. Se le muestra al usuario, va como tablero si hay lienzo y en «Decisiones y límites que quedan» del PR.

No se programa hasta cerrar el acta. Implementar sigue sus puntos, y la QA antes de entregar recorre sus casos.

### 2. El lienzo

Se publica como Artifact de tipo Design, con la skill `odentia-ux`: tableros numerados con el problema, el antes y el después con capturas reales de los dos productos, las decisiones numeradas con una recomendación, los casos y lo que queda fuera de este PR. Cada promesa se cruza con `packages/auth/src/permissions.ts` y con el servicio que la haría. Si se puede, se prueba la propuesta en la app y se deshace.

Espera el visto bueno. Si aprueba solo algunas decisiones, se construyen esas y las demás quedan como pendientes.

### 3. Simplificar

Escribir el plan y pasar cada elemento por dos preguntas: qué problema real resuelve y por qué no basta lo que ya hay. Lo que no responda se quita, y lo que repite otra cosa también.

Preferir lo mínimo que reutiliza lo existente. Nada obligatorio que trabe firmar, atender o cobrar: lo opcional va como aviso. Lo legal no frena el diseño; queda anotado como pendiente.

Lo que se encontró de paso y nadie pidió queda como pendiente en el PR; no se mezcla con lo pedido.

Todo lo pedido cabe en un PR. Si resulta demasiado, se recorta aquí, no se reparte: lo que sale queda como pendiente y se dice en la parada de la mesa o del lienzo, para que el usuario lo sepa antes de programar. Lo que toca dinero o firmas va en el mismo PR, en sus propios commits, y el PR lo nombra para que la revisión lo mire primero.

Quitar una columna o tabla que el código lee no cabe en un solo despliegue: `migrate` corre antes de levantar la API y el worker, y la imagen anterior se quedaría sin poder leer. Este PR deja de leerla y no la borra; borrarla queda como pendiente, para un cambio aparte cuando este ya esté en producción.

### 4. Implementar

Rama nueva desde `origin/main`, con `git fetch` antes. Commits en español: `feat(scope): descripción`.

Toda corrección y función vale para todos los productos (odentIA, latidIA y vistIA). Averiguar si la lógica vive en lo común (`packages/services`, `clinical`, `clinic-app`, `channels`) o tiene variante (`src/dental/`, `src/medical/`, `src/optical/`, `apps/dental-clinic`, `apps/medical-clinic`, `apps/optical-clinic`, `products.ts`), cubrir cada una y decir en el PR cómo quedó. Si de verdad es de un solo producto, decir por qué.

Lo que va en el mismo cambio:

| Si cambia | Va junto |
|---|---|
| Una pantalla, un botón o un permiso | La guía de Ariadna (`packages/services/src/help-guide.ts` y su variante médica) |
| Una pantalla o entidad nueva | La demo (`seed-demo.ts`, o `seed-common.ts` si sirve a los dos) |
| Una composición compartida | Su story |
| Tablas o reglas de la base | `pnpm db:generate` o una migración nueva, con su `GRANT` y RLS (`packages/db/AGENTS.md`) |
| Una variable de entorno | `turbo.json`, y su valor de producción en «Al desplegar» del PR |
| Una decisión transversal con alternativas reales | Un ADR breve (`docs/decisions/README.md`) |
| Una regla nueva que ya rige | El `AGENTS.md` del área |

Los textos que ve la gente no nombran ADR, issues ni «decisión N»; eso va en comentarios.

### 5. Probar

- Un error se reproduce primero con una prueba que falla sin el arreglo.
- Tipos y pruebas de los paquetes tocados: `pnpm --filter @odentia/<paquete> typecheck|test`.
- Si cambió una pantalla de `clinic-app` o de una app, también `pnpm --filter @odentia/ui-patterns test`. El CI del PR prueba lo que el cambio afecta (ADR 0140); si `main` no avanzó desde esa prueba, al unir despliega sin repetirla, y si avanzó, prueba lo afectado otra vez.
- Los recorridos afectados: `pnpm e2e <specs> --workers=2`.

La batería completa la corre el CI sin usar este equipo. Antes de una larga aquí, mirar cuántos contenedores de prueba quedan y no tener `pnpm dev` encendido. Prerrequisitos por plataforma: `docs/development.md`.

Lo que no corrió no pasó. Anotar lo ejecutado para el PR.

### 6. Revisar con ojos nuevos

Quien escribió el código no ve lo que dio por hecho.

- `simplify` sobre el cambio.
- `code-review` en nivel `high`, o un subagente nuevo que reciba el diff sin tus conclusiones.
- `security-review` si toca permisos, RLS, tokens, enlaces públicos o archivos subidos.

Corregir lo real y repetir las pruebas de lo que cambió. Lo que se decide no corregir va al PR con su motivo.

### 7. La QA antes de entregar

Siempre, también en un cambio chico o interno: en el papel todo parece fácil, y lo que se quitó puede haber vuelto. Con el cambio ya probado y revisado, se llama a `odentia-qa` en su manera «antes de entregar» (apartado 7 de esa skill), sobre la rama, en local y en los dos productos si el cambio es común. Las voces son las de la tabla «Por dónde entra cada cambio». La QA recibe el acta de la mesa y la lista de lo cambiado, recorre cada caso del acta y marca su criterio; el PR los lista con su resultado. Después el moderador anota cómo rindió la mesa («La mesa aprende», en `mesa.md`).

Quien implementa también sigue «Implementar y comprobar» de `odentia-ux` (entrada, acción, respuesta y recuperación; escritorio y 390 px; teclado; rechazo del servidor si toca permisos), pero eso no reemplaza a las voces: quien escribió el cambio no ve lo que dio por hecho.

Con lo que devuelve la QA:

- **Lo que rompió o dejó a medias este cambio** se corrige ahora, se repiten las pruebas de lo que cambió y un verificador nuevo repite en pantalla esos pasos hasta que pasan. No se pide el sí con un error propio abierto.
- **Lo que ya estaba antes** queda como pendiente en el PR, salvo un fallo de permisos, aislamiento o datos, que va solo al informe privado y se le avisa al usuario.
- **Las decisiones de producto** van a la parada del sí.
- **Lo que sale «Para el catálogo»** se suma a `.claude/skills/odentia-qa/references/clinica/` en este PR.

Si no se pudo abrir la pantalla, la QA lo dice y el PR lo lleva como límite. Una prueba automática no la reemplaza.

### 8. Medir a los agentes

Aplica si cambia lo que un agente lee o puede hacer: prompt, herramientas, camino o modelo. Se mide al final, sobre el código ya revisado y pasado por la QA, porque cuesta y cualquier cambio posterior lo invalida. Si solo cambia cuándo corre o algo a su alrededor, se juzga por sus pruebas y el PR explica por qué.

- Sofi: auditoría al azar con `packages/agent/src/auditoria-masiva.ts`, con los mismos casos contra `main` y en cada producto que cambia (`PRODUCTO=odentia|latidia|vistia`; los pedidos de vistIA, con `PEDIDOS=1`), y las dos versiones calificadas por un solo juez.
- Argos, Clío, el modelo de decisión y Ariadna: el `eval:*` o banco que nombra la regla en `packages/agent/AGENTS.md` o `packages/services/AGENTS.md`.
- Antes de gastar, comprobar que la medición puede ver este error. El juez de la auditoría, por ejemplo, no juzga horarios: un error de horarios se mide con casos propios, y la auditoría solo dice si el cambio hace daño.
- Comprobar que el camino cambiado corrió, con una línea que lo cuente. Si no corrió, la medición no dice nada.

El sí se pide con la medición completa y a la vista. Si no mejora, no se recomienda unir, aunque la diferencia parezca ruido: se quita lo que actúa en las conversaciones normales sin mejorarlas, o se mide de nuevo. Lo que solo actúa en casos que la auditoría no trae, como las alarmas, se juzga en sus propios casos. Un requisito del usuario o el arreglo de algo falso se queda si no muestra un daño mayor que el ruido de una ronda.

### 9. El PR

Título: `tipo(scope): lo que cambia para la persona`. Cuerpo en palabras simples, con estas secciones:

```markdown
## El problema
## Qué cambia
## Lo que no cambia
## Decisiones y límites que quedan
## Cómo se probó
## Al desplegar
```

«Cómo se probó» dice lo ejecutado y lo que no, con el resumen de la QA antes de entregar. Nada simulado cuenta como prueba de que funciona con un proveedor real, ni la mesa o la QA como prueba de que una clínica real lo encuentre fácil. «Al desplegar» dice la migración y todo paso a mano. El PR enlaza el lienzo, si lo hay.

Esperar el CI con `gh pr checks --watch`. Si falla, leer el registro y corregir la causa.

Antes de pedir el sí, ponerse al día: varias sesiones unen a la vez. Con `git fetch`, si `main` avanzó, `git merge origin/main`, sin reescribir commits. Si chocan los números de ADR o de migración, tomar el siguiente libre y, en la migración, volver a generarla sobre lo de `main`, con un `when` mayor en el journal. Esperar el CI otra vez.

### 10. Pedir el sí y unir

Con todo verde, enviar este resumen y esperar:

```markdown
**Listo para unir: <qué cambia, en una frase>**

- **Para quien lo usa:** <qué notará recepción, el clínico, caja o el paciente>
- **Se quitó:** <lo que la mesa o la simplificación sacaron>
- **Se comprobó:** <pruebas, CI>
- **La QA:** <voces que entraron, qué encontró, qué se corrigió y qué verificó en pantalla; estado de los procesos clínicos que toca>
- **No se comprobó:** <lo que falta, sin suavizar>
- **Agentes:** <resultado frente a la versión anterior, o por qué no aplica>
- **Al desplegar:** <migración y pasos a mano, o nada>

Al unir se despliega a producción. ¿Lo uno?
```

Si al pedir el trabajo dijo «únelo al terminar», ese es el sí, y el resumen se envía igual. No vale con algo en rojo ni con una medición que falta o no mejoró.

Unir con `gh pr merge <número> --squash`.

### 11. Seguir hasta producción

Unir no es llegar. `main` corre todo y recién después despliega. Seguir la corrida con `gh run list --branch main --limit 5` y `gh run watch <id>`.

- `deploy` en `skipped`: falló algo en `main` y no llegó nada. Decirlo enseguida en palabras simples y corregirlo con un PR de arreglo, desde la etapa 4. Es el único otro PR que abre la entrega, y no termina hasta que ese arreglo despliega.
- `deploy` en `success` no basta: si `main` avanzó, la corrida termina bien sin desplegar y lo hace la del commit más nuevo. Mirar que el paso «Desplegar el commit verificado» haya corrido en un commit que incluya el tuyo.

Después, los pasos a mano de «Al desplegar». La semilla no corre en producción: los precios y lo incluido se cambian en los cuatro planes, y las variables de entorno se ponen allá. Pedirlo o confirmarlo antes de tocar producción.

Comprobar por fuera lo que se pueda, solo leyendo: `odentia32.com`, `latidia72.com` o su API pública. Lo que no se pueda mirar desde aquí se dice.

### 12. Cerrar

- Apagar `pnpm dev`, borrar los contenedores propios y devolver lo que las herramientas reescriben sin cambiarlo, como `apps/*/src/routeTree.gen.ts`. Los contenedores de otras sesiones no se tocan.
- Lo que quedó fuera va a la memoria y al informe como pendiente. No se empieza otro PR sin que lo pidan.
- Guardar en la memoria lo que no sale del código: decisiones pendientes y en qué va el lienzo.
- Informar: el PR unido, el commit desplegado, qué cambia para la persona, qué no se comprobó y qué quedó pendiente.
