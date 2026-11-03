---
name: odentia-qa
description: Recorrer odentIA y latidIA como QA, en un navegador real y con cinco voces (novato, clínica, desarrollo, auditor y diseño UX), para encontrar errores y mejoras que las pruebas no ven, proponer cómo simplificar lo que cuesta, confirmarlos y dejarlos listos para corregir. Usar para una ronda periódica o cuando pidan «haz QA», «revisa esta pantalla buscando problemas» o «navega por la app a ver qué falla», aunque no haya un cambio nuevo. No usar para probar un cambio propio antes de su PR (eso es odentia-entrega) ni para medir la calidad de Sofi, Clío o Argos.
---

# QA de odentIA y latidIA

Una ronda recorre un área en la demo de producción. Encuentra, confirma e informa, pero no corrige: cada arreglo va después por `odentia-entrega`, porque un QA que corrige de paso mezcla cambios y deja de mirar. Las rutas parten de la raíz del repositorio.

## Reglas de toda ronda

- **En producción, solo dentro de la demo fija de cada producto** (ADR 0096: creada desde la administración, marcada «Demo» y sin cobro). Nunca en otra clínica: ahí hay pacientes reales. Las demos y sus cuentas por rol están en `~/odentia-qa/demos.md`.
- **Ningún mensaje sale de la demo.** En producción los envíos son reales, así que hay dos barreras:
  - **Canales apagados.** El WhatsApp de la demo está deshabilitado (claves falsas) y no hay correo, Messenger, Instagram ni Telegram conectados. Ninguna voz conecta, edita ni prueba un canal. Esta barrera también cubre a los pacientes que trae la demo.
  - **Solo datos que no llegan a nadie.** Todo teléfono que crea la ronda es del rango que el Reino Unido reserva para ficción, `+44 7700 900000` a `+44 7700 900999`. Todo correo es `@example.com`.
- **El modelo es el real.** Su costo no pesa. Lo que responden Sofi, Clío o Argos se mira como parte de la pantalla; su calidad la mide su auditoría.
- **El repositorio es público, y una ronda no publica nada.** Todo va primero al informe privado. Un issue solo se crea para lo que el usuario apruebe, y nunca para un fallo de permisos, de aislamiento entre clínicas o de datos (etapa 5).
- **Una voz simulada no prueba que algo sea fácil.** Lo que depende de cómo trabaja una clínica real se marca como supuesto. La pantalla sí es real: lo que se reproduce, pasa.

## 1. Elegir el área

Una ronda, un área: una pantalla o un recorrido que cruza varias, como «de la primera cita al cobro». Ir a fondo en poco encuentra más que pasar por todo.

Si pidieron un área, esa. Si no, la que hace más tiempo no se recorre, según `~/odentia-qa/recorrido.md`. El mapa de pantallas son los temas de `packages/services/src/help-guide.ts` y `packages/services/src/medical/help.ts`, que una prueba compara con las rutas reales. No hace falta otro inventario.

Los archivos de la ronda van fuera del repositorio, porque es público, en `~/odentia-qa/<fecha>/`: `comun.md` con lo que todas las voces necesitan (direcciones, cuentas, reglas de datos y formato de hallazgo), un informe por voz y `capturas/`.

## 2. Preparar la demo

1. «Volver a empezar» la demo desde la administración, para que cada ronda parta de lo mismo. La administración puede pedir segundo factor; si la ronda no puede entrar, pedírselo al usuario.
2. Con la cuenta de propietario, comprobar las dos barreras: el WhatsApp deshabilitado y ningún otro canal conectado. Si algo está conectado, la ronda no empieza.
3. Anotar el commit que está en producción. Desarrollo y la confirmación leen el código de ese commit (`git show <commit>:<ruta>`), no el de la rama local.

**El aislamiento entre clínicas se prueba en local**, con `pnpm dev` y `pnpm --filter @odentia/services seed:dev` (`docs/development.md`, contraseña `Demo1234`). En producción, intentar entrar a otra clínica leería historias reales si el fallo existiera. Encender la app en local usa unos 8 GB: mirar antes la memoria libre.

## 3. Recorrer

Las voces entran una a una, cada una como subagente aparte, en este orden: novato, clínica, desarrollo, auditor y diseño UX. Comparten la demo, cada una con su propia sesión del navegador. El novato no sabe lo que los demás encontraron, y diseño UX va al final porque trabaja sobre los tropiezos de las demás. Qué hace cada una está en `references/voces.md`.

**Navegador.** Cada voz abre su propio contexto aislado (en chrome-devtools, `new_page` con `isolatedContext`), para que las sesiones no se mezclen; el navegador de Playwright puede estar tomado por otra sesión. Se escribe tecleando, no llenando el campo de golpe (`fill_form`): React no ve ese cambio y produce falsas alarmas.

Cada hallazgo lleva:

- **Qué le pasa a la persona**, en sus palabras.
- **Pasos exactos** para repetirlo, con cuenta, producto y ancho de pantalla.
- **Qué esperaba y qué pasó**, con captura y errores de consola o red.
- **Tipo:** `error` (no hace lo que dice, muestra algo falso o se rompe) o `mejora` (funciona, pero cuesta).
- **Gravedad:** alta (dinero, datos clínicos, permisos o perder trabajo), media (traba la tarea) o baja (molesta).

## 4. Confirmar

Las voces se equivocan con seguridad, y una lista con falsas alarmas se deja de leer. La confirmación la hacen agentes nuevos: uno lee el código y otro repite en pantalla los errores altos.

1. Repetir los pasos en una sesión limpia. Lo que no se repite se descarta y se cuenta. Lo que no se puede repetir en la demo queda «leído, sin reproducir».
2. Buscar la causa en el código, con `archivo:línea`.
3. Mirar si es a propósito en el `AGENTS.md` del área o en un ADR, o si viene de cómo se armó la demo (`packages/services/src/demo-build.ts` y las semillas de Reportes). Si es a propósito y sigue pareciendo mal, se informa como mejora citando esa decisión.
4. Probarlo en el otro producto, si el código es común.
5. Buscar si ya existe entre los issues abiertos.

## 5. Informar

Nada se hace público hasta que el usuario decida. Un error clínico también da pistas a quien lo lea, y quien clasifica qué es delicado es un agente que puede equivocarse.

**Informe de la ronda:** un lienzo privado, Artifact de tipo Design como los de `odentia-entrega`, sin compartirlo con nadie. Sus archivos van en `.tmp/qa-lienzo/` del repositorio (ignorado por git), porque el Artifact solo publica desde el directorio de trabajo. Tableros:

- **Resumen:** qué se recorrió, con qué roles y anchos, qué no se alcanzó a ver y cuántas alarmas se descartaron.
- **Uno por error alto**, con sus capturas: qué le pasa a la persona, los pasos, lo esperado, la causa, a qué producto afecta.
- **Seguridad, aparte:** permisos, aislamiento o datos que llegan a quien no debe. Se avisa enseguida, nunca llega a un issue y el tablero se quita antes de compartir el lienzo.
- **Medios y bajos** juntos, **mejoras**, y **descartadas y a propósito**, para no volver a reportarlas.
- **Propuestas de diseño UX**, con el antes y el después en pasos y saltos. No se reproducen, pero se confirma que el permiso y el servicio que suponen existen.

**`~/odentia-qa/recorrido.md`:** una fila con la fecha, el área, el commit, los productos, los roles, el enlace del lienzo y el resultado: errores y mejoras confirmados, cuántos solo vio la pantalla, tropiezos del entorno y tokens gastados. Cuando el usuario responda, anotar cuántas propuestas de UX aprobó; si en dos rondas no aprueba ninguna, esa voz se quita.

El mensaje final, en palabras simples: qué se recorrió, cuántos errores y mejoras se confirmaron, y por cuáles empezar con el motivo. Termina preguntando cuáles corregir y cuáles publicar como issue. Nada se corrige ni se publica sin esa respuesta.

**Issue, solo con el sí:** uno por cada hallazgo aprobado, con las etiquetas `qa`, `bug` o `enhancement`, y su `área: …`. Lleva el texto del informe, sin capturas ni datos de personas, porque es público.

## 6. Cerrar

La demo queda como está: la próxima ronda la vuelve a empezar. Cerrar las páginas del navegador que abrió la ronda. Si se encendió algo en local, apagar `pnpm dev`, borrar los contenedores propios y devolver lo que las herramientas reescriben (`routeTree.gen.ts`). Los contenedores de otras sesiones no se tocan.
