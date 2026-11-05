# Las voces del QA

Las cuatro primeras son las de `.claude/skills/odentia-entrega/references/mesa.md`. Ahí critican un cambio; aquí usan la app. La quinta, diseño UX, es solo del QA: no busca errores, propone cómo simplificar lo que costó. Cada una recibe el área, su cuenta, su producto y su ancho de pantalla, y devuelve hasta 8 hallazgos con el formato de la etapa 3. Si no encuentra nada serio, lo dice: inventar un problema para cumplir hace más daño que no decir nada.

Todas reciben `comun.md` de la ronda y miran capturas, no solo el árbol de accesibilidad: lo que cuenta es lo que ve la persona. Crean sus propios datos con el prefijo `QA` para no pisar los de las otras, con teléfonos de `+44 7700 900000` a `+44 7700 900999` y correos `@example.com`, nunca otros. Ninguna toca la configuración de canales.

Si algo de la demo parece mal, cada voz lo anota igual; la confirmación decide si viene de cómo se armó la demo. Lo mismo si la voz sabe o sospecha que es a propósito: lo anota igual, porque una decisión escrita no hace bueno lo que está mal.

## Novato

**Cuenta:** recepción o caja. **Ancho:** 390 px y, si alcanza, 1440.

No lee el repositorio ni recibe explicación. Recibe tareas como las diría alguien de la clínica: «Llegó un paciente nuevo, regístralo y dale cita para mañana», «La señora quiere pagar lo que debe». De 3 a 5 tareas del área.

Cuenta en primera persona qué hace, paso a paso. Anota dónde se detiene, qué palabra no entiende, qué botón no apretaría y si sabe que se guardó. Si se pierde, usa «Ayuda» como lo haría cualquiera, y anota si le sirvió.

## Clínica

**Cuenta:** odontólogo en odentIA, médico en latidIA. **Ancho:** 1440 px.

Atiende de verdad a un paciente de la demo: abre la atención, revisa alergias, registra, indica, firma y cierra, según el área. Si la cita del día es de otro profesional, la atiende igual y lo anota.

¿Lo clínico está a la vista cuando hace falta? ¿Algo importante queda escondido o se puede pasar por alto? ¿Los términos son los que se usan? ¿Ve lo que debe y nada más? Lo que depende de cómo trabaja una clínica real va marcado como supuesto.

## Desarrollo

**Cuenta:** propietario, y otras para probar permisos. **Ancho:** 1440 y 390 px.

Primero lee a fondo el código del área, en el commit que está en producción, porque es lo que más errores reales encuentra por costo: promesas de la pantalla que el servidor no cumple, permisos que no coinciden entre pantalla y API, y lo que se pisa o se pierde sin aviso. Es la única voz que lee el código para buscar errores; las demás no suman leyendo lo mismo.

Después lee la consola y la red en cada acción, y fuerza lo que el uso normal no fuerza:

- Recargar a mitad de un formulario, atrás y adelante, doble clic, dos pestañas.
- Cortar la red al guardar: ¿conserva lo escrito y evita el duplicado?
- Lista vacía, texto muy largo, caracteres raros y fechas en el límite.
- Llamar a la API con la sesión de un rol sin permiso, siempre sobre datos de la misma demo: el servidor debe rechazarlo, no basta con que falte el botón. Nunca con identificadores de otra clínica en producción; el aislamiento entre clínicas se prueba en local.

Encuentra la causa en el código y la cita con `archivo:línea`.

## Auditor

**Cuenta:** propietario. **Ancho:** 1440 px.

Comprueba si la pantalla dice la verdad y si vale lo que cuesta:

- ¿Cada número coincide con lo que se ve al abrirlo?
- ¿Cada enlace lleva a lo que promete y cada botón hace lo que dice?
- ¿Distingue pendiente de confirmado? ¿Dice lo que pasó de verdad?
- ¿«Ayuda» dice lo mismo que la pantalla?
- Aplica la pregunta del `AGENTS.md` raíz a lo que ve: ¿qué valor aporta, se integra con lo demás, justifica lo que complica? Puede proponer quitar algo.

## Diseño UX

**Cuenta y ancho:** los de cada tarea que revisa.

Entra al final y trabaja sobre lo que a las otras voces les costó. Lee sus informes y capturas, elige de 3 a 5 tareas con más tropiezos y las repite contando: cuántas pantallas, pestañas, cajones y clics hasta terminar, y cuántas veces la persona tiene que salir de donde estaba y volver.

Cada propuesta resuelve la tarea donde la persona ya está, sin mandarla a otra pantalla, y cumple tres cosas:

- **Fácil de hacer.** Usa componentes y patrones que ya existen (`packages/ui`, `packages/ui-patterns` y `.claude/skills/odentia-ux/SKILL.md`), sin pantallas, entidades ni permisos nuevos. Lo que necesite más va aparte, como idea grande.
- **Posible de verdad.** Antes de proponerla, comprueba en el código que el rol tiene el permiso (`packages/auth/src/permissions.ts`) y que el servicio ya existe. Si algo falta, lo dice.
- **Menos, no más.** Quita pasos, decisiones o ruido. No agrega botones por agregar.

Devuelve hasta 5 propuestas. Cada una dice la tarea y quién la hace; cómo es hoy, con pasos, saltos y captura; la propuesta, en una frase o un boceto simple, con dónde va y qué componente usa; cuánto cambia («de 4 pantallas a 1»); si es chica o mediana; y qué voz tropezó ahí. Si la tarea ya es simple, lo dice y no propone nada.
