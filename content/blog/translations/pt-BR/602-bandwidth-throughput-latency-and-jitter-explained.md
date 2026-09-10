---
language: "pt-BR"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Largura de banda, taxa de transferência, latência e jitter: entenda"
seo_title: "Largura de banda, taxa de transferência, latência e jitter no vídeo"
meta_description: "Entenda largura de banda, taxa de transferência, latência e jitter com um exemplo de rede para vídeo. Um teste de velocidade ou limite universal de jitter pode enganar."
excerpt: "Capacidade, taxa de transferência medida, atraso e variação do atraso respondem a perguntas diferentes. Interprete uma comparação de rede completa antes de culpar um número pelas pausas de carregamento."
topic_cluster: "Fundamentos de redes domésticas para vídeo"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Largura de banda, taxa de transferência, latência e jitter: entenda

> **Em resumo:** Largura de banda é um conceito de capacidade disponível ou nominal; taxa de transferência é a vazão útil medida em um teste específico. Latência é atraso, enquanto jitter descreve a variação do atraso segundo um método informado. Perda de pacotes é outra dimensão. Um ou vários desses fatores podem afetar o vídeo, portanto registre o método e o caminho antes de interpretar um número.

Cada métrica oferece uma visão parcial. Dois testes com a mesma unidade ainda podem medir destinos, protocolos, direções, durações, rotas ou condições de tráfego diferentes.

## Largura de banda não é um resultado de entrega

As pessoas costumam usar largura de banda como sinônimo de velocidade, mas os rótulos de capacidade não dizem quanto dado de aplicativo chegou em determinado intervalo. Links compartilhados, sobrecarga de protocolos, congestionamento, condições de rádio, limites do dispositivo e o destino remoto podem reduzir a taxa de transferência observada.

A velocidade do plano, a taxa do link Wi-Fi, o rótulo Ethernet e a taxa de transferência do aplicativo são, portanto, valores diferentes. Registre qual deles a tela mostra antes de compará-lo com outro.

## A taxa de transferência precisa de um contexto de teste

A taxa de transferência é uma vazão medida. A RFC 6349 descreve um modelo de testes de taxa de transferência TCP e destaca a metodologia. Um resultado deve vir acompanhado de destino, direção, protocolo, duração, número de conexões, dispositivo, rota e horário.

O [guia de fundamentos da rede doméstica](/blog/the-complete-guide-to-home-network-basics-for-video/) mapeia o caminho entre o dispositivo e a fonte. Um servidor de teste próximo não reproduz todas as rotas para fontes autorizadas, e um pico breve não deve ser apresentado como desempenho sustentado do aplicativo.

## Latência é o atraso decorrido

A latência descreve quanto tempo dados ou uma resposta levam para percorrer um caminho medido. O atraso em uma direção exige sincronização de relógios e consideração da incerteza de tempo segundo o método da RFC 7679; muitas ferramentas para usuários finais informam, em vez disso, ida e volta. Esses resultados não são intercambiáveis.

O início do vídeo, os controles, a autenticação e as solicitações de segmentos podem parecer rápidos ou demorados por motivos diferentes. Uma taxa de transferência medida elevada não significa automaticamente baixa latência.

## Jitter é variação, não apenas lentidão

A RFC 3393 define métricas de variação do atraso de pacotes. Nas ferramentas comuns, “jitter” pode usar outro cálculo, direção, intervalo ou estatística. Leia a definição da ferramenta antes de comparar valores.

Uma conexão pode ter taxa de transferência média suficiente, mas chegada irregular de pacotes, ou atraso estável com transferência sustentada insuficiente. Uma ida e volta constante de 80 ms e outra alternando entre 20 e 140 ms podem ter a mesma média e comportamentos diferentes. Essa ilustração descreve variação, não uma fórmula de jitter nem um limite aceitável.

## Perda de pacotes é outra dimensão

A RFC 7680 define uma métrica de perda de pacotes em uma direção com metodologia explícita. Resultados de ferramentas para usuários finais podem, em vez disso, inferir perda a partir de respostas ausentes, e alguns dispositivos podem dar menos prioridade ao tráfego de diagnóstico. Um zero informado não comprova que todos os pacotes do aplicativo chegaram; um resultado diferente de zero exige verificar recorrência e escopo.

Separe pacotes ausentes de pacotes atrasados nas suas anotações. Uma pausa na reprodução é um sintoma visível, não um diagnóstico no nível de pacotes.

## Contribuição original: dicionário de métricas

| Métrica | Pergunta em linguagem simples | Contexto necessário | O que não comprova sozinha |
|---|---|---|---|
| Largura de banda/capacidade | O que este link poderia transportar segundo sua definição? | Link, rótulo, direção | Entrega de dados ao aplicativo |
| Taxa de transferência | Que vazão útil foi medida? | Destino, protocolo, duração, rota | Todas as rotas para fontes |
| Latência | Quanto atraso o método observou? | Uma direção/ida e volta, relógios, caminho | Capacidade sustentada |
| Jitter | Como o atraso variou? | Fórmula, amostra, estatística | Taxa de transferência média |
| Perda | Quais pacotes esperados estavam ausentes? | Tipo de sonda, direção, intervalo | Causa exata do problema de reprodução |

Associe unidades a cada valor e preserve os resultados brutos quando a privacidade permitir.

### Exemplo completo: um plano rápido e uma noite instável

Estes são **resultados didáticos fictícios**, não um teste do Norva ou de uma fonte. Uma casa tem um plano anunciado como 100 Mbps. Ela testa o mesmo notebook no mesmo local do Wi-Fi contra o mesmo destino próximo, com configurações de download idênticas e três execuções de 30 segundos em cada janela.

| Observação | Janela tranquila | Janela movimentada | Interpretação |
|---|---|---|---|
| Taxa de transferência de download, três execuções | 82, 80, 84 Mbps | 28, 14, 31 Mbps | A mediana cai de 82 para 28 Mbps; o intervalo da janela movimentada é 14–31 Mbps |
| Atraso mediano de ida e volta informado pela ferramenta, obtido sob a mesma condição de carga | 18 ms | 65 ms | Este caminho de teste responde mais devagar na janela movimentada |
| Jitter exibido pela ferramenta, mesma fórmula e configurações de amostragem | 3 ms | 24 ms | O atraso varia mais segundo a definição desta ferramenta; isso não é uma nota de aprovação ou reprovação |
| Vídeo autorizado na janela movimentada | Não verificado | Duas pausas registradas | As pausas coincidem com resultados piores, mas o destino do vídeo não foi medido |

O próximo passo razoável é repetir no horário do sintoma, opcionalmente mudando apenas a conexão local para Ethernet, se houver compatibilidade. **Não** é contratar imediatamente um plano mais rápido. Nem mesmo a amostra de 14 Mbps estabelece se o vídeo deveria reproduzir: os requisitos reais da versão, as quedas curtas, o caminho da fonte e o comportamento do buffer são desconhecidos.

Separe Mbps, megabits por segundo, de MB/s, megabytes por segundo: 8 Mbps equivalem a 1 MB/s antes de considerar a definição de sobrecarga da medição. Milissegundos descrevem tempo, não taxa de dados. Essas unidades não podem ser comparadas como se um número maior sempre significasse uma conexão melhor.

## Monte um pequeno conjunto de medições

Use o dispositivo afetado no local habitual. Registre três amostras espaçadas em um horário tranquilo e três durante a janela do sintoma. Quando for seguro e compatível, repita por um link local alternativo sem mudar o destino ou as configurações do teste.

Depois compare medianas, intervalos e recorrência, em vez de escolher o melhor número. Anote uploads simultâneos, mudanças na rede mesh, estado de energia do dispositivo e condições meteorológicas apenas quando forem diretamente observados; não invente histórias de causa e efeito a partir de eventos coincidentes.

## Interprete combinações

Uma taxa de transferência sustentada baixa pode esvaziar o buffer de reprodução. Variação de atraso e perda podem interromper a entrega mesmo quando uma média de curto prazo parece suficiente. Latência alta pode tornar sequências de solicitação e resposta mais lentas sem necessariamente limitar uma transferência longa. Aplicativo, comportamento do transporte, projeto do buffer e fonte determinam o impacto visível.

Se a reprodução continuar, mas a imagem estiver ruim, use a [comparação de qualidade de imagem](/blog/the-complete-guide-to-understanding-video-quality/) em vez de tratar o desfoque como prova de rede lenta. O Norva reproduz fontes compatíveis e autorizadas; não fornece um catálogo nem controla seu roteador, o caminho da fonte ou sua codificação.

## Erros comuns de interpretação

Não compare bits com bytes, não confunda taxa do link com taxa de transferência, não chame toda variação de atraso de “perda de pacotes” nem trate o resultado de um único servidor como garantia. Evite medir apenas depois de mudar roteador, dispositivo e fonte ao mesmo tempo.

## Perguntas frequentes

### Qual métrica importa mais para vídeo?

Nenhuma métrica domina sempre. O padrão de entrega da versão, o caminho, o dispositivo e o sintoma determinam quais medições são relevantes.

### A taxa de transferência pode superar o valor anunciado no plano?

Rótulos, provisionamento, métodos de teste, unidades e definições de sobrecarga variam. Verifique o que cada número representa antes de tratar uma diferença como erro.

### Todas as ferramentas medem jitter da mesma forma?

Não. Confira a fórmula da ferramenta, a direção, o tipo de sonda, o período de amostragem e a estatística informada.

### Qual jitter é aceitável para vídeo em streaming?

Não existe um limite universal em milissegundos que certifique a reprodução de vídeo. Vídeo sob demanda com buffer e chamadas interativas toleram atrasos de formas diferentes; as ferramentas também calculam jitter de maneiras diferentes. Compare resultados repetidos do mesmo método com o sintoma real. Um limite publicado para um aplicativo ou protocolo não deve virar uma exigência geral para o Norva.

### Por que o vídeo pausa para carregar depois de um bom teste de velocidade?

O teste pode usar outro servidor, rota, padrão de transferência ou janela de tempo. Ele pode deixar passar interrupções breves, e a reprodução também depende da fonte e do dispositivo. Registre se o atraso acontece antes do primeiro quadro ou durante a reprodução antes de escolher o próximo teste.

## Seu próximo passo

[Associe o sintoma de reprodução à próxima verificação](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Leve o dispositivo, a janela de tempo, o método de teste e um sintoma repetível — não as credenciais da fonte — a qualquer solicitação de suporte.

## Fontes

- [RFC 6349: testes de taxa de transferência TCP](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: métrica de atraso em uma direção](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: métrica de variação de atraso](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: métrica de perda de pacotes em uma direção](https://www.rfc-editor.org/rfc/rfc7680)
