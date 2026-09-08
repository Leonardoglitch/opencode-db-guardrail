# opencode-db-guardrail

Plugin para [opencode](https://opencode.ai) que bloqueia comandos destrutivos de
bases de dados antes de serem executados — `DROP DATABASE`, `TRUNCATE TABLE`,
`DELETE`/`UPDATE` sem `WHERE`, `prisma migrate reset`, `rails db:drop`, entre
outros — com deteção em camadas para reduzir formas óbvias de contorno.

Inspirado na abordagem do [opencode-codex-guardrails](https://github.com/Yulimfish/opencode-codex-guardrails)
(segmentação de comandos, expansão de shell-wrappers), reescrito de raiz e
focado especificamente em operações de bases de dados.

## O que faz

| Camada | Comportamento |
|---|---|
| **Regras críticas** | Bloqueia sempre: `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE TABLE`, `mongosh ... dropDatabase()`, `mysqladmin drop`, remoção de volumes docker de bases de dados. |
| **Regras de risco** | Bloqueia: `DELETE FROM` sem `WHERE`, `UPDATE ... SET` sem `WHERE`, `prisma migrate reset`, `rails db:drop`. |
| **Segmentação de comandos** | Divide comandos encadeados (`&&`, `\|\|`, `;`, `\|`) e avalia cada parte individualmente. |
| **Expansão de shell-wrappers** | Deteta `bash -c "…"`, `sh -c "…"`, `sudo bash -c "…"` e reanalisa o conteúdo interno recursivamente. |
| **Expansão de interpretadores one-liner** | O mesmo para `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`. |
| **Notificação visível** | Mostra um toast (vermelho para crítico, laranja para risco) na TUI do opencode. |
| **Log de auditoria** | Regista cada bloqueio em `~/.config/opencode/memory/db-guardrail.log`, com timestamp, severidade, comando original e segmento detetado. |

## Instalação

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-db-guardrail"]
}
```

O opencode instala o pacote automaticamente via Bun no arranque. Não é preciso
`npm install` manual nem passo de build.

Para fixar uma versão específica:

```json
{
  "plugin": ["opencode-db-guardrail@0.1.0"]
}
```

## Verificação

Depois de reiniciares o opencode, testa com um comando que deveria ser
bloqueado:

```
psql -c "DROP DATABASE producao"
```

Deves ver um toast de erro na TUI, uma mensagem de bloqueio na conversa, e uma
nova linha em `~/.config/opencode/memory/db-guardrail.log`.

## Configuração

Não há ficheiro de configuração para já — as regras estão no array `RULES` em
`index.ts`. Para adicionar ou ajustar padrões (ex.: comandos específicos do
teu motor de base de dados), faz fork do pacote; é um único ficheiro com menos
de 200 linhas.

## Limitações — lê isto antes de confiar no plugin

- **Sub-agentes contornam o plugin.** Hooks do opencode (`tool.execute.before`)
  atualmente não interceptam chamadas de ferramentas feitas por sub-agentes
  lançados via `task` — ver [opencode#5894](https://github.com/anomalyco/opencode/issues/5894).
  Se um agente delegar a um sub-agente, este plugin **não** vê nem bloqueia
  esse comando.
- **Deteção por regex, não um parser de shell completo.** Aspas aninhadas
  complexas, escaping incomum, ou codificação (base64, variáveis de ambiente)
  podem escapar à deteção.
- **Não substitui permissões corretas na base de dados.** A única proteção
  verdadeiramente robusta é retirar ao utilizador/role de ligação usado pelo
  agente a capacidade de fazer `DROP`/`TRUNCATE` na própria base de dados
  (`REVOKE ...`). Usa este plugin como alerta rápido e registo de auditoria,
  **não** como a tua única linha de defesa.

## Licença

MIT
