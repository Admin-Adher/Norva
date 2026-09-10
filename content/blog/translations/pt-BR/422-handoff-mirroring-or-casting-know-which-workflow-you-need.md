---
language: "pt-BR"
source_slug: "handoff-mirroring-or-casting-know-which-workflow-you-need"
source_sha256: "b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e"
title: "Continuidade, espelhamento ou transmissão: escolha o fluxo necessário"
seo_title: "Continuidade, espelhamento ou casting: qual usar"
meta_description: "Escolha continuidade para assistir de forma independente, espelhamento para copiar a tela ou transmissão a um receptor. Compare controles, privacidade, acesso e dispositivos."
excerpt: "Decida se precisa de um app independente, uma cópia da tela ou reprodução em um receptor controlada pelo telefone e confira os requisitos desse caminho."
topic_cluster: "Continuidade entre dispositivos"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Continuidade, espelhamento ou transmissão: escolha o fluxo necessário

> **Em resumo:** Use a continuidade entre dispositivos para seguir de forma independente no app do dispositivo de destino. Use o espelhamento para reproduzir sua tela em outra tela. Use a transmissão para um receptor para selecionar mídia em um dispositivo e controlar a reprodução em outro. Escolha pelo comportamento de que precisa e depois confira os requisitos do app, receptor, rede e fonte; a palavra “cast” sozinha não identifica o caminho.

“Mostrar isto na TV” pode significar três coisas: transferir seu progresso, copiar a interface atual ou usar o telefone como controle remoto. Uma conexão bem-sucedida ainda pode ser o fluxo errado se não fizer o que você esperava.

Aqui, **dispositivo de origem** significa o telefone ou computador de onde você começa; **fonte de mídia** significa o serviço ou os arquivos que fornecem as mídias que você tem autorização para usar. Eles não são intercambiáveis.

## Compare os três fluxos

| Fluxo | De onde vem a experiência visível | Dispositivo de origem após o início | Verificação principal |
| --- | --- | --- | --- |
| Continuidade entre dispositivos | O app aberto de forma independente no destino | Não é necessário para renderizar a sessão do destino | Conta, perfil, fonte, item, versão, progresso |
| Espelhamento de tela | Uma reprodução da tela de origem compartilhada | Continua fornecendo a tela exibida | Compatibilidade do sistema operacional e da tela; o que é compartilhado |
| Transmissão para um receptor | Mídia reproduzida por um receptor, selecionada em um emissor | Fornece controles de sessão; a dependência contínua varia | Compatibilidade de emissor, receptor, mídia e rede, além de direitos de uso |

Estas são categorias práticas, não nomes rígidos de protocolos. O Google documenta tanto [a transmissão de uma guia ou tela do Chrome](https://support.google.com/chromecast/answer/3228332?hl=en) quanto [a reprodução em receptor controlada pelo emissor](https://developers.google.com/cast/docs/overview). Este guia usa “transmissão para um receptor” para o segundo caso, permitindo distinguir o comportamento pretendido antes de seguir instruções de configuração.

## Escolha a transferência para dar continuidade

A transferência entre dispositivos serve quando o objetivo é “terminar este item no app de TV” ou “passar do tablet para a web”. A [página pública de recursos](https://norva.tv/#features) do Norva descreve progresso, favoritos, histórico e preferências de perfil que acompanham você nas telas compatíveis. Isso é continuidade do contexto de exibição, não uma cópia da primeira tela.

O destino ainda precisa de seu próprio meio compatível de usar o Norva e de acesso à fonte de mídia compatível. Pause a primeira sessão, confirme o perfil pretendido e a versão do item no destino e verifique o ponto de retomada antes de reproduzir. O [guia de continuidade estado por estado](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) cobre essa sequência. Um pôster igual, sozinho, não basta para identificar o mesmo episódio ou edição.

**Escolha este fluxo quando:** quiser que o destino se torne a tela principal sem reproduzir a tela de origem.

## Escolha o espelhamento para uma cópia exata da tela

O espelhamento reproduz uma tela compartilhada em vez de abrir uma cópia independente do app de destino. Compartilhar a tela inteira pode revelar navegação, notificações, detalhes da conta ou outra atividade exibida. Compartilhar uma guia ou apenas um app tem um escopo menor quando a plataforma oferece essa opção; não suponha que esses modos exponham as mesmas coisas.

Confira o escopo antes de começar e feche materiais privados que possam aparecer nele. Verifique imagem e som: as instruções do Chrome do Google distinguem transmissão de guia de transmissão de tela inteira e observam que o áudio desta última pode permanecer no computador. Uma imagem visível não comprova que o som também foi transferido.

**Escolha este fluxo quando:** a necessidade real for mostrar a mesma interface ou uma tela que não seja de mídia a outras pessoas e houver compatibilidade verificada com espelhamento.

## Escolha reprodução remota para um fluxo com receptor

No modelo Cast do Google, um emissor inicia e controla a sessão enquanto um receptor cuida da reprodução da mídia. O receptor não é simplesmente uma segunda cópia de tudo na tela do telefone. A continuidade da sessão após fechar o emissor ou perder sua conexão depende da implementação real; confira em vez de supor independência do telefone.

Um fluxo com receptor exige capacidades compatíveis de emissor e receptor. A página inicial pública do Norva lista **Google Cast** separadamente do app Android TV e da continuidade entre telas. Essa disponibilidade publicada não é um teste do seu receptor específico, formato de mídia, faixa de legendas ou rede. Este artigo não relata um teste concluído de transmissão pelo Norva.

O [rascunho da API Remote Playback do W3C](https://www.w3.org/TR/remote-playback/) descreve uma família mais ampla de mecanismos de reprodução remota, incluindo casos em que a origem ainda renderiza ou retransmite a mídia. O [rascunho da API Presentation](https://www.w3.org/TR/presentation-api/) trata de apresentar conteúdo web em outra tela. Nenhuma especificação comprova que um app implemente uma API específica ou que todos os receptores sejam compatíveis.

**Escolha este fluxo quando:** o destino tiver sido projetado para receber a reprodução e emissor, receptor, mídia, rede, direitos da fonte e documentação atual do produto permitirem esse caminho.

## Comece pelas perguntas sobre o objetivo

Pergunte:

1. Quero que o destino execute seu próprio app depois da transição?
2. Preciso compartilhar a tela inteira, apenas um app ou só a mídia?
3. Quero continuar controlando a reprodução pelo dispositivo de origem?
4. Quais informações privadas estão dentro do escopo de compartilhamento escolhido?
5. O caminho selecionado consegue acessar a fonte de mídia autorizada?
6. Essa função está documentada para estes dispositivos e versões do app?
7. As condições atuais do plano de software e da fonte de mídia permitem o uso pretendido?

Se as respostas entrarem em conflito, não ative ícones de conexão aleatórios. Esclareça o objetivo primeiro.

## Contribuição original: ficha de seleção

A ficha preenchida a seguir é uma **ilustração criada para este guia**, não um registro de testes do produto. As pessoas, o título e a posição de pausa são fictícios. Cada escolha segue o objetivo declarado; a última coluna é trabalho ainda pendente, não uma verificação bem-sucedida.

| Situação declarada | Fluxo escolhido | Por que serve | Verificar antes de usar |
| --- | --- | --- | --- |
| Maya pausou o filme fictício Harbour Walk em 18:40 no telefone e quer terminar no app de TV usando o controle remoto da TV | Continuidade entre dispositivos | A TV deve executar uma sessão independente com o contexto salvo correto | Mesmo perfil, fonte autorizada, versão exata e ponto de retomada no app de TV compatível |
| Jules quer que outra pessoa veja o painel de filtros aberto em um notebook | Espelhamento ou modo compatível de compartilhar app ou janela | A própria interface, não apenas um vídeo, precisa aparecer na tela | Escopo exato do compartilhamento, compatibilidade da tela e ausência de material privado |
| Sam quer escolher um filme no telefone e continuar usando os controles de reprodução dele para o receptor da sala | Transmissão para um receptor | O emissor controla a reprodução no receptor sem compartilhar toda a interface do telefone | Emissor e receptor compatíveis, mídia acessível, uso permitido e faixas necessárias de áudio e legendas |

As decisões diferem mesmo que as três pessoas digam “coloque na tela grande”. Reutilize as quatro colunas com sua própria situação. Se a verificação final for desconhecida, a escolha é provisória; um rótulo atraente de recurso não a conclui.

## Verifique antes de agir

Para uma TV compartilhada, combinem de quem o progresso e as preferências devem mudar. O [guia de decisão entre perfis separados ou compartilhados](/blog/separate-profiles-or-one-shared-profile-a-decision-framework/) ajuda a resolver isso antes de começar a reprodução. Para um fluxo com receptor, consulte as orientações atuais do Norva e do fabricante do dispositivo; não deduza compatibilidade pelo formato de um ícone, um tutorial antigo ou outro app.

Confira também a disponibilidade de áudio e legendas no destino. Uma imagem correta não comprova que todas as [faixas de legendas internas ou separadas](/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/) chegaram até ele. Registre a versão do app, o modelo do receptor, a versão do item escolhido e o resultado visível se precisar de ajuda; não compartilhe credenciais da fonte.

## Limitações e erros comuns

Os termos variam entre plataformas. Alguns produtos combinam descoberta, controle e exibição sob um único rótulo. Este artigo oferece um modelo de decisão, não instruções de configuração específicas para dispositivos.

Erros comuns incluem tratar continuidade como espelhamento, supor que todo app de TV seja um receptor, expor notificações durante o espelhamento, confundir quantidade de perfis com permissão de uso simultâneo e esperar faixas idênticas em todos os caminhos. O Norva é um software de reprodução de mídia; não inclui conteúdo nem assinatura de TV. Um método de conexão não concede direitos sobre a mídia nem substitui as condições de acesso da fonte.

## Perguntas frequentes

### A sincronização do Norva entre dispositivos significa que ele aceita casting?

A sincronização sozinha não estabelece compatibilidade com casting. O Norva lista Google Cast separadamente na página inicial pública. Verifique emissor, receptor, fonte e mídias compatíveis com o caminho que pretende usar; este guia não testou essa combinação de dispositivos.

### Espelhamento é o melhor para vídeo?

Não em todos os casos. Ele pode reproduzir toda a tela de origem e manter esse dispositivo envolvido. Escolha com base no objetivo real e no caminho compatível.

### Posso usar os termos como sinônimos?

Evite. Nomeie o comportamento esperado da origem e do destino para que o suporte e as pessoas da casa entendam o fluxo.

## Seu próximo passo

Escolha uma linha da ficha de seleção e depois [revise os recursos do Norva entre dispositivos](https://norva.tv/#features) com base nesse objetivo. Mantenha explícitas as verificações restantes dos dispositivos e da fonte antes de transferir uma sessão.

## Fontes

- [Google Cast: visão geral de emissores e receptores](https://developers.google.com/cast/docs/overview)
- [Suporte do Google: transmitir uma guia ou tela do Chrome para uma TV](https://support.google.com/chromecast/answer/3228332?hl=en)
- [Rascunho da API Remote Playback do W3C](https://www.w3.org/TR/remote-playback/)
- [Rascunho da API Presentation do W3C](https://www.w3.org/TR/presentation-api/)
- [Recursos do Norva](https://norva.tv/#features)
