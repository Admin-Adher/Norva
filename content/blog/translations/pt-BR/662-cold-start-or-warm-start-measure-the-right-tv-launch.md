---
language: "pt-BR"
source_slug: "cold-start-or-warm-start-measure-the-right-tv-launch"
source_sha256: "1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb"
title: "Inicialização a frio ou com estado salvo: por que um app de TV abre de formas diferentes"
seo_title: "Inicialização de apps de TV: compare o tempo de carregamento"
meta_description: "Por que um app de TV abre rápido uma vez e depois demora? Separe início a frio, reabertura, primeira imagem e navegação utilizável com um exemplo de tempos."
excerpt: "Voltar da tela inicial não é necessariamente uma nova inicialização. Compare o mesmo estado de partida e diferencie uma imagem visível de uma navegação que realmente responde."
topic_cluster: "Desempenho de Smart TV"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Inicialização a frio ou com estado salvo: por que um app de TV abre de formas diferentes

> **Em resumo:** Um app de TV pode começar do zero, reconstruir uma tela usando estado preservado ou voltar com grande parte da interface ainda na memória. São tarefas diferentes. Compare condições iniciais idênticas e cronometre tanto a primeira imagem do app quanto a navegação utilizável pelo controle remoto. Ver um logotipo não comprova que o catálogo esteja pronto.

Este guia é para quem tenta descrever tempos de abertura inconsistentes, não para pontuar uma TV com base em uma meta universal de velocidade. Os sistemas operacionais de TV podem gerenciar processos de forma invisível. Quando não conseguir verificar o estado interno, registre o que fez em vez de inventar um rótulo técnico.

## Defina quatro estados

O Android documenta inicializações a frio (**cold**), com estado salvo (**warm**) e a quente (**hot**). Uma inicialização cold cria o app do zero; uma warm executa parte do trabalho de início usando estado preservado; uma hot traz uma atividade preservada para a frente. Voltar a uma tela dentro do app é uma observação de navegação separada, não uma quarta categoria de inicialização do Android.

Para um registro prático de TV, diferencie estas quatro situações observáveis:

| Situação que você pode registrar | O que ela informa | O que continua desconhecido |
|---|---|---|
| Abertura após uma reinicialização oficial da TV | O sistema reiniciou antes de o app abrir | Quanto do atraso pertence à prontidão do sistema ou da rede |
| Reabertura depois de sair com Voltar | A saída do app ocorreu pelo controle normal | Se o processo ou a tela foi preservado |
| Retorno depois de pressionar Início e esperar 30 segundos | Houve um intervalo curto em segundo plano | Se o sistema manteve o app ativo |
| Retorno a Filmes a partir de outra tela do app | A navegação permaneceu dentro do app | Quais recursos do catálogo ou imagens foram reutilizados |

O [guia por camadas](/blog/smart-tv-media-app-performance-a-layer-by-layer-guide/) separa o ciclo de vida da rede e da renderização.

## Defina dois pontos finais

O primeiro quadro visível pode aparecer antes de o foco funcionar, as imagens carregarem ou a navegação responder. Registre “primeiro quadro do app” e “tela utilizável” separadamente. Acrescente “imagens estáveis” somente quando essa for a questão. TTID e TTFD do Android distinguem a exibição inicial da prontidão completa, mas sua cronometragem manual do controle à tela não é automaticamente nenhuma dessas métricas instrumentadas.

Não pare o relógio no marco mais favorável.

## Fixe o contexto

Registre modelo da TV, sistema operacional, versão do app, fonte de entrada, estado de energia, saída, caminho por cabo ou Wi-Fi, horário, descrição da sessão que preserve os dados da conta, disponibilidade da fonte e atividade em segundo plano. Mantenha comparáveis os estados da rede e da fonte.

A cronometragem manual deve informar a incerteza do tempo de reação.

## Contribuição original: protocolo de inicialização

Os valores a seguir são **exemplos didáticos fictícios, não medições do Norva**. Uma pessoa usa uma TV, uma versão do app, uma conta e um catálogo. Cada tentativa começa no pressionamento do controle remoto que abre o app. “Utilizável” significa que a tela pretendida está visível, um movimento do direcional responde e nenhuma sobreposição bloqueante permanece. Os tempos são segundos a partir desse mesmo evento inicial.

| Tentativa | Preparação observada | Primeiro quadro do app | Navegação utilizável | Imagens estáveis |
|---|---|---|---|---|
| A | Reinicialização oficial; tela inicial da TV e rede prontas | 1.8 s | 4.6 s | 6.2 s |
| B | Início, esperar 30 segundos, voltar | 0.7 s | 1.2 s | 1.9 s |
| C | Mesmo retorno após intervalo curto | 0.8 s | 1.4 s | 2.0 s |
| D | Repetir a preparação usada em A | 1.9 s | 4.4 s | 6.0 s |

As duas observações após reinicialização chegam à navegação utilizável em 4.4–4.6 segundos, enquanto os retornos curtos levam 1.2–1.4 segundos. Isso sugere uma diferença repetível entre essas preparações. **Não** estabelece quanto tempo um cache específico economizou, não comprova estado de processo warm ou hot nem prevê o resultado de outra TV.

A observação útil para o suporte é a distância entre o primeiro quadro e a navegação que responde em A e D. Chamar o app de “pronto em 1.8 segundo” esconderia essa distância. A cronometragem manual também inclui o erro de reação do observador: não interprete uma diferença de um décimo de segundo como melhoria de desempenho sem medição mais precisa.

## Estabeleça o estado a frio com segurança

Use apenas orientações oficiais de parada do app, reinicialização da TV ou alimentação. Não retire a energia, use menus de serviço ou limpe dados apenas para criar um estado a frio. Se a plataforma não permitir verificar que o app não está em execução, chame de “abertura após reinicialização”.

A segurança e a integridade do dispositivo têm prioridade sobre a pureza experimental.

## Estabeleça um estado de inicialização com estado salvo

Nenhuma sequência genérica de Início ou Voltar garante um estado de processo warm. Se não conseguir verificá-lo pela instrumentação da plataforma, registre um **retorno após intervalo curto**: chegue à mesma tela, saia pelo controle documentado, espere um intervalo fixo e volte. Anote se a tela, o foco ou as imagens persistiram sem atribuir um rótulo de ciclo de vida não verificado.

O estado preservado pode mudar entre tentativas, portanto mantenha recarregamentos inesperados no registro.

## Inverta a ordem e dê descanso

Use a sequência após reinicialização, retorno curto, retorno curto, após reinicialização quando for viável, com intervalos fixos de descanso. Inverter a ordem pode revelar um padrão compatível com mudanças de cache, temperatura, rede ou fonte; isso não identifica a causa. Não faça dezenas de aberturas: defina previamente uma quantidade pequena.

A instrumentação pode estabelecer com mais precisão o estado do processo e os limites de tempo, mas quem assiste não precisa do modo de desenvolvedor nem de registros privados para relatar um atraso visível repetível.

## Interprete as diferenças

Uma inicialização warm mais rápida que uma cold pode refletir estado preservado ou recursos em cache, mas não quantifica qual cache. Uma warm que se comporta como cold pode refletir encerramento do app, atualização, pressão de memória ou escolha de implementação.

Registre perdas repetidas de posição ou recarregamentos inesperados como observações, não como prova de que a TV precisa de mais memória. Se apenas a transferência da exibição entre telas parecer lenta, identifique primeiro o mecanismo no [guia de continuidade, espelhamento e transmissão](/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/).

## Compare depois de uma mudança

Depois de atualizar o app, repita o mesmo protocolo e documente o contexto de versão. Preserve as anotações de antes e depois em vez de confiar na memória. Não compare uma abertura antiga após reinicialização com um retorno curto novo.

O comportamento de abertura do Norva na TV depende do dispositivo, da versão e da fonte conectada. O Norva é um reprodutor para mídias compatíveis que você tem autorização para usar, não um catálogo incluído. Estes exemplos não certificam sua velocidade de inicialização ou seu desempenho de reprodução.

## Controle a ordem das tentativas e a prontidão

Tentativas a frio costumam acontecer primeiro, então manutenção na inicialização, reconexão de rede ou preparação do observador podem penalizá-las injustamente. Alterne a ordem entre sessões quando a plataforma permitir um estado documentado e espere o mesmo intervalo fixo antes de cada abertura. Registre se a tela inicial, o controle remoto, a rede e a saída já estavam prontos.

Defina “utilizável” antes de cronometrar: por exemplo, a tela pretendida está visível, o foco responde uma vez e nenhuma sobreposição bloqueante permanece. Não encerre a medição apenas porque um logotipo apareceu. Informe a mediana somente junto com os valores individuais e o intervalo; um resumo único pode esconder uma abertura travada ou com falha que importa mais que uma pequena diferença média.

## Perguntas frequentes

### Ligar a TV é o mesmo que iniciar o app a frio?

Não. Isso inclui a inicialização do sistema e pode restaurar o estado do app de forma diferente.

### Quantas execuções são necessárias?

Use várias execuções predefinidas, suficientes para mostrar o intervalo sem sobrecarregar o dispositivo ou a fonte.

### O carregamento completo das imagens deve definir a inicialização?

Somente se a prontidão das imagens for a tarefa; mantenha separados o primeiro quadro e o foco utilizável.

## Seu próximo passo

[Obtenha ajuda com um problema reproduzível de abertura na TV](https://norva.tv/support). Inclua modelo da TV, versões do sistema operacional e do app, passos de preparação, tela esperada e os dois marcos de tempo. Deixe identificadores de conta, endereços de fonte e credenciais fora das capturas de tela.

## Fontes

- [Android Developers: tempo de inicialização de apps](https://developer.android.com/topic/performance/vitals/launch-time)
- [Ajuda do Google TV: corrigir lentidão em um dispositivo Google TV](https://support.google.com/googletv/answer/12364830?hl=en)
