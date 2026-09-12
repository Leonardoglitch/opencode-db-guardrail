import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * opencode-db-guardrail
 *
 * Bloqueia comandos bash destrutivos para bases de dados antes de
 * serem executados pelo opencode. Inspirado na abordagem em camadas
 * do opencode-codex-guardrails (github.com/Yulimfish/opencode-codex-guardrails):
 * segmentação de comandos encadeados, expansão de shell-wrappers /
 * interpretadores one-liner, e um log de auditoria persistente —
 * com suporte a configuração externa personalizável por projeto (guardrail.config.json)
 * e exceções auditáveis (allowlist) com justificativa obrigatória.
 */

export type Severity = "critical" | "risky"

export interface Rule {
  id?: string | undefined
  pattern: RegExp
  label: string
  severity: Severity
}

export interface CustomRuleConfig {
  id?: string
  pattern: string
  flags?: string
  label: string
  severity?: Severity
}

export interface AllowlistEntryConfig {
  id?: string
  pattern: string
  flags?: string
  reason: string // Justificativa obrigatória para auditoria e compliance
}

export interface AllowlistEntry {
  id?: string | undefined
  pattern: RegExp
  reason: string
}

export interface GuardrailConfig {
  log?: {
    enabled?: boolean
    path?: string
  }
  toast?: {
    enabled?: boolean
  }
  rules?: {
    disableDefaults?: string[]
    custom?: CustomRuleConfig[]
  }
  allowlist?: AllowlistEntryConfig[]
  wrappers?: {
    additionalPatterns?: string[]
  }
}

// "critical"  -> operações praticamente irreversíveis (perda total de dados)
// "risky"     -> operações potencialmente perigosas mas por vezes legítimas
export const DEFAULT_RULES: Rule[] = [
  // Padrões genéricos / ANSI SQL / PostgreSQL / MariaDB / MySQL
  { id: "drop-database", pattern: /\bdrop\s+database\b/i, label: "DROP DATABASE", severity: "critical" },
  { id: "drop-schema", pattern: /\bdrop\s+schema\b/i, label: "DROP SCHEMA", severity: "critical" },
  { id: "truncate-table", pattern: /\btruncate\s+table\b/i, label: "TRUNCATE TABLE", severity: "critical" },
  { id: "mongo-drop-database", pattern: /mongosh?[^\n]*dropDatabase/i, label: "MongoDB dropDatabase", severity: "critical" },
  { id: "mysqladmin-drop", pattern: /mysqladmin\s+.*drop\b/i, label: "mysqladmin drop", severity: "critical" },
  {
    id: "docker-db-volume-rm",
    pattern: /docker\s+.*rm\s+.*-v\b.*(postgres|mysql|mariadb|mongo|redis|cassandra|mssql)/i,
    label: "remoção de volume de DB via docker",
    severity: "critical",
  },
  { id: "delete-without-where", pattern: /\bdelete\s+from\s+\S+\s*;?\s*$/im, label: "DELETE sem WHERE", severity: "risky" },
  { id: "update-without-where", pattern: /\bupdate\s+\S+\s+set\b(?!.*\bwhere\b)/is, label: "UPDATE sem WHERE", severity: "risky" },
  { id: "prisma-migrate-reset", pattern: /prisma\s+migrate\s+reset/i, label: "prisma migrate reset", severity: "risky" },
  { id: "rails-db-drop", pattern: /rails\s+db:drop/i, label: "rails db:drop", severity: "risky" },

  // SQL Server
  { id: "sqlserver-detach-db", pattern: /\b(?:exec\s+)?sp_detach_db\b/i, label: "SQL Server sp_detach_db", severity: "critical" },
  { id: "sqlserver-backup-log-truncate", pattern: /\bbackup\s+log\b.*\bwith\s+truncate_only\b/is, label: "SQL Server BACKUP LOG WITH TRUNCATE_ONLY", severity: "critical" },
  { id: "sqlserver-single-user-rollback", pattern: /\balter\s+database\b.*\bset\s+single_user\b.*\brollback\s+immediate\b/is, label: "SQL Server SET SINGLE_USER ROLLBACK IMMEDIATE", severity: "risky" },

  // Oracle
  { id: "oracle-drop-tablespace", pattern: /\bdrop\s+tablespace\b.*\bincluding\s+contents\b/is, label: "Oracle DROP TABLESPACE INCLUDING CONTENTS", severity: "critical" },
  { id: "oracle-drop-user-cascade", pattern: /\bdrop\s+user\b.*\bcascade\b/is, label: "Oracle DROP USER CASCADE", severity: "critical" },
  { id: "oracle-purge-recyclebin", pattern: /\bpurge\s+(?:recyclebin|dba_recyclebin)\b/i, label: "Oracle PURGE RECYCLEBIN", severity: "critical" },

  // Redis
  { id: "redis-flush", pattern: /(?:\bredis-cli\b.*)?\b(?:flushall|flushdb)\b/i, label: "Redis FLUSHALL / FLUSHDB", severity: "critical" },
  { id: "redis-config-set-dir", pattern: /\bredis-cli\b.*config\s+set\s+(?:dir|dbfilename)\b/i, label: "Redis CONFIG SET dir/dbfilename", severity: "critical" },
  { id: "redis-shutdown-nosave", pattern: /\bredis-cli\b.*shutdown\s+nosave\b/i, label: "Redis SHUTDOWN NOSAVE", severity: "critical" },
  { id: "redis-debug-segfault", pattern: /\bredis-cli\b.*debug\s+segfault\b/i, label: "Redis DEBUG SEGFAULT", severity: "critical" },

  // Cassandra
  { id: "cassandra-drop-keyspace", pattern: /\bdrop\s+keyspace\b/i, label: "Cassandra DROP KEYSPACE", severity: "critical" },
  { id: "cassandra-truncate", pattern: /\bcqlsh\b.*\btruncate\b/is, label: "Cassandra TRUNCATE via cqlsh", severity: "critical" },

  // SQLite
  { id: "sqlite3-backup-destruct", pattern: /\bsqlite3\s+.*\.backup\b/i, label: "SQLite .backup sob rescrita", severity: "risky" },
  { id: "sqlite3-drop-table", pattern: /\bsqlite3\s+.*(?:drop\s+table|delete\s+from\s+\S+\s*;)/i, label: "SQLite DROP TABLE / DELETE sem WHERE via sqlite3 CLI", severity: "critical" },
]

// Wrappers de shell cujo payload interno precisa de ser extraído e reanalisado.
export const DEFAULT_SHELL_WRAPPERS: RegExp[] = [/^\s*(?:sudo\s+)?(?:bash|sh|zsh)\s+-c\s+["'](.+)["']\s*$/is]

// Interpretadores one-liner cujo código inline também precisa de ser analisado.
export const DEFAULT_INTERPRETER_ONE_LINERS: RegExp[] = [
  /^\s*python[23]?\s+-c\s+["'](.+)["']\s*$/is,
  /^\s*node\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*ruby\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*perl\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*php\s+-r\s+["'](.+)["']\s*$/is,
]

export const DEFAULT_AUDIT_LOG_PATH = join(homedir(), ".config", "opencode", "memory", "db-guardrail.log")

function resolveHomePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return join(homedir(), filepath.slice(1))
  }
  return filepath
}

export interface ResolvedGuardrailOptions {
  rules: Rule[]
  allowlist: AllowlistEntry[]
  wrappers: RegExp[]
  auditLogPath: string
  logEnabled: boolean
  toastEnabled: boolean
}

/**
 * Lê e carrega o arquivo guardrail.config.json, se existir.
 * Caso haja falha de parse ou leitura, retorna null ou lança aviso dependendo do contexto.
 */
export async function loadConfigFile(configPath: string): Promise<GuardrailConfig | null> {
  try {
    const raw = await readFile(configPath, "utf8")
    return JSON.parse(raw) as GuardrailConfig
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null
    }
    throw err
  }
}

/**
 * Monta as opções ativas combinando os valores padrão e a configuração externa.
 */
export function buildResolvedOptions(config?: GuardrailConfig | null): ResolvedGuardrailOptions {
  const disabledList = new Set((config?.rules?.disableDefaults ?? []).map((d) => d.trim().toLowerCase()))

  // Filtra regras padrão não desativadas (permite desativar por label ou id)
  const activeRules: Rule[] = DEFAULT_RULES.filter((rule) => {
    const labelMatch = disabledList.has(rule.label.toLowerCase())
    const idMatch = rule.id ? disabledList.has(rule.id.toLowerCase()) : false
    return !labelMatch && !idMatch
  })

  // Adiciona regras customizadas
  if (config?.rules?.custom && Array.isArray(config.rules.custom)) {
    for (const item of config.rules.custom) {
      if (!item.pattern || !item.label) continue
      try {
        const regex = new RegExp(item.pattern, item.flags ?? "i")
        activeRules.push({
          id: item.id,
          pattern: regex,
          label: item.label,
          severity: item.severity === "risky" ? "risky" : "critical",
        })
      } catch {
        // Ignora regras com regex malformatado
      }
    }
  }

  // Monta lista de allowlist auditável (exige reason não vazio)
  const allowlist: AllowlistEntry[] = []
  if (config?.allowlist && Array.isArray(config.allowlist)) {
    for (const item of config.allowlist) {
      if (!item.pattern || !item.reason || !item.reason.trim()) {
        // Entradas sem reason ou sem pattern são ignoradas por compliance
        continue
      }
      try {
        const regex = new RegExp(item.pattern, item.flags ?? "i")
        allowlist.push({
          id: item.id,
          pattern: regex,
          reason: item.reason.trim(),
        })
      } catch {
        // Ignora allowlist com regex malformatado
      }
    }
  }

  // Monta lista de wrappers
  const wrappers: RegExp[] = [...DEFAULT_SHELL_WRAPPERS, ...DEFAULT_INTERPRETER_ONE_LINERS]
  if (config?.wrappers?.additionalPatterns && Array.isArray(config.wrappers.additionalPatterns)) {
    for (const patternStr of config.wrappers.additionalPatterns) {
      try {
        wrappers.push(new RegExp(patternStr, "is"))
      } catch {
        // Ignora padrões de wrapper inválidos
      }
    }
  }

  const rawLogPath = config?.log?.path ?? DEFAULT_AUDIT_LOG_PATH
  const auditLogPath = resolveHomePath(rawLogPath)

  return {
    rules: activeRules,
    allowlist,
    wrappers,
    auditLogPath,
    logEnabled: config?.log?.enabled ?? true,
    toastEnabled: config?.toast?.enabled ?? true,
  }
}

/**
 * Divide um comando pelos operadores de encadeamento de shell (&&, ||, ;, |)
 * para que cada segmento seja avaliado de forma independente.
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function unwrapPayload(segment: string, wrappers: RegExp[]): string[] {
  const found: string[] = []
  for (const wrapper of wrappers) {
    const match = segment.match(wrapper)
    if (match?.[1]) found.push(match[1])
  }
  return found
}

export function matchRule(segment: string, rules: Rule[]): Rule | null {
  for (const rule of rules) {
    if (rule.pattern.test(segment)) return rule
  }
  return null
}

/**
 * Verifica se um segmento ou comando completo corresponde a alguma exceção auditável da allowlist.
 */
export function matchAllowlist(segment: string, command: string, allowlist: AllowlistEntry[]): AllowlistEntry | null {
  for (const entry of allowlist) {
    if (entry.pattern.test(segment) || entry.pattern.test(command)) {
      return entry
    }
  }
  return null
}

/**
 * Analisa recursivamente um comando com as regras e wrappers fornecidos.
 */
export function scanCommand(
  command: string,
  rules: Rule[],
  wrappers: RegExp[],
  depth = 0
): { rule: Rule; matchedText: string } | null {
  if (depth > 4) return null // evita recursão sem fim em payloads maliciosamente aninhados

  for (const segment of splitSegments(command)) {
    const direct = matchRule(segment, rules)
    if (direct) return { rule: direct, matchedText: segment }

    for (const inner of unwrapPayload(segment, wrappers)) {
      const nested = scanCommand(inner, rules, wrappers, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

export async function appendAuditLog(auditPath: string, line: string): Promise<void> {
  try {
    const parentDir = resolve(auditPath, "..")
    await mkdir(parentDir, { recursive: true })
    await appendFile(auditPath, line + "\n", "utf8")
  } catch {
    // Falha a escrever o log não deve impedir o bloqueio em si.
  }
}

export interface DbProtectionPluginOptions {
  configFile?: string
  config?: GuardrailConfig
}

export const DbProtection: Plugin = async ({ client }) => {
  // Procura guardrail.config.json no workspace ou cwd
  const configFilePath = resolve(process.cwd(), "guardrail.config.json")
  let userConfig: GuardrailConfig | null = null

  try {
    userConfig = await loadConfigFile(configFilePath)
  } catch (err: any) {
    await client.app.log({
      body: {
        service: "db-protection",
        level: "warn",
        message: `Aviso: Erro ao carregar ${configFilePath}: ${err.message}. Usando regras padrão.`,
      },
    })
  }

  const options = buildResolvedOptions(userConfig)

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return

      const command: string = output.args?.command ?? ""
      if (!command) return

      const hit = scanCommand(command, options.rules, options.wrappers)
      if (!hit) return

      const { rule, matchedText } = hit
      const timestamp = new Date().toISOString()

      // Verifica se o comando/segmento bate com alguma exceção auditável da allowlist
      const allowHit = matchAllowlist(matchedText, command, options.allowlist)
      if (allowHit) {
        const allowLogLine =
          `[${timestamp}] [ALLOWLIST] ${allowHit.reason} :: ` +
          `regra ignorada: ${rule.label} :: comando original: ${command} :: segmento: ${matchedText}`

        if (options.logEnabled) {
          await appendAuditLog(options.auditLogPath, allowLogLine)
        }

        await client.app.log({
          body: { service: "db-protection", level: "info", message: allowLogLine },
        })

        // Permitido pela allowlist auditada — não lança erro nem bloqueia.
        return
      }

      const logLine =
        `[${timestamp}] [${rule.severity.toUpperCase()}] ${rule.label} :: ` +
        `comando original: ${command} :: segmento detetado: ${matchedText}`

      if (options.logEnabled) {
        await appendAuditLog(options.auditLogPath, logLine)
      }

      await client.app.log({
        body: { service: "db-protection", level: "warn", message: logLine },
      })

      if (options.toastEnabled) {
        try {
          await client.tui.showToast({
            body: {
              title:
                rule.severity === "critical"
                  ? " Comando de base de dados bloqueado"
                  : " Comando de risco bloqueado",
              message: `${rule.label}\n${matchedText}`,
              variant: rule.severity === "critical" ? "error" : "warning",
            },
          })
        } catch {
          // Sem TUI ligada (ex: modo headless) — segue só com o log e o erro abaixo.
        }
      }

      throw new Error(
        `Comando bloqueado pelo db-protection (${rule.severity}): "${rule.label}".\n` +
          `Segmento detetado: ${matchedText}\n` +
          `Comando original: ${command}\n` +
          `Se isto for mesmo intencional, corre o comando manualmente fora do opencode.`
      )
    },
  }
}

export default DbProtection
