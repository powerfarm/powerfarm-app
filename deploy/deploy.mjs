#!/usr/bin/env node

// Deploya os 18 Workers do Cloudflare OS nesta conta.
//
// O que este arquivo resolve — e que faltava na instalação anterior, obrigando-a a ser
// remendada à mão: os wrangler.jsonc do repo NÃO são deployáveis como estão, de propósito.
// Faltam neles, por design da Cloudflare:
//
//   - os service bindings GATEKEEPER_* no router e no workshop-backend (injetados no deploy)
//   - ids de produção de KV (só têm preview_id) e o nome real do bucket R2
//   - as identidades <prefixo>-* em vez dos nomes genéricos
//   - as vars de Access (ADMINS, CF_ACCESS_ISS, CF_ACCESS_AUD) e de URL
//
// A lista do que existe e do que cada Worker exige NÃO é inventada aqui: sai de
// scripts/testdata/golden-manifest.json, que o upstream gera dos wrangler.jsonc reais e
// mantém sob teste — mudar um wrangler.jsonc quebra o golden até ele ser regenerado.
//
// Uso:
//   node deploy/deploy.mjs --check    valida e faz dry-run, não toca na conta
//   node deploy/deploy.mjs            deploya de verdade

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = "wrangler.generated.json";

// ─── inventário ───────────────────────────────────────────────────────────────

/** Identidade permanente de cada Worker. Mudar isto órfã a instalação anterior. */
export function workerName(pkg, prefix) {
  if (pkg === "router") return prefix;
  if (pkg === "workshop-backend") return `${prefix}-backend`;
  if (pkg.startsWith("gatekeeper-")) return `${prefix}-gk-${pkg.slice("gatekeeper-".length)}`;
  throw new Error(`pacote sem convenção de nome: ${pkg}`);
}

const shortName = (pkg) => pkg.slice("gatekeeper-".length);
const bindingName = (pkg) => `GATEKEEPER_${shortName(pkg).toUpperCase().replace(/-/g, "_")}`;

/**
 * Ordem de deploy. Os gatekeepers primeiro porque backend e router se ligam a eles por
 * service binding — um binding para um Worker inexistente falha o upload. O router por
 * último porque é ele que detém o hostname público: só entra quando o que está atrás
 * dele já responde.
 */
const RANK = { gatekeeper: 0, backend: 1, router: 2 };

export function plan(manifest, config) {
  const chosen = config.gatekeepers === "todos" ? null : new Set(config.gatekeepers);
  return Object.entries(manifest.workers)
      .filter(([pkg, w]) =>
        // preinstall entra sempre: o Workshop conta com eles como ambientes.
        w.kind !== "gatekeeper" || !chosen || w.preinstall || chosen.has(shortName(pkg)))
      .map(([pkg, w]) => ({ pkg, entry: w, name: workerName(pkg, config.namePrefix) }))
      .sort((a, b) => RANK[a.entry.kind] - RANK[b.entry.kind] || a.name.localeCompare(b.name));
}

// ─── geração de config ────────────────────────────────────────────────────────

/**
 * Constrói o wrangler.jsonc derivado de um pacote: parte do config real (que tem main,
 * build e rules corretos) e sobrepõe só o que precisa de resolução. Nunca edita o arquivo
 * do repo — o derivado é temporário e removido no fim, inclusive em caso de falha.
 */
export function deriveConfig({ pkg, entry, name }, { config, steps }) {
  const base = parse(readFileSync(join(ROOT, "packages", pkg, "wrangler.jsonc"), "utf8"));
  const out = structuredClone(base);

  out.name = name;
  out.account_id = config.accountId;

  out.observability = {
    ...out.observability,
    enabled: config.observability.enabled,
    head_sampling_rate: config.observability.headSamplingRate,
    logs: { ...out.observability?.logs, invocation_logs: config.observability.invocationLogs },
    ...(out.observability?.traces ? { traces: {
      enabled: config.observability.traces.enabled,
      head_sampling_rate: config.observability.traces.headSamplingRate,
    } } : {}),
  };

  // KV e R2: sem id/bucket_name explícito, o Wrangler provisiona na primeira vez e
  // reconecta nas seguintes pelo nome. preview_id é de dev e não pode vazar pra produção.
  if (out.kv_namespaces) {
    out.kv_namespaces = out.kv_namespaces.map(({ binding }) => ({
      binding,
      // nome derivado do dono + binding, igual ao que já existe na conta
      title: `${name}-${binding.toLowerCase().replace(/_/g, "-")}`,
    }));
  }
  if (out.r2_buckets) {
    out.r2_buckets = out.r2_buckets.map(({ binding }) => ({
      binding,
      bucket_name: `${config.namePrefix}-${binding.toLowerCase().replace(/_/g, "-")}`,
    }));
  }

  // Service bindings já declarados no repo (o router → backend) apontam para nomes
  // genéricos; reescreve para as identidades desta instalação.
  if (out.services) {
    out.services = out.services.map((s) => ({
      ...s, service: workerName(s.service, config.namePrefix),
    }));
  }

  out.vars = { ...out.vars };

  if (entry.kind === "backend") {
    out.vars.PUBLIC_BASE_URL = config.publicBaseUrl;
    out.vars.ADMINS = config.access.admins;
    out.vars.CF_ACCESS_ISS = config.access.issuer.replace(/\/$/, "");
    out.vars.CF_ACCESS_AUD = config.access.audience;
    if (config.aiGateway.enabled) {
      out.vars.CF_AI_GATEWAY = config.aiGateway.name;
      out.vars.CF_AI_GATEWAY_ACCOUNT_ID = config.aiGateway.accountId;
      out.vars.CF_AI_GATEWAY_PROVIDERS = config.aiGateway.providers.join(",");
    }
    // O manifest crava este binding em todo backend: o webFetch depende dele para
    // converter páginas em markdown, e não custa nada quando não usado.
    out.ai = { binding: "WORKERS_AI" };
  } else if (entry.kind === "gatekeeper") {
    out.vars.BASE_URL = `${config.publicBaseUrl}/gatekeeper/${shortName(pkg)}`;
  }

  // A costura: backend e router recebem um binding para cada gatekeeper instalado.
  // O backend fala RPC pelo entrypoint GatekeeperVendor; o router encaminha HTTP inteiro
  // pelo entrypoint padrão. É isto que o manifest chama de gatekeeperBindingExpansion, e
  // é exatamente o que não está nos wrangler.jsonc do repo.
  if (entry.gatekeeperBindingExpansion) {
    const { entrypoint, propsByPackage = {} } = entry.gatekeeperBindingExpansion;
    const expanded = steps
        .filter((s) => s.entry.kind === "gatekeeper")
        .map((s) => {
          const props = propsByPackage[s.pkg];
          return {
            binding: bindingName(s.pkg),
            service: s.name,
            ...(entrypoint ? { entrypoint } : {}),
            ...(props ? { props: resolveProps(props, config) } : {}),
          };
        });
    out.services = [...(out.services ?? []), ...expanded];
  }

  if (entry.kind === "router") {
    if (config.route.customDomain) {
      out.routes = [{ pattern: config.route.customDomain, custom_domain: true }];
      out.workers_dev = false;
    } else {
      out.workers_dev = true;
    }
  }

  return out;
}

function resolveProps(props, config) {
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [
    k, v === "$PUBLIC_BASE_URL" ? config.publicBaseUrl : v,
  ]));
}

// ─── execução ─────────────────────────────────────────────────────────────────

function run(args, cwd) {
  const r = spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cwd}: pnpm ${args.join(" ")} falhou`);
}

function main() {
  const config = parse(readFileSync(join(ROOT, "deploy", "powerfarm.jsonc"), "utf8"));
  const placeholder = JSON.stringify(config).match(/<[A-Z_]+>/)?.[0];
  if (placeholder) {
    throw new Error(`deploy/powerfarm.jsonc ainda tem o placeholder ${placeholder}`);
  }

  const manifest = JSON.parse(
      readFileSync(join(ROOT, "scripts", "testdata", "golden-manifest.json"), "utf8"));
  const steps = plan(manifest, config);
  const check = process.argv.includes("--check");

  console.log(`${steps.length} Workers, ordem: ${steps.map((s) => s.name).join(" → ")}\n`);

  const written = [];
  try {
    for (const step of steps) {
      const derived = deriveConfig(step, { config, steps });
      const path = join(ROOT, "packages", step.pkg, GENERATED);
      writeFileSync(path, JSON.stringify(derived, null, 2) + "\n");
      written.push(path);
    }
    for (const step of steps) {
      console.log(`\n─── ${step.name} (${step.pkg}) ───`);
      run(["exec", "wrangler", "deploy", "--config", GENERATED, ...(check ? ["--dry-run"] : [])],
          join(ROOT, "packages", step.pkg));
    }
  } finally {
    written.forEach((p) => rmSync(p, { force: true }));
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    main();
  } catch (error) {
    console.error(`\nfalhou: ${error.message}`);
    process.exitCode = 1;
  }
}
