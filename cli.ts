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
  --json                Retorna o resultado em formato JSON

Códigos de saída (Exit Codes):
  0: Permitido (comando seguro ou liberado via allowlist)
  1: Bloqueado (comando viola regra de segurança)
  2: Erro de uso ou argumentos inválidos

Exemplos:
  npx guardrail-cli "psql -c 'DROP DATABASE prod'"
  npx guardrail-cli "SELECT * FROM users"
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
  let commandToScan = ""

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === "-l" || arg === "--list-rules") {
      listRules = true
    } else if (arg === "--json") {
      jsonOutput = true
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
      console.log(JSON.stringify({ allowed: true, status: "safe", command: commandToScan }))
    } else {
      console.log(`[PERMITIDO] Comando seguro: "${commandToScan}"`)
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
        })
      )
    } else {
      console.log(`[PERMITIDO VIA ALLOWLIST]`)
      console.log(`  Comando: "${commandToScan}"`)
      console.log(`  Regra disparada: ${rule.label} (${rule.severity})`)
      console.log(`  Justificativa: ${allowHit.reason}`)
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
      })
    )
  } else {
    console.error(`[BLOQUEADO] Comando perigoso para base de dados detectado!`)
    console.error(`  Severidade: ${rule.severity.toUpperCase()}`)
    console.error(`  Regra violada: "${rule.label}"`)
    console.error(`  Segmento detectado: "${matchedText}"`)
    console.error(`  Comando original: "${commandToScan}"`)
  }
  process.exit(1)
}

main().catch((err) => {
  console.error("Erro inesperado no guardrail-cli:", err)
  process.exit(2)
})
