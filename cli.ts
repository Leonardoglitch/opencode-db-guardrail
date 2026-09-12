#!/usr/bin/env node

import { resolve } from "node:path"
import {
  buildResolvedOptions,
  loadConfigFile,
  matchAllowlist,
  scanCommand,
} from "./index.js"

function printUsage() {
  console.log(`
Uso: guardrail-cli [opções] "<comando>"

Analisa e valida comandos bash contra regras de proteção de banco de dados do opencode-db-guardrail.

Opções:
  -h, --help            Exibe esta mensagem de ajuda
  -l, --list-rules      Lista todas as regras ativas e exceções de allowlist
  -c, --config <caminho> Especifica o caminho de um arquivo guardrail.config.json
  -m, --metrics         Exibe resumo das métricas ao finalizar
  -t, --test-regex <regex> "<cmd>"  Testa uma expressão regular diretamente contra um comando
  --json                Retorna o resultado em formato JSON

Códigos de saída (Exit Codes):
  0: Permitido (comando seguro ou liberado via allowlist)
  1: Bloqueado (comando viola regra de segurança)
  2: Erro de uso ou argumentos inválidos

Exemplos:
  npx guardrail-cli "psql -c 'DROP DATABASE prod'"
  npx guardrail-cli --test-regex "\\bdrop\\s+table\\b" "DROP TABLE users;"
  npx guardrail-cli --list-rules
`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage()
    process.exit(0)
  }

  let configPath = resolve(process.cwd(), "guardrail.config.json")
  let listRules = false
  let jsonOutput = false
  let showMetrics = false
  let testRegexPattern: string | null = null
  let commandToScan = ""

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === "-l" || arg === "--list-rules") {
      listRules = true
    } else if (arg === "--json") {
      jsonOutput = true
    } else if (arg === "-m" || arg === "--metrics") {
      showMetrics = true
    } else if (arg === "-t" || arg === "--test-regex") {
      const nextPattern = args[i + 1]
      if (!nextPattern) {
        console.error("Erro: Regex não fornecido para --test-regex.")
        process.exit(2)
      }
      testRegexPattern = nextPattern
      i++
    } else if (arg === "-c" || arg === "--config") {
      const nextArg = args[i + 1]
      if (!nextArg) {
        console.error("Erro: Caminho do arquivo de configuração não informado.")
        process.exit(2)
      }
      configPath = resolve(process.cwd(), nextArg)
      i++
    } else if (!arg.startsWith("-") && !commandToScan) {
      commandToScan = arg
    }
  }

  // Modo de teste de regex direto
  if (testRegexPattern !== null) {
    if (!commandToScan) {
      console.error("Erro: Nenhum comando informado para testar contra a regex.")
      console.error("Uso: guardrail-cli --test-regex \"<regex>\" \"<comando>\"")
      process.exit(2)
    }

    try {
      // Se o usuário passou barras duplicadas literais (ex: \\b), normaliza para conveniência
      const normalizedPattern = testRegexPattern.replace(/\\\\/g, "\\")
      const regex = new RegExp(normalizedPattern, "i")
      const testRule = { id: "test-regex", pattern: regex, label: "TEST_REGEX", severity: "critical" as const }
      const hit = scanCommand(commandToScan, [testRule], [
        /^\s*(?:sudo\s+)?(?:bash|sh|zsh)\s+-c\s+["'](.+)["']\s*$/is,
        /^\s*python[23]?\s+-c\s+["'](.+)["']\s*$/is,
        /^\s*node\s+-e\s+["'](.+)["']\s*$/is,
      ])

      if (hit) {
        if (jsonOutput) {
          console.log(JSON.stringify({ match: true, pattern: testRegexPattern, matchedText: hit.matchedText, command: commandToScan }))
        } else {
          console.log(`[MATCH] O comando bateu com o regex "${testRegexPattern}"!`)
          console.log(`  Segmento detectado: "${hit.matchedText}"`)
        }
        process.exit(1) // Exit code 1 para indicar detecção de risco
      } else {
        if (jsonOutput) {
          console.log(JSON.stringify({ match: false, pattern: testRegexPattern, command: commandToScan }))
        } else {
          console.log(`[NO MATCH] O comando NÃO bateu com o regex "${testRegexPattern}".`)
        }
        process.exit(0)
      }
    } catch (err: any) {
      console.error(`Erro ao compilar regex "${testRegexPattern}": ${err.message}`)
      process.exit(2)
    }
  }

  let userConfig = null
  try {
    userConfig = await loadConfigFile(configPath)
  } catch (err: any) {
    if (!jsonOutput) {
      console.warn(`[AVISO] Erro ao carregar arquivo de config (${configPath}): ${err.message}. Usando regras padrão.\n`)
    }
  }

  const options = buildResolvedOptions(userConfig)

  if (listRules) {
    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            rules: options.rules.map((r) => ({
              id: r.id,
              label: r.label,
              severity: r.severity,
              pattern: r.pattern.source,
            })),
            allowlist: options.allowlist.map((a) => ({
              id: a.id,
              reason: a.reason,
              pattern: a.pattern.source,
            })),
          },
          null,
          2
        )
      )
    } else {
      console.log("=== REGRAS ATIVAS (opencode-db-guardrail) ===\n")
      console.log("Severidade: CRITICAL")
      for (const r of options.rules.filter((x) => x.severity === "critical")) {
        console.log(`  - [${r.label}] (padrão: ${r.pattern.source})`)
      }
      console.log("\nSeveridade: RISKY")
      for (const r of options.rules.filter((x) => x.severity === "risky")) {
        console.log(`  - [${r.label}] (padrão: ${r.pattern.source})`)
      }

      if (options.allowlist.length > 0) {
        console.log("\n=== EXCEÇÕES AUDITÁVEIS (ALLOWLIST) ===")
        for (const a of options.allowlist) {
          console.log(`  - "${a.pattern.source}" -> Motivo: ${a.reason}`)
        }
      }
    }
    process.exit(0)
  }

  if (!commandToScan) {
    if (jsonOutput) {
      console.log(JSON.stringify({ allowed: false, error: "Nenhum comando fornecido para verificação." }))
    } else {
      console.error("Erro: Nenhum comando fornecido para verificação.\nUse: guardrail-cli \"<comando>\"")
    }
    process.exit(2)
  }

  const hit = scanCommand(commandToScan, options.rules, options.wrappers)

  if (!hit) {
    if (jsonOutput) {
      console.log(
        JSON.stringify({
          allowed: true,
          status: "safe",
          command: commandToScan,
          ...(showMetrics ? { metrics: { totalScanned: 1, allowed: 1, blockedCritical: 0, blockedRisky: 0, allowlistHits: 0, errors: 0 } } : {}),
        })
      )
    } else {
      console.log(`[PERMITIDO] Comando seguro: "${commandToScan}"`)
      if (showMetrics) {
        console.log("\n=== MÉTRICAS ===")
        console.log("  Total escaneado: 1 | Permitidos: 1 | Bloqueados (críticos): 0 | Bloqueados (risco): 0 | Allowlist: 0 | Erros: 0")
      }
    }
    process.exit(0)
  }

  const { rule, matchedText } = hit

  // Verifica allowlist
  const allowHit = matchAllowlist(matchedText, commandToScan, options.allowlist)
  if (allowHit) {
    if (jsonOutput) {
      console.log(
        JSON.stringify({
          allowed: true,
          status: "allowlist",
          command: commandToScan,
          rule: rule.label,
          severity: rule.severity,
          reason: allowHit.reason,
          ...(showMetrics ? { metrics: { totalScanned: 1, allowed: 1, blockedCritical: 0, blockedRisky: 0, allowlistHits: 1, errors: 0 } } : {}),
        })
      )
    } else {
      console.log(`[PERMITIDO VIA ALLOWLIST]`)
      console.log(`  Comando: "${commandToScan}"`)
      console.log(`  Regra disparada: ${rule.label} (${rule.severity})`)
      console.log(`  Justificativa: ${allowHit.reason}`)
      if (showMetrics) {
        console.log("\n=== MÉTRICAS ===")
        console.log("  Total escaneado: 1 | Permitidos: 1 | Bloqueados (críticos): 0 | Bloqueados (risco): 0 | Allowlist: 1 | Erros: 0")
      }
    }
    process.exit(0)
  }

  // Bloqueado
  if (jsonOutput) {
    console.log(
      JSON.stringify({
        allowed: false,
        status: "blocked",
        command: commandToScan,
        matchedSegment: matchedText,
        rule: rule.label,
        severity: rule.severity,
        ...(showMetrics
          ? {
              metrics: {
                totalScanned: 1,
                allowed: 0,
                blockedCritical: rule.severity === "critical" ? 1 : 0,
                blockedRisky: rule.severity === "risky" ? 1 : 0,
                allowlistHits: 0,
                errors: 0,
              },
            }
          : {}),
      })
    )
  } else {
    console.error(`[BLOQUEADO] Comando perigoso para base de dados detectado!`)
    console.error(`  Severidade: ${rule.severity.toUpperCase()}`)
    console.error(`  Regra violada: "${rule.label}"`)
    console.error(`  Segmento detectado: "${matchedText}"`)
    console.error(`  Comando original: "${commandToScan}"`)
    if (showMetrics) {
      console.error("\n=== MÉTRICAS ===")
      console.error(
        `  Total escaneado: 1 | Permitidos: 0 | Bloqueados (críticos): ${rule.severity === "critical" ? 1 : 0} | Bloqueados (risco): ${rule.severity === "risky" ? 1 : 0} | Allowlist: 0 | Erros: 0`
      )
    }
  }
  process.exit(1)
}

main().catch((err) => {
  console.error("Erro inesperado no guardrail-cli:", err)
  process.exit(2)
})
