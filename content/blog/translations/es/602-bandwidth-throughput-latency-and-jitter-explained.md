---
language: "es"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Ancho de banda, tasa de transferencia, latencia y jitter: las diferencias"
seo_title: "Ancho de banda, tasa de transferencia, latencia y jitter en vídeo"
meta_description: "Entiende ancho de banda, tasa de transferencia, latencia y jitter con un ejemplo de red de vídeo. Un test de velocidad o un límite universal de jitter puede engañar."
excerpt: "Capacidad, tasa de transferencia medida, retardo y variación del retardo responden a preguntas distintas. Interpreta una comparación de red completa antes de culpar a un número de las pausas de carga."
topic_cluster: "Bases de redes domésticas para vídeo"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Ancho de banda, tasa de transferencia, latencia y jitter: las diferencias

> **En resumen:** El ancho de banda es un concepto de capacidad disponible o nominal; la tasa de transferencia es el caudal útil medido en una prueba concreta. La latencia es el retardo, mientras que el jitter describe su variación según un método indicado. La pérdida de paquetes es otra dimensión. Uno o varios pueden afectar al vídeo, así que registra el método y la ruta antes de interpretar un número.

Cada métrica ofrece una visión parcial. Dos pruebas con la misma unidad pueden medir distintos extremos, protocolos, direcciones, duraciones, rutas o condiciones de tráfico.

## El ancho de banda no es un resultado de entrega

A menudo se usa ancho de banda como sinónimo abreviado de velocidad, pero las etiquetas de capacidad no indican cuántos datos de aplicación llegaron durante un intervalo concreto. Los enlaces compartidos, la sobrecarga de protocolo, la congestión, las condiciones de radio, los límites del dispositivo y el extremo remoto pueden reducir la tasa de transferencia observada.

La velocidad del plan, la del enlace Wi-Fi, la etiqueta de Ethernet y la tasa de transferencia de una aplicación son, por tanto, valores distintos. Registra cuál muestra una pantalla antes de compararlo con otro.

## La tasa de transferencia necesita un contexto de prueba

La tasa de transferencia es un caudal medido. RFC 6349 describe un marco para probar la tasa de transferencia TCP y destaca la metodología de prueba. Un resultado debe acompañarse de extremo, dirección, protocolo, duración, número de conexiones, dispositivo, ruta y hora.

La [guía de bases de la red doméstica](/blog/the-complete-guide-to-home-network-basics-for-video/) describe el recorrido entre el dispositivo y la fuente. Un servidor de pruebas cercano no reproduce todas las rutas hacia fuentes autorizadas, y un pico breve no debe presentarse como rendimiento sostenido de la aplicación.

## La latencia es el retardo transcurrido

La latencia describe cuánto tardan los datos o una respuesta en recorrer una ruta medida. El retardo unidireccional necesita sincronización de relojes y considerar la incertidumbre temporal según el método de RFC 7679; muchas herramientas para usuarios finales informan, en cambio, de ida y vuelta. Esos resultados no son intercambiables.

El inicio del vídeo, los controles, la autenticación y las peticiones de segmentos pueden parecer rápidos o lentos por motivos distintos. Una tasa de transferencia medida elevada no implica automáticamente una latencia baja.

## El jitter es variación, no simplemente lentitud

RFC 3393 define métricas de variación del retardo de paquetes. En las herramientas habituales, «jitter» puede utilizar otro cálculo, dirección, intervalo o estadística. Lee la definición de la herramienta antes de comparar valores.

Una conexión puede tener una tasa de transferencia media suficiente pero llegadas irregulares de paquetes, o un retardo estable con transferencia sostenida insuficiente. Una ida y vuelta constante de 80 ms y otra que alterne entre 20 y 140 ms pueden compartir la media y comportarse de forma distinta. Esa ilustración describe variación, no una fórmula de jitter ni un límite aceptable.

## La pérdida de paquetes es otra dimensión

RFC 7680 define una métrica unidireccional de pérdida de paquetes con una metodología explícita. Los resultados de herramientas para usuarios finales pueden inferir la pérdida a partir de respuestas ausentes, y algunos dispositivos pueden dar menor prioridad al tráfico de diagnóstico. Un cero no demuestra que hayan llegado todos los paquetes de aplicación; un resultado distinto de cero necesita recurrencia y alcance.

Distingue los paquetes ausentes de los tardíos en tus notas. Una pausa de reproducción es un síntoma visible, no un diagnóstico a nivel de paquetes.

## Aportación original: diccionario de métricas

| Métrica | Pregunta en lenguaje sencillo | Contexto necesario | Qué no puede demostrar por sí sola |
|---|---|---|---|
| Ancho de banda/capacidad | ¿Qué podría transportar este enlace según su definición? | Enlace, etiqueta, dirección | Entrega de datos a la aplicación |
| Tasa de transferencia | ¿Qué caudal útil se midió? | Extremo, protocolo, duración, ruta | Todas las rutas hacia fuentes |
| Latencia | ¿Qué retardo observó el método? | Unidireccional/ida y vuelta, relojes, ruta | Capacidad sostenida |
| Jitter | ¿Cómo varió el retardo? | Fórmula, muestra, estadística | Tasa de transferencia media |
| Pérdida | ¿Qué paquetes esperados faltaron? | Tipo de sonda, dirección, intervalo | Causa exacta del problema de reproducción |

Añade unidades a cada valor y conserva los resultados brutos cuando la privacidad lo permita.

### Ejemplo completo: un plan rápido y una tarde irregular

Estos son **resultados didácticos ficticios**, no una prueba de Norva ni de una fuente. Un hogar tiene un plan anunciado como 100 Mbps. Prueba el mismo portátil en la misma ubicación Wi-Fi contra el mismo extremo cercano, con ajustes de descarga idénticos y tres ejecuciones de 30 segundos en cada periodo.

| Observación | Periodo tranquilo | Periodo de mayor uso | Interpretación |
|---|---|---|---|
| Tasa de transferencia de descarga, tres ejecuciones | 82, 80, 84 Mbps | 28, 14, 31 Mbps | La mediana baja de 82 a 28 Mbps; el intervalo del periodo de mayor uso es 14–31 Mbps |
| Mediana del retardo de ida y vuelta indicada por la herramienta, tomada bajo la misma condición de carga | 18 ms | 65 ms | Esta ruta de prueba responde más despacio en el periodo de mayor uso |
| Jitter mostrado por la herramienta, misma fórmula y configuración de muestreo | 3 ms | 24 ms | El retardo varía más según la definición de esta herramienta; no es una calificación de aprobado o suspenso |
| Vídeo autorizado durante el periodo de mayor uso | No comprobado | Dos pausas registradas | Las pausas coinciden con peores resultados, pero no se midió el extremo del vídeo |

El siguiente paso razonable es repetir a la hora del síntoma, cambiando opcionalmente solo la conexión local a Ethernet si es compatible. **No** es contratar inmediatamente un plan más rápido. Ni siquiera la muestra de 14 Mbps establece si el vídeo debería reproducirse: se desconocen los requisitos reales de la versión, las caídas breves, la ruta hacia la fuente y el comportamiento del búfer.

Distingue Mbps, megabits por segundo, de MB/s, megabytes por segundo: 8 Mbps equivalen a 1 MB/s antes de considerar la definición de sobrecarga de la medición. Los milisegundos describen tiempo, no tasa de datos. No se pueden comparar esas unidades como si un número mayor siempre significara una conexión mejor.

## Crea un pequeño conjunto de mediciones

Utiliza el dispositivo afectado en su ubicación normal. Registra tres muestras espaciadas en un periodo tranquilo y tres durante el periodo del síntoma. Cuando sea seguro y compatible, repite con un enlace local alternativo sin cambiar el extremo ni los ajustes de la prueba.

Después compara medianas, intervalos y recurrencia en lugar de elegir el mejor número. Anota subidas simultáneas, cambios de la red de malla, el estado de energía del dispositivo y el tiempo meteorológico solo cuando se observen directamente; no inventes historias causales a partir de coincidencias.

## Interpreta las combinaciones

Una tasa de transferencia sostenida baja puede vaciar el búfer de reproducción. La variación del retardo y la pérdida pueden interrumpir la entrega aunque una media breve parezca suficiente. Una latencia alta puede ralentizar secuencias de petición y respuesta sin limitar necesariamente una transferencia larga. La aplicación, el comportamiento del transporte, el diseño del búfer y la fuente determinan el impacto visible.

Si la reproducción continúa pero la imagen es mala, utiliza la [comparación de calidad de imagen](/blog/the-complete-guide-to-understanding-video-quality/) en lugar de tratar el desenfoque como prueba de una red lenta. Norva reproduce fuentes compatibles y autorizadas; no proporciona un catálogo ni controla tu router, la ruta hacia la fuente o su codificación.

## Errores habituales de interpretación

No compares bits con bytes, no confundas la velocidad del enlace con la tasa de transferencia, no llames «pérdida de paquetes» a toda variación del retardo ni trates el resultado de un único servidor como una garantía. Evita medir solo después de cambiar router, dispositivo y fuente a la vez.

## Preguntas frecuentes

### ¿Qué métrica importa más para el vídeo?

Ninguna domina siempre. El patrón de entrega de la versión, la ruta, el dispositivo y el síntoma determinan qué mediciones son pertinentes.

### ¿Puede la tasa de transferencia superar la cifra del plan?

Las etiquetas, el aprovisionamiento, los métodos de prueba, las unidades y las definiciones de sobrecarga varían. Verifica qué representa cada número antes de tratar una diferencia como un error.

### ¿Todas las herramientas miden el jitter de la misma manera?

No. Comprueba la fórmula de la herramienta, la dirección, el tipo de sonda, el periodo de muestreo y la estadística indicada.

### ¿Qué jitter es aceptable para el vídeo en streaming?

No existe un límite universal en milisegundos que certifique la reproducción de vídeo. El vídeo bajo demanda con búfer y las llamadas interactivas toleran el retardo de forma distinta; las herramientas también calculan el jitter de manera diferente. Compara resultados repetidos del mismo método con el síntoma real. Un límite publicado para una aplicación o protocolo no debe convertirse en un requisito general para Norva.

### ¿Por qué el vídeo tiene pausas de carga tras un buen test de velocidad?

La prueba puede usar otro servidor, ruta, patrón de transferencia o periodo. Puede pasar por alto interrupciones breves, y la reproducción también depende de la fuente y del dispositivo. Registra si el retardo ocurre antes del primer fotograma o durante la reproducción antes de elegir la siguiente prueba.

## Tu siguiente paso

[Relaciona tu síntoma de reproducción con la siguiente comprobación](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Incluye el dispositivo, el periodo, el método de prueba y un síntoma repetible, no las credenciales de la fuente, en cualquier solicitud de soporte.

## Fuentes

- [RFC 6349: pruebas de tasa de transferencia TCP](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: métrica de retardo unidireccional](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: métrica de variación del retardo](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: métrica unidireccional de pérdida de paquetes](https://www.rfc-editor.org/rfc/rfc7680)
