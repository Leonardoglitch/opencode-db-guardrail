import { DbProtection, buildResolvedOptions, scanCommand, loadConfigFile } from "../index.js";
import { writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

// Mock do client do Opencode (apenas as partes usadas pelo plugin)
const mockClient = {
  app: {
    log: (args: any) => {
      console.log("[MOCK LOG]", JSON.stringify(args));
    },
  },
  tui: {
    showToast: (args: any) => {
      console.log("[MOCK TOAST]", JSON.stringify(args));
    },
  },
};

async function runTests() {
  console.log("=== INICIANDO TESTE MANUAL DO OPENCODE-DB-GUARDRAIL ===\n");

  // Obtém o plugin padrão (factory assíncrona)
  const pluginFactory = await DbProtection({
    client: mockClient,
  } as unknown as Parameters<typeof DbProtection>[0]);
  const plugin = pluginFactory as unknown as {
    "tool.execute.before": (input: any, output: any) => Promise<void>;
  };

  // Casos de teste padrão: [descrição, comando, deveBloquear (esperado)]
  const defaultTestCases: Array<[string, string, boolean]> = [
    // Perigosos (devem ser bloqueados)
    ["DROP DATABASE direto", "DROP DATABASE producao;", true],
    ["UPDATE sem WHERE", "UPDATE contas SET saldo = 0;", true],
    ["DELETE sem WHERE", "DELETE FROM logs;", true],
    ["Prisma migrate reset", "prisma migrate reset", true],
    ["Rails db:drop", "rails db:drop", true],
    ["bash -c com DROP DATABASE", 'bash -c "DROP DATABASE backup"', true],
    ["node -e com UPDATE sem WHERE", `node -e "require('pg').query('UPDATE t SET x=1')"`, true],
    ["Múltiplos comandos com &&", "echo inicio && DROP DATABASE temp && echo fim", true],
    ["Comando com ponto e vírgula", "DROP DATABASE teste;", true],
    
    // Seguros (devem ser permitidos)
    ["SELECT simples", "SELECT * FROM produtos;", false],
    ["INSERT com valores", "INSERT INTO users (name) VALUES ('test');", false],
    ["UPDATE com WHERE", "UPDATE contas SET saldo = 100 WHERE id = 1;", false],
    ["DELETE com WHERE", "DELETE FROM logs WHERE id < 100;", false],
    ["Comando de sistema", "ls -la", false],
    ["Comando vazio", "", false],
    ["Apenas espaços", "   ", false],
    ["String com palavra-chave", "SELECT 'DROP TABLE' AS nome;", false],
  ];

  let passed = 0;
  let failed = 0;

  for (const [desc, command, shouldBlock] of defaultTestCases) {
    console.log(`\n--- [TESTE PADRÃO] ${desc} ---`);
    console.log(`Comando: "${command}"`);

    const input = { tool: "bash" };
    const output = { args: { command } };

    try {
      await plugin["tool.execute.before"](input, output);
      if (shouldBlock) {
        console.log(" FALHA: Esperava bloqueio, mas comando foi permitido.");
        failed++;
      } else {
        console.log(" OK: Comando seguro permitido.");
        passed++;
      }
    } catch (err: any) {
      if (shouldBlock) {
        console.log(" OK: Comando perigoso bloqueado.");
        console.log(`   Erro: ${err.message.split('\n')[0]}`);
        passed++;
      } else {
        console.log(" FALHA: Comando seguro bloqueado indevidamente.");
        console.log(`   Erro: ${err.message}`);
        failed++;
      }
    }
  }

  console.log("\n=== TESTANDO CONFIGURAÇÃO EXTERNA (guardrail.config.json) ===");

  // Teste 1: Regras customizadas e desativação de regras padrão via buildResolvedOptions
  const customConfig = {
    rules: {
      disableDefaults: ["rails db:drop", "prisma-migrate-reset"],
      custom: [
        {
          pattern: "\\bdrop\\s+table\\b",
          flags: "i",
          label: "DROP TABLE",
          severity: "critical" as const
        }
      ]
    },
    wrappers: {
      additionalPatterns: [
        "^\\s*pipenv\\s+run\\s+python\\s+-c\\s+[\"'](.+)[\"']\\s*$"
      ]
    }
  };

  const resolved = buildResolvedOptions(customConfig);

  // 1.1: rails db:drop deve ser permitido agora
  const railsHit = scanCommand("rails db:drop", resolved.rules, resolved.wrappers);
  if (!railsHit) {
    console.log(" OK: 'rails db:drop' foi desativado com sucesso.");
    passed++;
  } else {
    console.log(" FALHA: 'rails db:drop' deveria ter sido ignorado.");
    failed++;
  }

  // 1.2: prisma migrate reset deve ser permitido agora (desativado por id)
  const prismaHit = scanCommand("prisma migrate reset", resolved.rules, resolved.wrappers);
  if (!prismaHit) {
    console.log(" OK: 'prisma-migrate-reset' (por id) foi desativado com sucesso.");
    passed++;
  } else {
    console.log(" FALHA: 'prisma migrate reset' deveria ter sido ignorado.");
    failed++;
  }

  // 1.3: DROP TABLE customizado deve ser bloqueado agora
  const dropTableHit = scanCommand("DROP TABLE usuarios;", resolved.rules, resolved.wrappers);
  if (dropTableHit && dropTableHit.rule.label === "DROP TABLE") {
    console.log(" OK: Regra customizada 'DROP TABLE' bloqueada com sucesso.");
    passed++;
  } else {
    console.log(" FALHA: Regra customizada 'DROP TABLE' não foi bloqueada.");
    failed++;
  }

  // 1.4: Wrapper customizado (pipenv run python -c) deve desencapsular e bloquear
  const wrapperHit = scanCommand("pipenv run python -c \"DROP DATABASE teste;\"", resolved.rules, resolved.wrappers);
  if (wrapperHit && wrapperHit.rule.label === "DROP DATABASE") {
    console.log(" OK: Wrapper customizado 'pipenv' desencapsulado e bloqueado com sucesso.");
    passed++;
  } else {
    console.log(" FALHA: Wrapper customizado não detectou payload interno.");
    failed++;
  }

  // Teste 2: Criação e carregamento real de guardrail.config.json no diretório
  const tempConfigPath = resolve(process.cwd(), "guardrail.config.json");
  console.log("\n--- [TESTE INTEGRAÇÃO] Carregamento de guardrail.config.json físico ---");

  try {
    await writeFile(
      tempConfigPath,
      JSON.stringify({
        rules: {
          disableDefaults: ["rails db:drop"],
          custom: [{ pattern: "\\bdrop\\s+view\\b", label: "DROP VIEW" }]
        }
      }),
      "utf8"
    );

    const loadedPluginFactory = await DbProtection({
      client: mockClient,
    } as unknown as Parameters<typeof DbProtection>[0]);
    const loadedPlugin = loadedPluginFactory as unknown as {
      "tool.execute.before": (input: any, output: any) => Promise<void>;
    };

    // rails db:drop agora deve ser permitido
    let railsBlocked = false;
    try {
      await loadedPlugin["tool.execute.before"]({ tool: "bash" }, { args: { command: "rails db:drop" } });
    } catch {
      railsBlocked = true;
    }

    if (!railsBlocked) {
      console.log(" OK: Plugin carregou guardrail.config.json físico e desativou rails db:drop.");
      passed++;
    } else {
      console.log(" FALHA: Plugin não respeitou o guardrail.config.json físico.");
      failed++;
    }

    // DROP VIEW agora deve ser bloqueado
    let viewBlocked = false;
    try {
      await loadedPlugin["tool.execute.before"]({ tool: "bash" }, { args: { command: "DROP VIEW relatorio;" } });
    } catch {
      viewBlocked = true;
    }

    if (viewBlocked) {
      console.log(" OK: Plugin bloqueou regra customizada 'DROP VIEW' carregada do arquivo físico.");
      passed++;
    } else {
      console.log(" FALHA: Plugin não bloqueou regra customizada carregada do arquivo físico.");
      failed++;
    }
  } finally {
    try {
      await unlink(tempConfigPath);
    } catch {}
  }

  // Teste 3: Whitelist / Allowlist (exceções auditáveis)
  console.log("\n=== TESTANDO WHITELIST / ALLOWLIST (EXCEÇÕES AUDITÁVEIS) ===");

  const allowlistConfig = {
    allowlist: [
      {
        pattern: "DELETE\\s+FROM\\s+staging_logs",
        reason: "Limpeza trimestral automatizada de staging"
      },
      {
        pattern: "TRUNCATE\\s+TABLE\\s+temp_cache",
        reason: "Reset de cache efêmero durante rotina de CI"
      },
      {
        pattern: "DROP\\s+DATABASE\\s+teste_invalido",
        reason: "   " // Justificativa em branco -> DEVE ser ignorado por compliance
      }
    ]
  };

  const resolvedAllow = buildResolvedOptions(allowlistConfig);

  // 3.1: Exceção válida na allowlist deve permitir execução de DELETE sem WHERE para staging_logs
  const stagingHit = scanCommand("DELETE FROM staging_logs;", resolvedAllow.rules, resolvedAllow.wrappers);
  if (stagingHit) {
    const { matchAllowlist } = await import("../index.js");
    const allowed = matchAllowlist(stagingHit.matchedText, "DELETE FROM staging_logs;", resolvedAllow.allowlist);
    if (allowed && allowed.reason === "Limpeza trimestral automatizada de staging") {
      console.log(" OK: Allowlist identificou exceção com justificativa válida para staging_logs.");
      passed++;
    } else {
      console.log(" FALHA: Allowlist não identificou exceção válida.");
      failed++;
    }
  } else {
    console.log(" FALHA: Comando não foi detectado pelas regras padrão.");
    failed++;
  }

  // 3.2: DELETE em outra tabela (sem allowlist) continua sendo bloqueado
  const prodHit = scanCommand("DELETE FROM prod_users;", resolvedAllow.rules, resolvedAllow.wrappers);
  if (prodHit) {
    const { matchAllowlist } = await import("../index.js");
    const allowed = matchAllowlist(prodHit.matchedText, "DELETE FROM prod_users;", resolvedAllow.allowlist);
    if (!allowed) {
      console.log(" OK: DELETE em tabela fora da allowlist continua sem bypass.");
      passed++;
    } else {
      console.log(" FALHA: Tabela não permitida recebeu bypass indevido.");
      failed++;
    }
  }

  // 3.3: Entrada com reason em branco deve ter sido descartada (não dá bypass)
  if (resolvedAllow.allowlist.length === 2) {
    console.log(" OK: Entrada de allowlist sem justificativa (reason vazio) foi descartada com sucesso.");
    passed++;
  } else {
    console.log(" FALHA: Entrada sem justificativa foi aceita indevidamente.");
    failed++;
  }

  // 3.4: Teste de integração ponta a ponta com o hook do plugin
  try {
    await writeFile(
      tempConfigPath,
      JSON.stringify({
        allowlist: [
          {
            pattern: "DELETE\\s+FROM\\s+staging_logs",
            reason: "Limpeza de staging permitida"
          }
        ]
      }),
      "utf8"
    );

    let loggedAllowlist = false;
    const clientWithLogger = {
      app: {
        log: (args: any) => {
          if (args?.body?.message?.includes("[ALLOWLIST]")) {
            loggedAllowlist = true;
          }
        }
      },
      tui: mockClient.tui
    };

    const allowPluginFactory = await DbProtection({
      client: clientWithLogger,
    } as unknown as Parameters<typeof DbProtection>[0]);
    const allowPlugin = allowPluginFactory as unknown as {
      "tool.execute.before": (input: any, output: any) => Promise<void>;
    };

    // Comando na allowlist NÃO deve lançar erro
    let allowedErrored = false;
    try {
      await allowPlugin["tool.execute.before"](
        { tool: "bash" },
        { args: { command: "DELETE FROM staging_logs;" } }
      );
    } catch {
      allowedErrored = true;
    }

    if (!allowedErrored && loggedAllowlist) {
      console.log(" OK: Hook permitiu comando da allowlist e gerou log [ALLOWLIST] de auditoria.");
      passed++;
    } else {
      console.log(` FALHA: Hook falhou na allowlist (erro: ${allowedErrored}, log: ${loggedAllowlist}).`);
      failed++;
    }
  } finally {
    try {
      await unlink(tempConfigPath);
    } catch {}
  }

  console.log("\n=== RESUMO FINAL ===");
  console.log(` Passou: ${passed} |  Falhou: ${failed}`);
  
  if (failed > 0) {
    console.log("\n  Alguns testes falharam.");
    process.exit(1);
  } else {
    console.log("\n Todos os testes passaram!");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("\n Erro inesperado:", err);
  process.exit(1);
});