# Guia Prático: Como Criar Regras Customizadas

Este guia ensina como escrever expressões regulares (regex) seguras e eficazes para proteger bancos de dados e ferramentas específicas da sua stack utilizando o `opencode-db-guardrail`.

---

## 1. Anatomia de uma Regra

No arquivo [guardrail.config.json](file:///c:/Users/leona/Documents/Projeto/Opencode/opencode-db-guardrail/guardrail.config.json.example), regras adicionais são declaradas na seção `rules.custom`:

```json
{
  "rules": {
    "custom": [
      {
        "id": "sqlserver-drop-table",
        "pattern": "\\bdrop\\s+table\\b",
        "flags": "i",
        "label": "DROP TABLE (SQL Server)",
        "severity": "critical"
      }
    ]
  }
}
```

### Campos da Regra

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| **`pattern`** | `string` | **Sim** | Expressão regular em formato string (lembre-se de escapar barras: `\\b`). |
| **`label`** | `string` | **Sim** | Nome legível exibido nos toasts, logs de auditoria e mensagens de bloqueio. |
| **`severity`** | `"critical"` \| `"risky"` | Não (default: `"critical"`) | Define a severidade e cor do toast (`critical` = vermelho, `risky` = amarelo). |
| **`flags`** | `string` | Não (default: `"i"`) | Modificadores regex (`i` case-insensitive, `m` multiline, `s` dotAll). |
| **`id`** | `string` | Não | Identificador para permitir desativação seletiva ou rastreio. |

---

## 2. Regex 101 para Comandos de Banco de Dados

### 2.1. Limites de Palavra (`\b` / `\\b`)
O limite de palavra (`word boundary`) impede que seu padrão case acidentalmente com palavras maiores:
- ❌ **Sem `\b`**: `"DROP"` irá bater em `DROPLET` ou `BACKDROP`.
- ✅ **Com `\b`**: `"\\bdrop\\b"` casa apenas com a palavra isolada `DROP`.

### 2.2. Espaçamentos Flexíveis (`\s+` / `\\s+`)
Desenvolvedores e LLMs podem usar múltiplos espaços, quebras de linha ou tabulações:
- ❌ `"DROP TABLE"` não casa com `DROP   TABLE` ou `DROP\nTABLE`.
- ✅ `"\\bdrop\\s+table\\b"` casa com qualquer variação de espaçamento.

### 2.3. Case-Insensitive (Flag `i`)
Comandos SQL e comandos CLI podem vir em maiúsculas ou minúsculas (`drop table`, `DROP TABLE`, `Drop Table`). A flag `"flags": "i"` garante que todas as variações sejam detectadas.

### 2.4. Lookaheads Negativos para Cláusulas `WHERE`
Para detectar instruções perigosas como `UPDATE` ou `DELETE` sem restrição `WHERE`:
```regex
\bupdate\s+\S+\s+set\b(?!.*\bwhere\b)
```
- `(?!.*\bwhere\b)`: Garante que a palavra `WHERE` **não** aparece após a cláusula `SET`.

---

## 3. Como Testar seu Regex Rapidamente

O CLI do guardrail permite testar qualquer regex contra strings de teste antes de colocá-lo na configuração:

```bash
# Testar se casa (retorna exit code 1 e segmento detectado)
npx guardrail-cli --test-regex "\\bdrop\\s+table\\b" "DROP TABLE usuarios;"

# Testar se NÃO casa com falso-positivo (retorna exit code 0)
npx guardrail-cli --test-regex "\\bdrop\\s+table\\b" "SELECT * FROM droplet;"
```

---

## 4. Armadilhas Comuns

### 1. Esquecer de escapar a barra invertida no JSON
No formato JSON, a barra invertida `\` é um caractere de escape.
- ❌ `"pattern": "\bdrop\b"` (JSON inválido ou interpretado como backspace)
- ✅ `"pattern": "\\bdrop\\b"`

### 2. Ignorar pontuação de fim de comando
Agentes e desenvolvedores costumam terminar queries com ponto e vírgula `;` ou espaços. Use `(?:\s*;|$)` ou deixe `\b` tratar o limite.

### 3. Falta de suporte a wrappers
O plugin já desempacota chamadas comuns como `bash -c`, `node -e` e `python -c`. Se a sua equipe usa wrappers customizados (ex: `pipenv run python -c`), adicione em `wrappers.additionalPatterns`.

---

## 5. Exemplos Práticos por Banco de Dados

### SQL Server: `sp_detach_db`
```json
{
  "pattern": "\\b(?:exec\\s+)?sp_detach_db\\b",
  "label": "SQL Server detach DB",
  "severity": "critical"
}
```

### Redis: `CONFIG SET dir` (Vetor de RCE)
```json
{
  "pattern": "\\bredis-cli\\b.*config\\s+set\\s+(?:dir|dbfilename)\\b",
  "label": "Redis CONFIG SET dir (RCE risk)",
  "severity": "critical"
}
```

### Cassandra: `DROP KEYSPACE`
```json
{
  "pattern": "\\bdrop\\s+keyspace\\b",
  "label": "Cassandra DROP KEYSPACE",
  "severity": "critical"
}
```

### Oracle: `PURGE RECYCLEBIN`
```json
{
  "pattern": "\\bpurge\\s+(?:recyclebin|dba_recyclebin)\\b",
  "label": "Oracle PURGE RECYCLEBIN",
  "severity": "critical"
}
```

---

## 6. Contribuindo Upstream

Se você criou uma regra útil para um banco de dados ou ferramenta amplamente utilizada, considere enviá-la para o projeto principal:

1. **Fork do Repositório**: Faça fork de [Leonardoglitch/opencode-db-guardrail](https://github.com/Leonardoglitch/opencode-db-guardrail).
2. **Adicione a regra em [index.ts](file:///c:/Users/leona/Documents/Projeto/Opencode/opencode-db-guardrail/index.ts)**:
   - Inclua no array `DEFAULT_RULES` com um `id` consistente e documentado.
3. **Adicione Casos de Teste em [test/runtests.ts](file:///c:/Users/leona/Documents/Projeto/Opencode/opencode-db-guardrail/test/runtests.ts)**:
   - Garanta testes positivos (deve bloquear) e negativos (não deve bloquear comandos legítimos).
4. **Execute a Suite**:
   ```bash
   npm test
   ```
5. **Abra um Pull Request**: Descreva a motivação da regra, o impacto da operação no banco de dados e cite links para a documentação oficial do motor.
