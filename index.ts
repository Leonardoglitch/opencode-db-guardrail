import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * opencode-db-guardrail
 *
 * Bloqueia comandos bash destrutivos para bases de dados antes de
 * serem executados pelo opencode. Inspirado na abordagem em camadas
 * do opencode-codex-guardrails (github.com/Yulimfish/opencode-codex-guardrails):
 * segmentação de comandos encadeados, expansão de shell-wrappers /
 * interpretadores one-liner, e um log de auditoria persistente —
 * mas reescrito de raiz e focado especificamente em bases de dados.
 *
 * Instalação (ver README.md para detalhes):
 *   opencode.json -> { "plugin": ["opencode-db-guardrail"] }
 *
 * LIMITAÇÃO CONHECIDA: hooks de plugin do opencode não interceptam,
 * atualmente, chamadas de ferramentas feitas por sub-agentes lançados
 * via `task` (opencode issue #5894). Este plugin protege chamadas do
 * agente principal; não confies nele como única linha de defesa —
 * combina com permissões corretas ao nível da própria base de dados.
 * Ver a secção "Limitações" do README.
 *
 * Ajusta a lista RULES consoante as ferramentas que usas
 * (psql, mysql, mongosh, prisma, rails, docker, etc.).
 */

type Severity = "critical" | "risky"

interface Rule {
  pattern: RegExp
  label: string
  severity: Severity
}

// "critical"  -> operações praticamente irreversíveis (perda total de dados)
// "risky"     -> operações potencialmente perigosas mas por vezes legítimas
const RULES: Rule[] = [
  { pattern: /\bdrop\s+database\b/i, label: "DROP DATABASE", severity: "critical" },
  { pattern: /\bdrop\s+schema\b/i, label: "DROP SCHEMA", severity: "critical" },
  { pattern: /\btruncate\s+table\b/i, label: "TRUNCATE TABLE", severity: "critical" },
  { pattern: /mongosh?[^\n]*dropDatabase/i, label: "MongoDB dropDatabase", severity: "critical" },
  { pattern: /mysqladmin\s+.*drop\b/i, label: "mysqladmin drop", severity: "critical" },
  {
    pattern: /docker\s+.*rm\s+.*-v\b.*(postgres|mysql|mongo)/i,
    label: "remoção de volume de DB via docker",
    severity: "critical",
  },
  { pattern: /\bdelete\s+from\s+\S+\s*;?\s*$/im, label: "DELETE sem WHERE", severity: "risky" },
  { pattern: /\bupdate\s+\S+\s+set\b(?!.*\bwhere\b)/is, label: "UPDATE sem WHERE", severity: "risky" },
  { pattern: /prisma\s+migrate\s+reset/i, label: "prisma migrate reset", severity: "risky" },
  { pattern: /rails\s+db:drop/i, label: "rails db:drop", severity: "risky" },
]

// Wrappers de shell cujo payload interno precisa de ser extraído e reanalisado.
const SHELL_WRAPPERS: RegExp[] = [/^\s*(?:sudo\s+)?(?:bash|sh|zsh)\s+-c\s+["'](.+)["']\s*$/is]

// Interpretadores one-liner cujo código inline também precisa de ser analisado.
const INTERPRETER_ONE_LINERS: RegExp[] = [
  /^\s*python[23]?\s+-c\s+["'](.+)["']\s*$/is,
  /^\s*node\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*ruby\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*perl\s+-e\s+["'](.+)["']\s*$/is,
  /^\s*php\s+-r\s+["'](.+)["']\s*$/is,
]

const AUDIT_LOG_PATH = join(homedir(), ".config", "opencode", "memory", "db-guardrail.log")

/**
 * Divide um comando pelos operadores de encadeamento de shell (&&, ||, ;, |)
 * para que cada segmento seja avaliado de forma independente.
 *
 * NOTA: isto é uma divisão simples baseada em regex, não um parser de shell
 * completo — não lida perfeitamente com aspas aninhadas ou escaping complexo.
 * É uma primeira linha de defesa, não uma sandbox.
 */
function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function unwrapPayload(segment: string): string[] {
  const found: string[] = []
  for (const wrapper of [...SHELL_WRAPPERS, ...INTERPRETER_ONE_LINERS]) {
    const match = segment.match(wrapper)
    if (match?.[1]) found.push(match[1])
  }
  return found
}

function matchRule(segment: string): Rule | null {
  for (const rule of RULES) {
    if (rule.pattern.test(segment)) return rule
  }
  return null
}

/**
 * Analisa recursivamente um comando: primeiro os seus segmentos
 * encadeados, depois — para cada segmento — o payload de qualquer
 * shell-wrapper ou interpretador one-liner que o envolva.
 */
function scanCommand(command: string, depth = 0): { rule: Rule; matchedText: string } | null {
  if (depth > 4) return null // evita recursão sem fim em payloads maliciosamente aninhados

  for (const segment of splitSegments(command)) {
    const direct = matchRule(segment)
    if (direct) return { rule: direct, matchedText: segment }

    for (const inner of unwrapPayload(segment)) {
      const nested = scanCommand(inner, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

async function appendAuditLog(line: string) {
  try {
    await mkdir(join(homedir(), ".config", "opencode", "memory"), { recursive: true })
    await appendFile(AUDIT_LOG_PATH, line + "\n", "utf8")
  } catch {
    // Falha a escrever o log não deve impedir o bloqueio em si.
  }
}

export const DbProtection: Plugin = async ({ client }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return

      const command: string = output.args?.command ?? ""
      if (!command) return

      const hit = scanCommand(command)
      if (!hit) return

      const { rule, matchedText } = hit
      const timestamp = new Date().toISOString()
      const logLine =
        `[${timestamp}] [${rule.severity.toUpperCase()}] ${rule.label} :: ` +
        `comando original: ${command} :: segmento detetado: ${matchedText}`

      await appendAuditLog(logLine)
      await client.app.log({
        body: { service: "db-protection", level: "warn", message: logLine },
      })

      // Notificação visível na TUI, além do log e do erro que bloqueia o comando.
      try {
        await client.tui.showToast({
          body: {
            title:
              rule.severity === "critical"
                ? "🛑 Comando de base de dados bloqueado"
                : "⚠️ Comando de risco bloqueado",
            message: `${rule.label}\n${matchedText}`,
            variant: rule.severity === "critical" ? "error" : "warning",
          },
        })
      } catch {
        // Sem TUI ligada (ex: modo headless) — segue só com o log e o erro abaixo.
      }

      throw new Error(
        `🛑 Comando bloqueado pelo db-protection (${rule.severity}): "${rule.label}".\n` +
          `Segmento detetado: ${matchedText}\n` +
          `Comando original: ${command}\n` +
          `Se isto for mesmo intencional, corre o comando manualmente fora do opencode.`
      )
    },
  }
}

export default DbProtection
