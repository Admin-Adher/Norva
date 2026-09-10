---
language: "es"
source_slug: "cold-start-or-warm-start-measure-the-right-tv-launch"
source_sha256: "1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb"
title: "Arranque en frío o semicaliente: por qué una app de TV se abre de forma distinta"
seo_title: "Arranque de apps de TV: compara el tiempo de carga con rigor"
meta_description: "¿Por qué una app de TV se abre rápido una vez y luego tarda? Distingue arranques en frío, relanzamientos, primera imagen y navegación útil con un ejemplo de tiempos."
excerpt: "Volver desde Inicio no es necesariamente un lanzamiento nuevo. Compara el mismo estado inicial y distingue una imagen visible de una navegación que realmente responde."
topic_cluster: "Rendimiento de Smart TV"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Arranque en frío o semicaliente: por qué una app de TV se abre de forma distinta

> **En resumen:** Una app de TV puede empezar de cero, reconstruir una pantalla utilizando estado conservado o volver con gran parte de su interfaz aún en memoria. Son trabajos distintos. Compara condiciones iniciales idénticas y mide tanto la primera imagen de la app como la navegación utilizable con el mando. Ver un logotipo no demuestra que el catálogo esté listo.

Esta guía es para un espectador que quiere describir tiempos de apertura irregulares, no para puntuar un televisor frente a un objetivo universal de velocidad. Los sistemas operativos de TV pueden gestionar procesos de forma invisible. Cuando no puedas verificar el estado interno, registra lo que hiciste en lugar de inventar una etiqueta técnica.

## Define cuatro estados

Android documenta los arranques en frío (**cold**), semicalientes (**warm**) y en caliente (**hot**). Un arranque cold crea la aplicación desde cero; uno warm realiza parte del trabajo de inicio con estado conservado; uno hot lleva al primer plano una actividad conservada. Volver a una pantalla dentro de la aplicación es una observación de navegación independiente, no una cuarta categoría de arranque de Android.

Para un registro práctico de TV, distingue estas cuatro situaciones observables:

| Situación que puedes registrar | Qué te indica | Qué sigue siendo desconocido |
|---|---|---|
| Lanzamiento tras un reinicio oficial del televisor | El sistema se reinició antes de abrir la app | Cuánto retardo corresponde a la preparación del sistema o de la red |
| Relanzamiento tras salir con Atrás | Se salió de la app mediante su control normal | Si se conservó su proceso o pantalla |
| Regreso después de pulsar Inicio y esperar 30 segundos | Hubo un intervalo breve en segundo plano | Si el sistema mantuvo viva la app |
| Regreso a Películas desde otra pantalla de la app | La navegación permaneció dentro de la app | Qué recursos del catálogo o de las imágenes se reutilizaron |

La [guía por capas](/blog/smart-tv-media-app-performance-a-layer-by-layer-guide/) separa el ciclo de vida de la red y el renderizado.

## Define dos puntos de finalización

El primer fotograma visible puede aparecer antes de que funcione el foco, se carguen las imágenes o responda la navegación. Registra «primer fotograma de la app» y «pantalla utilizable» por separado. Añade «imágenes estables» solo cuando esa sea la pregunta. TTID y TTFD de Android distinguen la visualización inicial de la disponibilidad completa, pero tu cronometraje manual del mando a la pantalla no es automáticamente ninguna de esas métricas instrumentadas.

No detengas el reloj en el hito más favorable.

## Fija el contexto

Registra el modelo de TV, sistema operativo, versión de la app, fuente de entrada, estado de alimentación, salida, ruta por cable o Wi-Fi, hora, descripción de la sesión que proteja los datos de la cuenta, disponibilidad de la fuente y actividad en segundo plano. Mantén comparables los estados de red y fuente.

El cronometraje manual debe indicar la incertidumbre del tiempo de reacción.

## Aportación original: protocolo de lanzamiento

Los valores siguientes son **ejemplos didácticos ficticios, no mediciones de Norva**. Un espectador utiliza un televisor, una versión de app, una cuenta y un catálogo. Cada prueba empieza al pulsar el mando para abrir la app. «Utilizable» significa que la pantalla prevista es visible, responde un movimiento de la cruceta y no queda ninguna capa superpuesta bloqueante. Los tiempos son segundos desde ese mismo evento inicial.

| Prueba | Preparación observada | Primer fotograma de la app | Navegación utilizable | Imágenes estables |
|---|---|---|---|---|
| A | Reinicio oficial; inicio del televisor y red listos | 1.8 s | 4.6 s | 6.2 s |
| B | Inicio, esperar 30 segundos, volver | 0.7 s | 1.2 s | 1.9 s |
| C | El mismo regreso tras un intervalo breve | 0.8 s | 1.4 s | 2.0 s |
| D | Repetir la preparación utilizada para A | 1.9 s | 4.4 s | 6.0 s |

Las dos observaciones posteriores al reinicio alcanzan una navegación utilizable en 4.4–4.6 segundos, mientras que los regresos breves tardan 1.2–1.4 segundos. Eso sugiere una diferencia repetible entre esas preparaciones. **No** establece cuánto tiempo ahorró una caché concreta, no demuestra un estado de proceso warm o hot ni predice el resultado de otro televisor.

La observación útil para soporte es la diferencia entre el primer fotograma y la navegación que responde en A y D. Llamar a la app «lista en 1.8 segundos» ocultaría esa diferencia. El cronometraje manual también incluye el error de reacción del observador: no interpretes una décima de segundo de diferencia como una mejora de rendimiento sin una medición más precisa.

## Establece un estado en frío de forma segura

Utiliza solo las indicaciones oficiales para detener la app, reiniciar el televisor o gestionar la alimentación. No desconectes la corriente, utilices menús de servicio ni borres datos solo para crear un estado en frío. Si la plataforma no permite verificar que no está en ejecución, llámalo «lanzamiento tras reinicio».

La seguridad y la integridad del dispositivo tienen prioridad sobre la pureza del experimento.

## Establece un estado de arranque semicaliente

Ninguna secuencia genérica de Inicio o Atrás garantiza un estado de proceso warm. Si no puedes verificarlo mediante la instrumentación de la plataforma, registra un **regreso tras un intervalo breve**: llega a la misma pantalla, sal mediante el control documentado, espera un intervalo fijo y vuelve. Anota si la pantalla, el foco o las imágenes persistieron sin asignar una etiqueta de ciclo de vida no verificada.

El estado conservado puede cambiar entre pruebas, así que conserva en el registro las recargas inesperadas.

## Invierte el orden y deja descanso

Usa la secuencia tras reinicio, regreso breve, regreso breve, tras reinicio cuando sea práctico, con intervalos de descanso fijos. Invertir el orden puede revelar un patrón compatible con cambios de caché, temperatura, red o fuente; no identifica la causa. No realices decenas de lanzamientos: define de antemano un número pequeño.

La instrumentación puede establecer con más precisión el estado del proceso y los límites temporales, pero un espectador no necesita modo de desarrollador ni registros privados para informar de un retardo visible repetible.

## Interpreta las diferencias

Un arranque warm más rápido que uno cold puede reflejar estado conservado o recursos en caché, pero no cuantifica qué caché intervino. Un warm que se comporte como un cold puede reflejar cierre de la app, actualización, presión de memoria o una decisión de implementación.

Registra las pérdidas repetidas de posición o recargas inesperadas como observaciones, no como prueba de que el televisor necesita más memoria. Si solo parece lento trasladar el visionado entre pantallas, identifica primero el mecanismo en la [guía de continuidad, duplicación y envío de contenido](/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/).

## Compara después de un cambio

Tras actualizar la app, repite el mismo protocolo y documenta el contexto de versión. Conserva las notas de antes y después en lugar de confiar en la memoria. No compares un antiguo lanzamiento tras reinicio con un nuevo regreso breve.

El comportamiento de lanzamiento de Norva en TV depende del dispositivo, la versión y la fuente conectada. Norva es un reproductor para medios compatibles que estás autorizado a utilizar, no un catálogo incluido. Estos ejemplos no certifican su velocidad de lanzamiento ni su rendimiento de reproducción.

## Controla el orden de las pruebas y la disponibilidad

Las pruebas en frío suelen hacerse primero, por lo que el mantenimiento de inicio, la reconexión de red o la preparación del observador pueden penalizarlas injustamente. Alterna el orden entre sesiones cuando la plataforma permita un estado documentado y espera el mismo intervalo fijo antes de cada inicio. Registra si la pantalla de inicio, el mando, la red y la salida ya estaban listos.

Define «utilizable» antes de cronometrar: por ejemplo, la pantalla prevista es visible, el foco responde una vez y no queda ninguna capa superpuesta bloqueante. No termines de medir solo porque aparece un logotipo. Informa de la mediana únicamente junto con los valores individuales y el intervalo; un resumen único puede ocultar un lanzamiento bloqueado o fallido que importe más que una pequeña diferencia media.

## Preguntas frecuentes

### ¿Encender el televisor es lo mismo que arrancar la app en frío?

No. Incluye el inicio del sistema y puede restaurar el estado de la app de forma distinta.

### ¿Cuántas pruebas hacen falta?

Utiliza varias ejecuciones predefinidas suficientes para mostrar el intervalo sin forzar el dispositivo o la fuente.

### ¿La carga completa de las imágenes debe definir el lanzamiento?

Solo si la tarea es la disponibilidad de las imágenes; mantén separados el primer fotograma y el foco utilizable.

## Tu siguiente paso

[Obtén ayuda con un problema reproducible de lanzamiento en TV](https://norva.tv/support). Incluye el modelo de TV, las versiones del sistema operativo y de la app, los pasos de preparación, la pantalla esperada y ambos hitos temporales. Deja fuera de las capturas los identificadores de cuenta, las direcciones de las fuentes y las credenciales.

## Fuentes

- [Android Developers: tiempo de inicio de las aplicaciones](https://developer.android.com/topic/performance/vitals/launch-time)
- [Ayuda de Google TV: solucionar la lentitud de un dispositivo Google TV](https://support.google.com/googletv/answer/12364830?hl=en)
