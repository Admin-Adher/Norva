---
language: "es"
source_slug: "legibility-and-readability-two-different-viewing-problems"
source_sha256: "1b55217a33e5761ed80d94c9865abae96810f3ab7ef102102082a65f06d9dd9b"
title: "Legibilidad y facilidad de lectura: dos problemas distintos al mirar"
seo_title: "Legibilidad y comprensión: dos ejemplos multimedia ilustrados"
meta_description: "Distingue reconocer una etiqueta de comprenderla. Dos ejemplos controlados y una tarea repetible permiten describir barreras de lectura en teléfono o TV."
excerpt: "Una distinción basada en tareas entre reconocer caracteres y controles, y comprender con eficacia palabras, jerarquía, etiquetas y disposición."
topic_cluster: "Comodidad visual y accesibilidad"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Legibilidad y facilidad de lectura: dos problemas distintos al mirar

> **En pocas palabras:** La legibilidad («legibility») se refiere a reconocer los caracteres individuales de un texto. La facilidad de lectura («readability») se refiere a la facilidad con que alguien lee y comprende ese texto. En una interfaz multimedia usamos la misma distinción práctica para separar reconocer etiquetas y estados de controles de entender su agrupación y la tarea. Letras claras no garantizan una decisión clara; una disposición lógica puede contener texto difícil de distinguir.

Un diagnóstico equivocado produce correcciones débiles. Aumentar el texto puede mejorar la legibilidad pero generar recortes que dificulten la lectura; simplificar etiquetas puede facilitar el barrido visual sin corregir un contraste bajo.

## Observa la diferencia con las mismas palabras

Primero compara las dos versiones de **“Episode 18”** (Episodio 18) de abajo. Palabras, fuente, tamaño y fondo son idénticos; solo cambia el contraste del texto. La pregunta es «¿puedo identificar bien el número?». Esto aísla una posible barrera de reconocimiento. No mide la velocidad de lectura ni reproduce un entorno real de visionado.

Después compara **“Audio English Subtitles Off”** (Audio Inglés Subtítulos Desactivados) con esas mismas palabras en dos filas. Cada palabra sigue siendo clara, pero cambia la agrupación. Pregunta «¿English es el ajuste de audio o el de subtítulos?». La tarea ahora es asociar etiquetas con valores, no reconocer letras.

![Una pareja de contraste repite Episode 18 con texto tenue y brillante. Otra muestra Audio English Subtitles Off en una línea y después Audio: English y Subtitles: Off, con las parejas etiqueta-valor alineadas.](/assets/blog/legibility-readability-paired-example.svg "Ejemplos explicativos originales, no capturas de la interfaz de Norva. El texto se repite en el artículo para que la imagen no sea la única forma de entenderlos.")

La segunda disposición es una posible mejora, no una solución cuya superioridad se haya demostrado con mediciones. Otro idioma, un valor más largo o una pantalla más estrecha pueden cambiar el resultado. La guía de accesibilidad cognitiva del W3C respalda agrupación y espaciado claros; aplicar esas ideas sigue requiriendo probar la tarea real.

## Prueba la legibilidad directamente

Pide al espectador identificar:

- letras o números similares;
- el significado de un icono junto a su etiqueta;
- un control con foco frente a uno seleccionado;
- un estado activo frente a uno no disponible;
- metadatos a distancia normal;
- puntuación y marcas de hablante en los subtítulos.

Registra errores y esfuerzo, no solo si acaba respondiendo.

## Prueba la facilidad de lectura mediante tareas

Pide al espectador:

- recorrer una fila y elegir un título;
- entender un grupo de filtros;
- leer una sinopsis y metadatos;
- comparar versiones;
- navegar por un diálogo y confirmar la acción prevista;
- volver al contexto anterior.

Una tarea revela problemas de jerarquía, agrupación, redacción, densidad y secuencia.

## Usa esta ficha de diagnóstico doble

| Capa | Prueba | Resultado | Barrera | Variable candidata |
|---|---|---|---|---|
| Legibilidad | Identificar caracteres/estado del control | Correcto/problema | Tamaño, contraste, forma, foco | Un factor |
| Facilidad de lectura | Completar tarea de navegación/lectura | Correcto/problema | Densidad, jerarquía, redacción, redistribución | Un factor |

Vuelve a probar una variable candidata cada vez.

## Factores habituales de legibilidad

Tamaño, forma y grosor de los caracteres, espaciado, contraste, reflejos, distancia, tratamiento de bordes y renderizado de pantalla pueden afectar al reconocimiento. Estados diferenciados solo por color pueden hacer indistinguibles los controles aunque el texto se lea.

Usa el entorno real en vez de una captura ampliada.

## Factores habituales de facilidad de lectura

Etiquetas largas, metadatos repetidos, encabezados débiles, términos incoherentes, controles amontonados, mala agrupación, un orden de foco inesperado y una redistribución defectuosa pueden dificultar la comprensión de la interfaz.

La facilidad de lectura depende del idioma y la tarea. Involucra a usuarios que dominen los idiomas para contenido multilingüe.

## Prueba la interacción entre ambas

Aumenta el tamaño del texto un paso admitido. Si los caracteres se aclaran pero los controles se superponen o desaparece contenido, la mejora de legibilidad ha revelado una barrera de redistribución. Registra el ajuste y el elemento ausente o superpuesto, en vez de revertir el ajuste del usuario y declarar resuelto el problema.

Compara con el mismo título, idioma, tarea, ventana de visualización y método de entrada. Primero pide identificar una etiqueta o estado concreto; después, usarlo para completar la tarea. Registra el tiempo de identificación solo si medirlo es útil y acompáñalo de la explicación del espectador. Adivinar rápido no demuestra que el elemento fuera claro. Si un cambio mejora el reconocimiento pero aumenta errores de navegación, documenta ambos resultados en lugar de reducirlos a una sola aprobación o fallo.

Para los iconos, prueba el símbolo y su etiqueta visible juntos antes de juzgarlo solo. La familiaridad puede hacer evidente un símbolo ambiguo a un revisor experimentado. Un usuario nuevo u ocasional puede depender de la etiqueta, la posición y la jerarquía circundante.

## Incluye el entorno

Reflejos, distancia, iluminación y ángulo de pantalla pueden reducir la legibilidad aparente y aumentar el esfuerzo. Usa [la guía de ergonomía de interfaces de TV](/blog/tv-interface-ergonomics-guide/) para incluir distancia y método de entrada en la comparación. Ante un foco poco claro, [la lista de mando y cruceta direccional](/blog/remote-dpad-navigation-qa/) ayuda a describir adónde se movió y qué pasó después.

La [guía completa de comodidad visual](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/) relaciona estas observaciones con zoom, color, foco y movimiento.

## Evita conclusiones médicas

Pregunta qué puede identificar y completar el espectador. No expliques la dificultad mediante una condición supuesta. Una barrera reproducible de tarea permite actuar sin diagnóstico.

## Informa con precisión

Indica contexto, distancia, zoom o escala, tarea, elemento exacto, resultado esperado, error observado, solución provisional y una captura que proteja la privacidad. Sustituye «el texto es malo» por «el año y la valoración son indistinguibles a la distancia normal de la TV».

Para un informe concreto de Norva, elige un elemento de una fuente compatible propia o autorizada. Intenta encontrar su año y explica la acción prevista en esa pantalla antes de seleccionarla. Informa de qué falló: identificar el año, entender una acción o seguir el foco. Anota si ocurre en teléfono, TV o web. No incluyas identificadores de cuenta, credenciales de fuente ni títulos privados en una captura compartida; reproduce con material no sensible cuando sea posible.

## Errores habituales y limitaciones

Evita intercambiar los términos, probar a una distancia irrealmente corta, cambiar fuente y disposición a la vez y suponer que aumentar el tamaño resuelve cualquier dificultad de lectura.

La distinción es una herramienta diagnóstica, no una evaluación médica formal. Los controles actuales del producto siguen necesitando verificación oficial.

## Preguntas frecuentes

### ¿Puede un texto ser legible pero difícil de leer?

Sí. Los caracteres pueden ser claros mientras una redacción densa, una jerarquía débil o una mala disposición dificultan la tarea.

### ¿Puede una disposición comprensible contener controles ilegibles?

Sí. La secuencia puede tener sentido mientras el texto pequeño, el bajo contraste o un foco poco claro ocultan elementos individuales.

### ¿Qué problema conviene corregir primero?

Aborda los fallos bloqueantes de reconocimiento y tarea según su impacto y vuelve a probar, porque cambiar una capa puede afectar a la otra.

## Tu siguiente paso

[Envía un informe reproducible de barrera de lectura a soporte de Norva](https://norva.tv/support) con la ficha doble anterior. Una pantalla exacta, una tarea y una dificultad observada dan al equipo algo que investigar sin adivinar la causa.

## Fuentes

- [W3C: hacer el contenido utilizable para personas con discapacidades cognitivas y de aprendizaje](https://www.w3.org/TR/coga-usable/)
- [W3C: contraste mínimo](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [Funciones de Norva](https://norva.tv/#features)
