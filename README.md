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
| **Regras críticas** | Bloqueia operações irreversíveis em múltiplos motores: `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE TABLE`, `mongosh ... dropDatabase()`, `mysqladmin drop`, remoção de volumes docker de bases de dados, `sp_detach_db`, `BACKUP LOG ... WITH TRUNCATE_ONLY`, `DROP TABLESPACE ... INCLUDING CONTENTS`, `DROP USER ... CASCADE`, `PURGE RECYCLEBIN`, `FLUSHALL`/`FLUSHDB`, `CONFIG SET dir`, `SHUTDOWN NOSAVE`, `DROP KEYSPACE`, etc. |
| **Regras de risco** | Bloqueia: `DELETE FROM` sem `WHERE`, `UPDATE ... SET` sem `WHERE`, `prisma migrate reset`, `rails db:drop`, `SET SINGLE_USER ROLLBACK IMMEDIATE`, sobrescrita destrutiva de `.backup` no SQLite. |
| **Segmentação de comandos** | Divide comandos encadeados (`&&`, `\|\|`, `;`, `\|`) e avalia cada parte individualmente. |
| **Expansão de shell-wrappers** | Deteta `bash -c "…"`, `sh -c "…"`, `sudo bash -c "…"` e reanalisa o conteúdo interno recursivamente. |
| **Expansão de interpretadores one-liner** | O mesmo para `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`. |
| **Allowlist auditável** | Libera comandos específicos com motivo registrado (`[ALLOWLIST]`) para rotinas legítimas e compliance. |
| **Notificação visível** | Mostra um toast (vermelho para crítico, laranja para risco) na TUI do opencode. |
| **Log de auditoria** | Regista cada bloqueio em `~/.config/opencode/memory/db-guardrail.log`, com timestamp, severidade, comando original e segmento detetado. |

## Bancos de Dados e Operações Cobertas

| Banco / Motor | Operações Protegidas | ID da Regra Padrão |
|---|---|---|
| **PostgreSQL / MySQL / MariaDB** | `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE TABLE`, `mysqladmin drop`, `DELETE`/`UPDATE` sem `WHERE` | `drop-database`, `drop-schema`, `truncate-table`, `mysqladmin-drop`, `delete-without-where`, `update-without-where` |
| **MongoDB** | `db.dropDatabase()` via `mongosh` ou scripts inline | `mongo-drop-database` |
| **SQL Server (MSSQL)** | `sp_detach_db`, `BACKUP LOG WITH TRUNCATE_ONLY`, `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` | `sqlserver-detach-db`, `sqlserver-backup-log-truncate`, `sqlserver-single-user-rollback` |
| **Oracle** | `DROP TABLESPACE ... INCLUDING CONTENTS`, `DROP USER ... CASCADE`, `PURGE RECYCLEBIN` | `oracle-drop-tablespace`, `oracle-drop-user-cascade`, `oracle-purge-recyclebin` |
| **Redis** | `FLUSHALL`, `FLUSHDB`, `CONFIG SET dir/dbfilename` (vetor de RCE), `SHUTDOWN NOSAVE`, `DEBUG SEGFAULT` | `redis-flush`, `redis-config-set-dir`, `redis-shutdown-nosave`, `redis-debug-segfault` |
| **Cassandra** | `DROP KEYSPACE`, `TRUNCATE` via `cqlsh` | `cassandra-drop-keyspace`, `cassandra-truncate` |
| **SQLite** | `DROP TABLE`, `DELETE` sem `WHERE` via CLI sqlite3, sobrescrita destrutiva via `.backup` | `sqlite3-drop-table`, `sqlite3-backup-destruct` |
| **Docker** | Remoção forçada com volume (`docker rm -v`) de containers Postgres, MySQL, MariaDB, Mongo, Redis, MSSQL ou Cassandra | `docker-db-volume-rm` |
| **Frameworks (Prisma / Rails)** | `prisma migrate reset`, `rails db:drop` | `prisma-migrate-reset`, `rails-db-drop` |

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
  "allowlist": [
    {
      "pattern": "DELETE\\s+FROM\\s+staging_logs",
      "flags": "i",
      "reason": "Limpeza trimestral automatizada de logs em ambiente de staging"
    }
  ],
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
  > 📖 Para um tutorial completo e detalhado sobre como criar e testar regexes seguras, consulte o [Guia de Regras Customizadas](docs/custom-rules.md).
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

## Como Testar e Validar

Você pode validar o guardrail de várias formas: rodando a suíte automatizada de testes, testando comandos isolados pelo CLI local ou vendo o bloqueio em tempo real na TUI do Opencode.

### 1. Testes Automatizados da Suíte (`npm test`)

O projeto possui **52 testes automatizados** cobrindo todas as camadas (ANSI SQL, noSQL, Redis, Oracle, MSSQL, Cassandra, SQLite, segmentação de comandos encadeados, unwrap de wrappers, allowlist com justificativa, CLI e contadores de métricas).

```bash
# Executa compilação TypeScript e roda toda a suíte de testes
npm test

# Apenas compilar sem rodar testes
npm run build
```

---

### 2. Testes Rápidos pelo Terminal via CLI (`guardrail-cli`)

Para testar qualquer comando diretamente no shell em menos de 100ms sem precisar abrir o Opencode:

```bash
# Testar comando destrutivo (bloqueado com Exit Code 1)
npx guardrail-cli "psql -c 'DROP DATABASE prod'"
npm run guardrail -- "DROP DATABASE prod"

# Testar comando seguro (permitido com Exit Code 0)
npx guardrail-cli "SELECT * FROM users WHERE active = 1"
npm run guardrail -- "SELECT * FROM users"

# Testar comandos encadeados com múltiplos operadores (&&, ;, ||, |)
npx guardrail-cli "echo 'iniciando...' && DROP DATABASE temp && echo 'fim'"

# Testar comandos envelopados em interpretadores e shells
npx guardrail-cli "bash -c 'redis-cli FLUSHALL'"
npx guardrail-cli "node -e \"require('pg').query('UPDATE t SET x=1')\""
```

#### Testando uma Regex Customizada na Hora (`--test-regex`)

Antes de adicionar um novo padrão ao seu `guardrail.config.json`, valide se ele detecta o comando perigoso e se não gera falsos positivos:

```bash
# Testar se detecta o perigo (deve retornar MATCH com Exit Code 1)
npx guardrail-cli --test-regex "\\bdrop\\s+table\\b" "DROP TABLE usuarios;"

# Testar se NÃO gera falso positivo em palavras parecidas (deve retornar NO MATCH com Exit Code 0)
npx guardrail-cli --test-regex "\\bdrop\\s+table\\b" "SELECT * FROM droplet;"
```

#### Inspecionar Regras Ativas do Projeto (`--list-rules`)

Exibe todas as regras padrão, regras customizadas e entradas de allowlist ativas no diretório atual:

```bash
npx guardrail-cli --list-rules
```

#### Modo JSON para Scripts e Automações (`--json`)

```bash
npx guardrail-cli --json "DROP DATABASE prod"
```

Saída de exemplo:
```json
{
  "allowed": false,
  "status": "blocked",
  "command": "DROP DATABASE prod",
  "matchedSegment": "DROP DATABASE prod",
  "rule": "DROP DATABASE",
  "severity": "critical"
}
```

---

### 3. Teste Manual dentro do Opencode (TUI e Log de Auditoria)

Após reiniciar o Opencode com o plugin instalado, teste disparando uma instrução de teste na conversa:

```bash
psql -c "DROP DATABASE producao"
```

**Resultado esperado:**
1. **Toast na TUI:** Notificação visual vermelha (`Comando de base de dados bloqueado`) ou amarela para riscos.
2. **Bloqueio no Chat:** O comando é cancelado antes de ser executado pelo bash do sistema operacional.
3. **Registro no Log:** É gravada uma linha no arquivo persistente `~/.config/opencode/memory/db-guardrail.log`:
   ```text
   [2026-09-12T13:00:00.000Z] [CRITICAL] DROP DATABASE :: comando original: psql -c "DROP DATABASE producao" :: segmento detetado: DROP DATABASE producao
   ```

---

### 4. Gate de Segurança em CI/CD (GitHub Actions)

Adicione uma etapa preventiva no workflow do seu repositório para inspecionar scripts e migrações antes do merge:

```yaml
# .github/workflows/db-guardrail-check.yml
name: DB Guardrail Security Check

on: [push, pull_request]

jobs:
  audit-scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Instalar dependências
        run: npm ci

      - name: Escanear scripts shell em busca de comandos perigosos
        run: |
          for f in scripts/**/*.sh; do
            echo "Auditando $f..."
            npx guardrail-cli "$(cat $f)" || { echo "❌ Comando perigoso bloqueado em: $f"; exit 1; }
          done
```

## Métricas Simples (Contadores em Memória)

O plugin expõe um módulo de contadores em memória com overhead zero e sem necessidade de infraestrutura adicional (Prometheus, Datadog ou agentes).

### Estrutura das métricas

```ts
interface GuardrailMetrics {
  totalScanned: number    // Total de comandos bash analisados
  blockedCritical: number // Total de operações críticas bloqueadas
  blockedRisky: number    // Total de operações de risco bloqueadas
  allowed: number         // Total de comandos permitidos (seguros ou via allowlist)
  allowlistHits: number   // Total de comandos liberados pela allowlist auditada
  errors: number          // Total de falhas de processamento
}
```

### Acesso Programático

```ts
import { getMetrics, resetMetrics, metrics } from "opencode-db-guardrail"

console.log(getMetrics())
// Exemplo de saída:
// { totalScanned: 247, blockedCritical: 3, blockedRisky: 7, allowed: 237, allowlistHits: 1, errors: 0 }
```

### Visualização via CLI

```bash
npx guardrail-cli --metrics "SELECT 1"
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
