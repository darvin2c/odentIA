---
name: odentia-qa
description: Recorrer odentIA, latidIA y vistIA como QA, en un navegador real y con cinco voces (novato, clínica, desarrollo, auditor y diseño UX), para encontrar errores y mejoras que las pruebas no ven, supervisar cada proceso clínico contra su catálogo, proponer cómo simplificar lo que cuesta, confirmarlos y dejarlos listos para corregir. Usar para una ronda periódica o cuando pidan «haz QA», «revisa esta pantalla buscando problemas», «revisa la atención como un odontólogo», «revisa el examen de la vista», «¿esto sirve para atender?», «navega por la app a ver qué falla» o «lanza la mesa sobre…» un área, aunque no haya un cambio nuevo. También la llama odentia-entrega antes de pedir el sí, y sus voces son la mesa de odentia-entrega. No usar sola para probar un cambio propio (eso lo hace odentia-entrega, que la llama) ni para medir la calidad de Sofi, Clío o Argos.
---

# QA de odentIA, latidIA y vistIA

Una ronda recorre un área en la app. Encuentra, confirma y **deja listo para programar**: por cada cosa que hay que corregir, la solución ya revisada por las voces, sus casos con criterio y el lienzo de las pantallas que cambian. No corrige: cada arreglo va después por `odentia-entrega`, porque un QA que corrige de paso mezcla cambios y deja de mirar. Pero una ronda que solo deja la lista de problemas no sirve: obliga a otra pasada antes de poder programar. Las rutas parten de la raíz del repositorio.

Se corre de dos maneras:

- **Ronda**, la que pide el usuario o la periódica: un área, en local o en una demo de producción. Termina con el informe y el paquete para programar, en un lienzo privado. Son los apartados 1 a 7.
- **Antes de entregar**, la que llama `odentia-entrega` con el cambio ya hecho y antes de pedir el sí: sobre la rama, en local. Usa las mismas voces y la misma confirmación, con lo que cambia en el apartado 8.

Las voces y su método están en `references/voces.md`. Cómo se las convoca y se las conduce está en `references/mesa.md`: una ronda es la mesa sobre un área, sin cambio, y por eso también responde a «lanza la mesa sobre…». La voz clínica supervisa cada proceso con los catálogos `references/clinica/odontologia.md` (odentIA), `references/clinica/medicina.md` (latidIA), `references/clinica/optica.md` (vistIA) y `references/clinica/comunes.md` (lo que rodea a la atención en todos), y en cada revisión busca los flujos que los catálogos todavía no tienen.

## Reglas de toda ronda

- **La ronda no pregunta.** Si falta un acceso (segundo factor, contraseña, una demo sin marcar), no se detiene a pedirlo: usa la alternativa permitida por esta skill (local, apartado 2) y lo anota en el informe. Solo se frena ante lo que esta skill marca como prohibido, nunca por comodidad.
- **Una decisión de producto se le lleva al usuario como pregunta, con sugerencia.** Al informar, cada una se le pregunta de forma concreta, con la opción que se recomienda y su motivo. No vale dejar «pendiente» o «espera tu sí» sin pregunta ni sugerencia.
- **Sin recomendación no hay pregunta.** Solo se pregunta cuando la decisión ya está estudiada y es del usuario. Lo que espera otra cosa (un informe, una ronda en curso, una confirmación) se dice como lo que es: qué falta y qué sigue. No se pregunta si esperar, en qué orden ir ni nada que la ronda puede decidir sola, y una respuesta no se cierra con preguntas por costumbre.
- **Lo que es un error se corrige; no se pregunta.** Se anota en qué orden se corrige y por qué. Solo se le pregunta al usuario lo que es una decisión de producto: quitar, agregar o cambiar algo que funciona.
- **En producción, solo dentro de una demo que la ronda crea para sí misma** desde la administración (ADR 0096: marcada «Demo» y sin cobro). Nunca en una clínica real, ni en las cuentas del usuario. Al terminar, la ronda elimina su demo y verifica que la eliminación sea completa. Las demos de cada ronda se anotan en `~/odentia-qa/demos.md`.
- **Ningún mensaje sale de la demo.** En producción los envíos son reales, así que hay dos barreras:
  - **Canales apagados.** El WhatsApp de la demo está deshabilitado (claves falsas) y no hay correo, Messenger, Instagram ni Telegram conectados. Ninguna voz conecta, edita ni prueba un canal. Esta barrera también cubre a los pacientes que trae la demo.
  - **Solo datos que no llegan a nadie.** Todo teléfono que crea la ronda es del rango que el Reino Unido reserva para ficción, `+44 7700 900000` a `+44 7700 900999`, y dentro de él del tramo `+44 7700 900800` a `900999`: las semillas de las demos no lo usan, así que no choca con un contacto que ya existe. Todo correo es `@example.com`.
- **El modelo es el real.** Su costo no pesa. Lo que responden Sofi, Clío o Argos se mira como parte de la pantalla; su calidad la mide su auditoría.
- **El repositorio es público, y una ronda no publica nada.** Todo va primero al informe privado. Un issue solo se crea para lo que el usuario apruebe, y nunca para un fallo de permisos, de aislamiento entre clínicas o de datos (etapa 5).
- **Una voz simulada no prueba que algo sea fácil.** Lo que depende de cómo trabaja una clínica real se marca como supuesto. La pantalla sí es real: lo que se reproduce, pasa.
- **Ninguna decisión esconde un problema.** Si algo está mal, se informa aunque un ADR o un `AGENTS.md` diga que es a propósito. Va con su gravedad real, cita la decisión, dice por qué falla en uso y cómo debería hacerse correctamente, con la fuente o el estándar que lo respalda. Una decisión escrita explica por qué pasa, pero no lo descarta. Lo mismo vale para la demo: lo que está mal en ella se informa para corregirlo, porque es lo que ve una clínica al conocer el producto.

## 1. Elegir el área

Una ronda, un área: una pantalla o un recorrido que cruza varias, como «de la primera cita al cobro». Ir a fondo en poco encuentra más que pasar por todo.

Si pidieron un área, esa. Si no, la que hace más tiempo no se recorre, según `~/odentia-qa/recorrido.md`. El mapa de pantallas son los temas de `packages/services/src/help-guide.ts` y `packages/services/src/medical/help.ts`, que una prueba compara con las rutas reales. No hace falta otro inventario.

Los archivos de la ronda van fuera del repositorio, porque es público, en `~/odentia-qa/<fecha>/`: `comun.md` con lo que todas las voces necesitan (direcciones, cuentas, reglas de datos y formato de hallazgo), un informe por voz y `capturas/`.

## 2. Preparar la demo

1. **Por defecto, la ronda corre en local** con `pnpm dev` y `pnpm --filter @odentia/services seed:dev`: no pide 2FA, no hay canales reales y no se toca producción. Antes de empezar, comprobar que hay memoria libre para levantar la app, dependencias instaladas y que Podman responde; si algo falta, el informe lo dice y la ronda no se atasca. Producción queda para una comprobación final, solo cuando el usuario lo pida: entonces se crea una demo para la ronda desde la administración (nombre con `QA` y la fecha), nunca una clínica existente, y se borra al terminar.
2. Comprobar que el modelo es el real: en `infra/dev/.env`, que `LLM_MODEL` no sea `fake` y que estén las claves del modelo y del modelo de decisión (`docs/development.md`, «Modelo real» y «Modelo de decisión»). Un `.env` copiado de otra entrega suele venir con el modelo de prueba. Si no se puede, el informe lo dice arriba y nada de lo que contesten la Ayuda, Sofi, Clío o Argos cuenta como hallazgo.
3. Con la cuenta de propietario, comprobar las dos barreras: el WhatsApp deshabilitado y ningún otro canal conectado. Si algo está conectado, la ronda no empieza.
4. Anotar el commit que está en producción. Desarrollo y la confirmación leen el código de ese commit (`git show <commit>:<ruta>`), no el de la rama local.

**El aislamiento entre clínicas se prueba en local**, con `pnpm dev` y `pnpm --filter @odentia/services seed:dev` (`docs/development.md`, contraseña `Demo1234`). En producción, intentar entrar a otra clínica leería historias reales si el fallo existiera. Encender la app en local consume memoria: mirar antes la memoria libre disponible.

## 3. Recorrer

La ronda la conduce un moderador, que es la sesión principal, como dice `references/mesa.md`: lee antes el código del área, arma el expediente, guarda los pendientes conocidos sin pasarlos a las voces, elige qué voces entran y con qué modelo y esfuerzo cada una, y les da una ficha neutra, sin sospechas ni preguntas. Cada voz arma sus propios casos, recorre de punta a punta y hace sus giras: así encuentra por su cuenta, y no solo lo que se le pidió mirar. Al terminar la confirmación, el moderador cruza lo encontrado con los pendientes guardados: los que la ronda no volvió a encontrar se informan igual, marcados «no visto por la ronda».

Las voces entran una a una, cada una como subagente aparte, en este orden: novato, clínica, desarrollo, auditor y diseño UX. Comparten la demo, cada una con su propia sesión del navegador. El novato no sabe lo que los demás encontraron, y diseño UX va al final porque trabaja sobre los tropiezos de las demás. Qué hace cada una, y con qué método, está en `references/voces.md`: cada subagente recibe «Para todas» y su apartado enteros, las reglas de las voces de `mesa.md` y `comun.md`, no un resumen, porque el resumen es lo que vuelve genérica a una voz. Diseño UX recibe además los informes de las demás.

**La voz clínica entra siempre que el área toque datos o decisiones clínicas** y recibe además el catálogo de su producto y `comunes.md`. Antes de empezar, la ronda le pasa la lista de procesos del catálogo que el área toca, para que ninguno quede sin revisar, y la voz hace su barrido de flujos que faltan.

**Navegador.** Cada voz abre su propio contexto aislado (en chrome-devtools, `new_page` con `isolatedContext`), para que las sesiones no se mezclen; el navegador de Playwright puede estar tomado por otra sesión. Se escribe tecleando, no llenando el campo de golpe (`fill_form`): React no ve ese cambio y produce falsas alarmas.

Cada hallazgo lleva:

- **Qué le pasa a la persona**, en sus palabras.
- **Pasos exactos** para repetirlo, con cuenta, producto y ancho de pantalla.
- **Qué esperaba y qué pasó**, con captura y errores de consola o red.
- **Tipo:** `error` (no hace lo que dice, muestra algo falso o se rompe) o `mejora` (funciona, pero cuesta).
- **Gravedad:** alta (dinero, datos clínicos, seguridad del paciente, permisos o perder trabajo), media (traba la tarea) o baja (molesta).
- **Proceso clínico**, si es de uno del catálogo: su código (`P-ODO-06`) y la comprobación que falla.
- **Causa**, si la conoce, y si comparte causa con otros hallazgos.

## 4. Confirmar

Las voces se equivocan con seguridad, y una lista con falsas alarmas se deja de leer. La confirmación la hacen agentes nuevos: uno lee el código y otro repite en pantalla los errores altos.

1. Repetir los pasos en una sesión limpia. Lo que no se repite se descarta y se cuenta. Lo que no se puede repetir en la demo queda «leído, sin reproducir».
2. Buscar la causa en el código, con `archivo:línea`.
3. Mirar si es a propósito en el `AGENTS.md` del área o en un ADR, o si viene de cómo se armó la demo (`packages/services/src/demo-build.ts` y las semillas de Reportes).
   - **A propósito y sigue mal:** no se descarta ni se le baja la gravedad. Se informa como error o mejora, según lo que le pasa a la persona, marcado «decisión a revisar: <ADR o regla>». Cuenta lo que decidió, por qué falla y cómo debería hacerse correctamente. Si para saberlo hace falta estudiar el tema (otros programas, normas o fuentes clínicas), se estudia y se cita.
   - **A propósito y está bien:** se descarta, con el motivo.
   - **De la demo:** se informa como error de la demo, con su causa en la semilla, para corregirla.
4. Probarlo en el otro producto, si el código es común.
5. Buscar si ya existe entre los issues abiertos.

## 5. Dejar listo para programar

La ronda no termina al confirmar. Con lo confirmado, el moderador arma las entregas y las deja listas, siguiendo `references/mesa.md` desde «La propuesta»:

1. **Agrupar en entregas.** Por causa raíz, no por hallazgo: lo que sale de la misma causa se corrige junto. Cada entrega es un PR que se puede unir solo. Entran los errores altos, los de seguridad y las causas raíz, y las mejoras de diseño UX que valgan lo que cuestan. Los medios y bajos sueltos se suman a la entrega de su causa o quedan en la lista, con el motivo. Se dice el orden y por qué.
2. **La propuesta de cada entrega.** Qué se hace, en palabras de la persona, con lo que el confirmador encontró en el código. Si cambia una pantalla o un recorrido, diseño UX la arma con los pasos contados.
3. **La segunda vuelta.** Desarrollo, el auditor y un novato nuevo recorren los casos con la propuesta puesta, y clínica si toca lo clínico. Aquí aparece lo que la propuesta rompe, lo que le falta y lo que es más grande de lo que parecía. Lo que resulte grande se separa en su propia entrega, y se dice.
4. **El acta de cada entrega**, con el formato de `mesa.md`: lo que cambia, los casos con su criterio, el mismo dato en qué lugares, «En la Ayuda», lo que queda fuera y, si hay, lo que pide migración o un paso en producción.
5. **El lienzo.** Si una entrega cambia una pantalla o un recorrido, sus tableros llevan el antes (captura real) y el después de cada pantalla, con la skill `odentia-ux`. No es opcional: el usuario decide viendo la pantalla, no leyéndola. Una entrega que no cambia nada visible no lleva tableros de pantalla.
6. **Las decisiones.** Lo que depende del producto se le pregunta al usuario una vez, todo junto, cada cosa con su recomendación. Con su respuesta, las actas quedan cerradas.

Con eso, `odentia-entrega` empieza a programar sin otra mesa: recibe el acta y el lienzo ya aprobados. Si la ronda no alcanzó a dejar lista una entrega, lo dice con lo que falta; no la presenta como lista.

## 6. Informar

Nada se hace público hasta que el usuario decida. Un error clínico también da pistas a quien lo lea, y quien clasifica qué es delicado es un agente que puede equivocarse.

**Informe de la ronda:** un lienzo privado, Artifact de tipo Design como los de `odentia-entrega`, sin compartirlo con nadie. Sus archivos van en `.tmp/qa-lienzo/` del repositorio (ignorado por git), porque el Artifact solo publica desde el directorio de trabajo. Tableros:

- **Resumen:** qué se recorrió, con qué roles y anchos, qué no se alcanzó a ver y cuántas alarmas se descartaron.
- **Procesos clínicos**, si entró la voz clínica: la tabla de estado por proceso (listo, sirve con trabas, no sirve, no se pudo ver), con las comprobaciones que fallan y el caso donde se vio. Debajo, el recorrido largo etapa por etapa (primera consulta, plan, ejecución, fin del plan, seguimiento y vuelta), con lo que se perdió al pasar de una a otra. Es lo que el usuario supervisa.
- **Causas raíz:** lo que explica varios hallazgos a la vez, con la propuesta de rediseño en vez de corregir pieza por pieza.
- **Uno por error alto**, con sus capturas: qué le pasa a la persona, los pasos, lo esperado, la causa, a qué producto afecta.
- **Seguridad, aparte:** permisos, aislamiento o datos que llegan a quien no debe. Se avisa enseguida, nunca llega a un issue y el tablero se quita antes de compartir el lienzo.
- **Medios y bajos** juntos y **mejoras**. Lo que está mal por una decisión va aquí, o en su tablero de error alto, según su gravedad, con la decisión citada y cómo debería ser.
- **Errores de la demo**, con su causa en la semilla.
- **Descartadas**, para no volver a reportarlas: solo las falsas alarmas y lo que es a propósito y está bien, cada una con su motivo.
- **Propuestas de diseño UX**, con el antes y el después en pasos y saltos. No se reproducen, pero se confirma que el permiso y el servicio que suponen existen.
- **Listo para programar:** un grupo de tableros por entrega, en el orden en que se harían: el acta, el antes y el después de cada pantalla que cambia, y las decisiones que esperan, numeradas y con su recomendación. Es lo primero que ve el usuario después del resumen.
- **Para el catálogo:** los procesos y comprobaciones clínicas que la ronda encontró y el catálogo no tiene, con el texto listo para sumarlo. Igual para el catálogo de cada una de las otras voces (`references/catalogos/`): flujos, comprobaciones y medidas nuevas, y lo que se le escapó a cada una.

**`~/odentia-qa/recorrido.md`:** una fila con la fecha, el área, el commit, los productos, los roles, el enlace del lienzo y el resultado: errores y mejoras confirmados, procesos clínicos por estado, cuántos solo vio la pantalla, tropiezos del entorno y, por voz, modelo, esfuerzo, tokens y hallazgos confirmados. Lleva también lo que pide «La mesa aprende» de `references/mesa.md`. Cuando el usuario responda, anotar cuántas propuestas de UX aprobó; si en dos rondas no aprueba ninguna, esa voz se quita.

El mensaje final, en palabras simples: qué se recorrió, cuántos errores y mejoras se confirmaron, y por cuáles empezar con el motivo. Nombra cada decisión que produce un problema y cómo debería ser. Dice qué entregas quedaron listas para programar, en qué orden y qué resuelve cada una, y cuáles no se alcanzaron a dejar listas. Lista qué candidatos a issue hay. Cierra con las decisiones que esperan del usuario, cada una como pregunta y con la opción sugerida: con su respuesta se puede empezar a programar. Nada se corrige en esta ronda y nada se publica como issue sin que el usuario lo pida.

**Issue, solo con el sí:** uno por cada hallazgo aprobado, con las etiquetas `qa`, `bug` o `enhancement`, y su `área: …`. Lleva el texto del informe, sin capturas ni datos de personas, porque es público.

## 7. Cerrar

Lo de «Para el catálogo» no se escribe en el repositorio durante la ronda: queda en el informe y lo suma la próxima entrega que toque esa área, o un PR propio si el usuario lo pide. Así el catálogo crece con cada ronda sin que la ronda cambie nada.

Si la ronda creó una demo en producción, la elimina desde la administración (solo borra demos: ADR 0096, «Borrar demo») y después verifica que la eliminación sea completa: que la demo ya no aparece en la lista, que su dirección no abre y que su fila en `admin.saas_demo` ya no existe. Si la verificación falla, se informa tal cual, sin dar la ronda por cerrada. Cerrar las páginas del navegador que abrió la ronda. Si se encendió algo en local, apagar `pnpm dev`, borrar los contenedores propios y devolver lo que las herramientas reescriben (`routeTree.gen.ts`). Los contenedores de otras sesiones no se tocan.

## 8. Antes de entregar

Cuando la llama `odentia-entrega` (su etapa 7), con el cambio ya implementado, probado y revisado. Su trabajo es ver el cambio en la pantalla real, como lo usará la gente, antes de pedir el sí. Corre siempre, también en un cambio chico. Respecto de la ronda, cambia esto:

- **Dónde.** En local, con `pnpm dev` sobre la rama y `pnpm --filter @odentia/services seed:dev`, en cada producto al que llega si el cambio es común (vistIA, en su rama mientras no esté en `main`). Desarrollo lee el código de la rama, no el de producción. No se crea demo en producción.
- **Qué área.** Lo que el cambio toca y los recorridos vecinos que puede haber roto. La entrega le pasa el acta de la mesa y la lista de lo cambiado, pero no al novato.
- **Los criterios del acta.** Las voces recorren en la pantalla cada caso del acta y marcan su criterio: cumple, no cumple o no se pudo ver. Ese es el piso; después cada voz recorre lo suyo, con sus propios casos. El novato recibe los casos como tareas, sin el criterio.
- **La Ayuda.** Nadie más lo comprueba, así que es parte del piso: el novato le pregunta cómo se hace cada caso, y el auditor compara lo que contesta con la pantalla y con lo que el acta dijo en «En la Ayuda». Si el auditor no entra por el tamaño del cambio, lo hace desarrollo. Una función nueva que la Ayuda no explica es algo que este cambio dejó a medias.
- **Qué voces.** Las de la tabla «Por dónde entra cada cambio» de `odentia-entrega`, y clínica siempre que toque datos o decisiones clínicas. El modelo y el esfuerzo de cada una se eligen como dice `references/mesa.md`. Si el cambio no tiene efecto visible, entra al menos desarrollo, que recorre en la pantalla lo que el cambio podría haber roto.
- **Confirmar**, igual que en el apartado 4, con agentes nuevos.
- **Informe.** Sin lienzo ni issues: un informe en `~/odentia-qa/<fecha>-entrega-<rama>/` y un resumen para el PR. Cada hallazgo confirmado va a uno de estos grupos:
  - **Lo rompió o lo dejó a medias este cambio:** la entrega lo corrige en el mismo PR. Después, un verificador nuevo repite en pantalla solo esos pasos, hasta que todos pasan.
  - **Ya estaba antes:** queda como pendiente en el PR y en la memoria, sin mezclarlo con lo pedido. Un fallo de permisos, de aislamiento o de datos no se escribe en el PR, porque el repositorio es público: va solo al informe privado y se le avisa al usuario.
  - **Decisión de producto:** va a la parada del sí, como pregunta con su recomendación.
  - **Para el catálogo:** se suma a `references/clinica/` o al catálogo de la voz en `references/catalogos/`, en el mismo PR.
- **Una fila en `~/odentia-qa/recorrido.md`**, marcada «antes de entregar» y con el número del PR.
