import { DbProtection } from "../index.js";

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

  // Obtém o plugin (factory assíncrona)
  const pluginFactory = await DbProtection({
    client: mockClient,
  } as unknown as Parameters<typeof DbProtection>[0]);
  const plugin = pluginFactory as unknown as {
    "tool.execute.before": (input: any, output: any) => Promise<void>;
  };

  // Casos de teste: [descrição, comando, deveBloquear (esperado)]
  const testCases: Array<[string, string, boolean]> = [
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

  for (const [desc, command, shouldBlock] of testCases) {
    console.log(`\n--- [TESTE] ${desc} ---`);
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

  console.log("\n=== RESUMO ===");
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