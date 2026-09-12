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

O plugin suporta personalização externa por projeto através do arquivo `guardrail.config.json` na raiz do seu repositório — sem precisar alterar o código-fonte nem fazer fork.

### Onboarding rápido

Copie o template de exemplo para o seu projeto:

```bash
cp guardrail.config.json.example guardrail.config.json
```

### Exemplo de `guardrail.config.json`

```json
{
  "log": {
    "enabled": true,
    "path": "~/.config/opencode/memory/db-guardrail.log"
  },
  "toast": {
    "enabled": true
  },
  "rules": {
    "disableDefaults": [
      "rails db:drop"
    ],
    "custom": [
      {
        "pattern": "\\bdrop\\s+table\\b",
        "flags": "i",
        "label": "DROP TABLE",
        "severity": "critical"
      }
    ]
  },
  "wrappers": {
    "additionalPatterns": [
      "^\\s*pipenv\\s+run\\s+python\\s+-c\\s+[\"'](.+)[\"']\\s*$"
    ]
  }
}
```

### Opções disponíveis

- **`rules.disableDefaults`**: Lista de labels ou IDs de regras padrão a desativar (ex: `"rails db:drop"`, `"prisma-migrate-reset"`).
- **`rules.custom`**: Array de regras adicionais com regex (`pattern`), flags (opcional, padrão `"i"`), `label` e `severity` (`"critical"` ou `"risky"`).
- **`allowlist`**: Array de exceções auditáveis que parecem perigosas mas são permitidas no seu contexto. Exige obrigatoriamente um campo `reason`. Quando acionado, o comando é executado e gera um log auditável `[ALLOWLIST]`.
- **`wrappers.additionalPatterns`**: Regexes adicionais para extrair e reanalisar comandos envelopados.
- **`log.enabled` e `log.path`**: Ativa/desativa o log de auditoria em arquivo e permite apontar para um caminho customizado.
- **`toast.enabled`**: Ativa ou desativa alertas toast na TUI.

## Allowlist (Exceções Auditáveis)

Para evitar "alert fatigue" com rotinas legítimas (ex.: limpeza de tabelas temporárias ou resets em CI), use a seção `allowlist`.

Toda entrada na allowlist exige:
1. `pattern`: Expressão regular correspondente ao comando/segmento permitido.
2. `reason`: **Obrigatório**. Justificativa clara para compliance e auditoria.

### Log de Auditoria para Allowlist

Quando um comando perigoso é permitido por constar na allowlist, ele não bloqueia a execução, mas gera um registro específico no log:

```text
[2026-09-12T13:00:00.000Z] [ALLOWLIST] Limpeza trimestral de logs em staging :: regra ignorada: DELETE sem WHERE :: comando original: DELETE FROM staging_logs :: segmento: DELETE FROM staging_logs
```

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
