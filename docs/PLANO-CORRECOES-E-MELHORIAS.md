# Plano de correções e melhorias (rascunho)

Base: `master` @ `c06c8e9` + branch `fix/delete-non-english-and-background` (`143b715`).
As referências de linha são do código com o patch aplicado.

Prioridades: **P0** = bloqueia o uso ou exige validação antes de seguir · **P1** = bug com efeito real (ação errada, perda de dados) · **P2** = robustez/UX · **P3** = limpeza/menor.

---

## 1. Validar o patch no X real (P0)

| # | O que testar | Observação |
|---|---|---|
| V1 | Excluir posts e respostas com o X em português, numa conta de teste | É o sintoma original. |
| V2 | Job com a aba em segundo plano por mais de 5 min, com mais de 100 posts | **Risco:** com a aba oculta o Chrome não roda a etapa de renderização, então eventos de `scroll` e `IntersectionObserver` não disparam. O worker processa o que já está carregado, mas o X pode não buscar a próxima página até a aba voltar a ficar visível. Se isso acontecer: disparar `window.dispatchEvent(new Event('scroll'))` depois de cada `scrollBy`. Se não bastar, abrir o job numa janela própria (`chrome.windows.create`) e avisar para não minimizá-la. |
| V3 | Cor do item "Excluir" (fallback vermelho) nos temas claro, dim e escuro | Hoje é `rgb(244, 33, 46)`. |
| V4 | Texto real do toast de rate limit em pt-BR | O regex usa "muitas solicitações" e "aguarde alguns instantes", que não foram confirmados. |

---

## 2. Bugs encontrados

### P1: ação errada ou perda de dados

**B1. Seguir/deixar de seguir pega `UserCell` fora da lista.**
`popup.js:980`, `popup.js:1041`, `sidepanel.js:223`, `sidepanel.js:521` usam `document.querySelectorAll('[data-testid="UserCell"]')` na página inteira. A barra lateral ("Quem seguir" / "Talvez você curta") também usa `UserCell` com botão `-follow`. Resultado: *Follow all / Follow verified* pode seguir contas sugeridas que não são seguidores (a confirmar no X real).
*Correção:* limitar a busca a `[data-testid="primaryColumn"]` (vale também para os `article` de tweets).

**B2. O job continua se a página mudar.**
O X é SPA. Se o usuário clicar em "Página inicial", "Explorar" etc. na aba do job, o worker continua rodando na nova página: descurte tudo o que aparecer, ou segue qualquer `UserCell` com botão de seguir.
*Correção:* guardar `location.pathname` no início e, a cada tick, parar com "A página mudou" se for diferente.

**B3. Backup e histórico só são salvos no fim do job.**
`persistJob` (`popup.js:596`) e `persist` (`sidepanel.js:466`) só rodam em `stopAll`/`stop`. Se a aba for fechada ou recarregada, a extensão atualizada ou o navegador travar, perde-se o registro de **tudo o que já foi excluído**. Esse registro é o único backup.
*Correção:* checkpoint a cada N ações ou 30 s (`job_<id>` com `status: 'running'`); ao abrir o popup ou o histórico, marcar jobs `running` órfãos como `interrupted`.

**B4. `activeAction` fica órfão quando a aba do job é fechada.**
`background.js:31` limpa só `activePreviewSession`. Sem outra aba do X aberta, o popup fica preso em "rodando" até clicar em Stop.
*Correção:* no `onRemoved`, limpar também `activeAction`, `activeTabId`, `startTime` e `actionStats` quando `activeTabId === tabId`.

**B5. Descurtir e seguir contam sucesso sem verificar.**
`popup.js:889-892` (unlike) e `popup.js:1006-1008` (follow) incrementam o contador e gravam o backup logo após o clique. Se o X rejeitar a ação (rate limit, erro, conta protegida que vira "pedido pendente"), o contador e o CSV ficam errados.
*Correção:* depois do clique, esperar o botão virar `like` / `-unfollow` / `-cancel`; senão, `noteFailure`.

### P2: robustez

**B6. Bulk unfollow (popup) marca como processado antes do sucesso.** `popup.js:1063`: um unfollow que falha nunca é tentado de novo. Aplicar o mesmo padrão `noteFailure` do patch.

**B7. "Encontrados" inflado.** `popup.js:808` soma `X.processed.size`, que inclui posts de outras contas ignorados em `popup.js:795` (reposts no perfil). Contar os candidatos próprios separadamente.

**B8. `isMine` considera tudo "meu" se o handle não for detectado.** `popup.js:499-502`, `sidepanel.js:173`, `sidepanel.js:535`. O X não deixa excluir post alheio, então o dano é limitado, mas o job perde tempo tentando cada post 3 vezes e o fallback vermelho passa a olhar menus de posts alheios.
*Correção:* usar `account.username` (já passado ao worker) como fallback; se ainda for nulo, abortar.

**B9. `sleep()` retorna na hora se a mensagem ao service worker falhar.** `popup.js:303`, `sidepanel.js:157`, `sidepanel.js:363`. Com "message port closed" (service worker reiniciado), o callback chama `done()` imediatamente. O polling de menu e confirmação colapsa e os posts acumulam falhas.
*Correção:* com `chrome.runtime.lastError`, ignorar e deixar o timer local resolver.

**B10. `runLoop` engole exceções.** `popup.js:315`, `sidepanel.js:280`, `sidepanel.js:591` (`catch (_) {}`). Um erro no tick faz o job girar em silêncio para sempre.
*Correção:* `console.warn` e parar com mensagem depois de N erros seguidos.

**B11. Side panel recarrega a lista inteira a cada 800 ms.** `sidepanel.js:656-660`: com o scan pausado ou concluído, cada poll busca todos os itens da página e reconstrói a lista. Com milhares de itens isso pesa, o foco do teclado se perde e um checkbox recém-clicado pode "voltar" por um instante (corrida com `updatePreviewSelection` em `sidepanel.js:711`).
*Correção:* buscar os itens só quando o estado ou a contagem mudar; parar o polling quando o scan terminar.

**B12. Worker do side panel não detecta logout.** `detectIssue` em `sidepanel.js:448` não tem o bloco de login de `popup.js:574`. É consequência direta da duplicação (ver M1).

**B13. CSV: acentos e injeção de fórmula.** `popup.js:1434`, `history.js:36`.
- Sem BOM UTF-8, o Excel em pt-BR mostra acentos quebrados.
- Células que começam com `=`, `+`, `-` ou `@` viram fórmula. O CSV tem texto de posts de terceiros (curtidas, reposts), e respostas começam com "@".
*Correção:* prefixar o arquivo com `﻿` e prefixar essas células com `'`.

### P3: menores

**B14.** `URL.revokeObjectURL` logo após `click()` (`popup.js:1448`, `history.js:85`, `history.js:106`) pode cancelar downloads grandes. Revogar com `setTimeout`.

**B15. Seletores ainda dependentes de idioma** (quase todos fallbacks, mas em pt falham em silêncio): `a[aria-label="Profile"]` (`popup.js:132`, `popup.js:484`, `sidepanel.js:43`, `sidepanel.js:160`), `/^following$/i` (`sidepanel.js:525`), `/^(following|unfollow)$/i` (`sidepanel.js:228`), `/^(image|profile photo)$/i` (`popup.js:150`), "click to unfollow" (`sidepanel.js:231`).

**B16.** `autoDiscardable: false` continua na aba se o worker morrer sem `stopAll` (reload). Restaurar em `tabs.onUpdated` com `status: 'loading'`.

---

## 3. Código morto e documentação

- `src/content.js` não está no manifest e referencia elementos do popup. Remover.
- `popup.js`: `exportTweetCSV`, `exportUserCSV`, `todayKey`, `pollHandle`, `bumpAndCheckCap` (no-op) e o `keepAlive` que grava `data-keepalive` no `body` (não mantém nada vivo; o mesmo em `sidepanel.js:513`).
- Ramo `deleteReplies` de `runWorker` (`popup.js:911-970`): inacessível, porque `requestAction('deleteReplies')` abre o Preview. Remover ou religar.
- Classificações `'unresolved'` e `'orphan'` nunca são geradas (`sidepanel.js:537`, `709`, `741`, `753`, `763`, `783`).
- `CONTRIBUTING.md` item 3: caminhos errados e cita `content.js`.
- `README.md:73` pede para manter a aba visível. Atualizar depois de V2.

---

## 4. Melhorias de arquitetura

**M1 (P1). Biblioteca compartilhada para os workers.** Hoje `runWorker`, `runSelectedDelete` e `startPreviewScanner` têm cada um sua cópia de `sleep`, `tweetId`, `isReply`, `detectIssue`, `DELETE_LABELS` etc., porque são serializados por `executeScript`. O patch teve de copiar cada helper 2 ou 3 vezes, e as cópias já divergem (B12).
*Proposta:* `src/worker/lib.js` injetado com `executeScript({ files: [...] })` antes da função, expondo `globalThis.__xbcLib` no mundo isolado.

**M2 (P1). Testes automatizados.** A página falsa da timeline usada para validar o patch não está no repo. Proposta: `test/` com Playwright + Chromium (já disponível) e cenários en/pt, fallback vermelho, re-render após exclusão, reposts de terceiros, `UserCell` na lateral (B1) e navegação no meio do job (B2). Mais um GitHub Action com `node --check` em todos os `.js` e o harness.

**M3 (P2). Tabela de idiomas central** (`delete`, "Replying to", toasts, "Following"), escolhida por `document.documentElement.lang`, em vez de regex espalhados.

**M4 (P2). Rate limit com pausa e retomada.** Pausar com backoff (5–15 min) e retomar sozinho, em vez de parar. Configuração de ritmo (lento/normal) e limite opcional por execução.

**M5 (P2). Interface em português** com `chrome.i18n` (`_locales/en`, `_locales/pt_BR`) no popup, side panel, overlay e histórico.

**M6 (P3). Release.** Versão 1.4.1, `CHANGELOG`, `package.sh`. Decidir se os links do README continuam no upstream (`agmmnn`) e se a correção será oferecida upstream (MIT).

---

## 5. Funcionalidades sugeridas

- **F1.** Filtro por data no Quick Clean ("excluir antes de…" / "manter os últimos N dias") e exclusão por palavra-chave.
- **F2.** Alcançar posts antigos que o perfil não mostra mais: busca `from:<usuário> until:<data>` ou importação do arquivo do X (`tweets.js`), visitando cada post pelo id.
- **F3.** Exportar CSV da seleção **antes** de excluir. O README manda exportar um backup antes, mas não existe botão para isso; o Preview já tem os dados.
- **F4.** Modo simulação (dry-run): percorre e conta sem clicar.
- **F5.** Retomar job interrompido, usando o checkpoint de B3.

---

## 6. Ordem sugerida

1. **Validar o patch** (V1–V4) e ajustar o que falhar.
2. **M2 + M1**: harness de testes e biblioteca compartilhada. Quase toda correção abaixo mexe em helpers duplicados em 2 ou 3 lugares; com isso cada correção é feita e testada uma vez só.
3. **Segurança das ações:** B1, B2, B8, B5, B6.
4. **Não perder dados:** B3, B4, B13, B16.
5. **Robustez e limpeza:** B7, B9–B12, B14, B15, seção 3.
6. **Melhorias e funcionalidades:** M3–M6, F1–F5.
