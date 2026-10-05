#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  errorMessage,
  formatSol,
  rawToDecimalString,
  solToLamports,
  toWire,
  type ExecutionTiming,
  type Plan,
  type PrioritySettings,
} from '@term/core';
import { computeTradeStats, fillsCsv, pnlBreakdownCsv, tradesCsv } from '@term/portfolio';
import { loadConfigFromEnv, Terminal } from '@term/runtime';
import { modeBanner, prompt, promptHidden, table } from './io';

const program = new Command();
program
  .name('sol-term')
  .description('Private Solana multi-wallet trading terminal (CLI)')
  .option('--live', 'run in LIVE mode (requires password re-entry and typed confirmation)')
  .option('--offline', 'no network; mock markets (paper only)')
  .option('-y, --yes', 'skip the confirmation prompt (SIMULATION only; LIVE always confirms)');

let term: Terminal | null = null;

async function open(opts: { unlock?: boolean; plan?: boolean } = {}): Promise<Terminal> {
  const g = program.opts<{ live?: boolean; offline?: boolean }>();
  const cfg = loadConfigFromEnv();
  if (g.offline) cfg.offline = true;
  term = new Terminal(cfg);
  if (opts.unlock !== false) {
    if (!term.vault.isInitialized()) throw new Error('Vault not initialized. Run `sol-term vault init` first.');
    const pw = process.env.TERM_VAULT_PASSWORD || (await promptHidden('Vault password: '));
    await term.session.unlock(pw);
    if (opts.plan) {
      if (g.live) {
        const again = await promptHidden('Re-enter password to enable LIVE trading: ');
        await term.setMode('LIVE', again);
      } else {
        await term.setMode('SIMULATION');
      }
    }
  }
  console.error(modeBanner(term.mode.current));
  return term;
}

function printPlan(p: Plan): void {
  console.log(`\n${p.title}`);
  console.log(`plan ${p.id}  mode ${p.mode}  expires ${new Date(p.expiresAt).toLocaleTimeString()}`);
  console.log(
    table(
      p.legs.map((l) => ({
        leg: l.legId,
        wallet: term?.repos.wallets.byPublicKey(l.wallet)?.label ?? l.wallet.slice(0, 8),
        at: l.offsetMs ? `+${(l.offsetMs / 1000).toFixed(1)}s` : 'now',
        action: l.description,
        fee: formatSol(l.estFeeLamports, 6),
        sim: l.simulation ? (l.simulation.ok ? 'ok' : `FAIL: ${l.simulation.error}`) : '-',
      })),
    ),
  );
  console.log(
    `\nSOL out ${formatSol(p.totals.lamportsOut)} | SOL in ${formatSol(p.totals.lamportsIn)} | est. fees ${formatSol(p.totals.fees, 6)}` +
      (p.params.sourceRemaining !== undefined ? ` | source remaining ${formatSol(BigInt(String(p.params.sourceRemaining)))}` : '') +
      (p.params.expectedSolReceived !== undefined ? ` | expected received ${formatSol(BigInt(String(p.params.expectedSolReceived)))}` : ''),
  );
  for (const w of p.warnings) console.log(`  ! ${w}`);
  for (const b of p.blockers) console.log(`  ✖ BLOCKED: ${b}`);
}

async function confirmAndRun(p: Plan): Promise<void> {
  printPlan(p);
  if (p.blockers.length) throw new Error('Plan has blockers; not executing.');
  const t = term!;
  const yes = program.opts<{ yes?: boolean }>().yes;
  if (t.mode.current === 'LIVE') {
    const a = await prompt(`\nType LIVE to sign and send ${p.legs.length} transaction leg(s) with real funds: `);
    if (a !== 'LIVE') return console.log('Aborted.');
  } else if (!yes) {
    const a = await prompt('\nExecute as paper trades? [y/N] ');
    if (a.toLowerCase() !== 'y') return console.log('Aborted.');
  }
  t.engine.on('leg', (e) => console.log(`  ${e.legId} ${e.status.padEnd(12)} ${e.signature ?? ''} ${e.error ?? ''}`));
  const s = await t.engine.execute(p.id, p.hash);
  console.log(`\n${s.status}: ${s.confirmed} confirmed, ${s.paper} paper, ${s.failed} failed, ${s.skipped} skipped`);
}

const walletsFor = (t: Terminal, o: { group?: string; wallets?: string }) => {
  if (o.wallets) return o.wallets.split(',').map((s) => s.trim());
  const primary = t.wallets.primary()?.publicKey;
  return t.wallets.list({ group: o.group }).map((w) => w.publicKey).filter((pk) => pk !== primary);
};

const priorityOpt = (lvl: string): PrioritySettings => ({ level: lvl as PrioritySettings['level'] });
const timingOpt = (o: { stagger?: string; jitter?: string; concurrency?: string }): ExecutionTiming =>
  o.stagger
    ? { kind: 'staggered', intervalMs: Number(o.stagger), jitterMs: Number(o.jitter ?? 0), concurrency: Number(o.concurrency ?? 4) }
    : { kind: 'simultaneous', concurrency: Number(o.concurrency ?? 8) };

// ---------------------------------------------------------------- vault
const vault = program.command('vault').description('encrypted key vault');
vault.command('init').action(async () => {
  const t = await open({ unlock: false });
  if (t.vault.isInitialized()) throw new Error('Vault already initialized');
  const pw = await promptHidden('New vault password (≥12 chars, passphrase recommended): ');
  if ((await promptHidden('Confirm password: ')) !== pw) throw new Error('Passwords do not match');
  await t.vault.initialize(pw);
  console.log(`Vault created at ${t.config.dbPath}`);
});
vault.command('change-password').action(async () => {
  const t = await open({ unlock: false });
  const old = await promptHidden('Current password: ');
  const pw = await promptHidden('New password: ');
  if ((await promptHidden('Confirm new password: ')) !== pw) throw new Error('Passwords do not match');
  await t.vault.changePassword(old, pw);
  console.log('Password changed; all keys re-encrypted.');
});

// ---------------------------------------------------------------- wallets
const wallet = program.command('wallet').description('manage wallets');
wallet
  .command('generate')
  .requiredOption('-n, --count <n>', 'number of wallets')
  .option('-g, --group <group>')
  .option('-p, --prefix <prefix>', 'label prefix', 'w')
  .option('-t, --tags <tags>', 'comma-separated tags')
  .action(async (o) => {
    const t = await open();
    const ws = t.wallets.generate({ count: Number(o.count), group: o.group ?? null, labelPrefix: o.prefix, tags: o.tags?.split(',') });
    console.log(table(ws.map((w) => ({ label: w.label, publicKey: w.publicKey, group: w.groupName, primary: w.isPrimary ? '★' : '' }))));
  });
wallet
  .command('list')
  .option('-g, --group <group>')
  .option('-a, --archived', 'include archived')
  .action(async (o) => {
    const t = await open();
    console.log(table(t.wallets.list({ group: o.group, includeArchived: o.archived }).map((w) => ({
      id: w.id, label: w.label, publicKey: w.publicKey, group: w.groupName ?? '', tags: w.tags.join(','), primary: w.isPrimary ? '★' : '', archived: w.archived ? 'yes' : '',
    }))));
  });
wallet
  .command('import')
  .option('-f, --file <path>', 'Solana CLI keypair JSON file')
  .option('-l, --label <label>')
  .option('-g, --group <group>')
  .action(async (o) => {
    const t = await open();
    const secret = o.file ? readFileSync(o.file, 'utf8') : await promptHidden('Secret key (base58 or JSON array; input hidden): ');
    const w = t.wallets.importSecret(secret, { label: o.label, group: o.group ?? null });
    console.log(`Imported ${w.label} ${w.publicKey}`);
  });
wallet
  .command('export')
  .requiredOption('-o, --out <file>')
  .option('-g, --group <group>')
  .option('--plaintext', 'export UNENCRYPTED secret keys')
  .option('--i-understand', 'acknowledge plaintext export risk')
  .action(async (o) => {
    const t = await open();
    const pks = t.wallets.list({ group: o.group, includeArchived: true }).map((w) => w.publicKey);
    if (o.plaintext) {
      if (!o.iUnderstand) throw new Error('Plaintext export requires --i-understand');
      const rows = await t.wallets.exportPlaintext(pks, 'I understand this exposes private keys');
      writeFileSync(o.out, JSON.stringify(rows, null, 2), { mode: 0o600 });
    } else {
      const pw = await promptHidden('Export password (different from vault password): ');
      if ((await promptHidden('Confirm export password: ')) !== pw) throw new Error('Passwords do not match');
      writeFileSync(o.out, JSON.stringify(await t.wallets.exportEncrypted(pks, pw), null, 2), { mode: 0o600 });
    }
    console.log(`Exported ${pks.length} wallet(s) to ${o.out}`);
  });
wallet
  .command('import-bundle <file>')
  .description('import an encrypted export bundle')
  .action(async (file) => {
    const t = await open();
    const pw = await promptHidden('Export password: ');
    const ws = await t.wallets.importEncrypted(JSON.parse(readFileSync(file, 'utf8')), pw);
    console.log(`Imported ${ws.length} wallet(s)`);
  });
wallet.command('label <publicKey> <label>').action(async (pk, label) => {
  const t = await open();
  t.wallets.update(pk, { label });
});
wallet
  .command('group <group> <publicKeys...>')
  .description('move wallets into a group ("-" to clear)')
  .action(async (group, pks) => {
    const t = await open();
    t.wallets.bulkUpdate(pks, { groupName: group === '-' ? null : group });
  });
wallet.command('archive <publicKeys...>').action(async (pks) => {
  const t = await open();
  t.wallets.bulkUpdate(pks, { archived: true });
});
wallet.command('primary <publicKey>').action(async (pk) => {
  const t = await open();
  t.wallets.setPrimary(pk);
});

// ---------------------------------------------------------------- read
program
  .command('balances')
  .option('-g, --group <group>')
  .action(async (o) => {
    const t = await open();
    const ws = t.wallets.list({ group: o.group });
    const bals = await t.engine.balances(ws.map((w) => w.publicKey));
    console.log(table(bals.map((b) => ({
      wallet: t.repos.wallets.byPublicKey(b.publicKey)?.label, publicKey: b.publicKey, SOL: formatSol(b.lamports), tokens: b.tokens.filter((x) => x.amountRaw > 0n).length,
    }))));
    console.log(`\nTotal SOL: ${formatSol(bals.reduce((s, b) => s + b.lamports, 0n))}`);
  });

program.command('analyze <mint>').description('token risk analysis').action(async (mint) => {
  const t = await open({ unlock: false });
  const { analysis: a, risk } = await t.analyzeToken(mint);
  console.log(`${a.symbol ?? '?'} (${a.name ?? '?'})  ${mint}`);
  console.log(`price $${a.priceUsd ?? '?'}  liquidity $${Math.round(a.totalLiquidityUsd)}  MC $${a.marketCapUsd ?? '?'}  FDV $${a.fdvUsd ?? '?'}`);
  console.log(`mint authority: ${a.mintInfo.mintAuthority ?? 'revoked'}  freeze authority: ${a.mintInfo.freezeAuthority ?? 'revoked'}`);
  console.log(`top10 ${a.top10Pct}%  top holder ${a.topHolderPct}%  clustered ${a.clusteredHolderPct}%`);
  console.log(`\nRISK SCORE ${risk.score}/100 (${risk.grade})  ${risk.passesPolicy ? 'passes policy' : 'FAILS policy'}`);
  console.log(table(risk.factors.map((f) => ({ factor: f.label, points: `${f.points}/${f.maxPoints}`, severity: f.severity, detail: f.detail }))));
  for (const b of risk.blockers) console.log(`  ✖ ${b}`);
  for (const w of a.warnings) console.log(`  ! ${w}`);
});

program.command('portfolio').action(async () => {
  const t = await open();
  await t.refreshBalances();
  await t.prices.refresh().catch(() => undefined);
  const s = t.portfolio.summary();
  console.log(`Total ${formatSol(s.totalLamports)} SOL  (SOL ${formatSol(s.solLamports)} + tokens ${formatSol(s.tokensLamports)})${s.solUsd ? `  ≈ $${((Number(s.totalLamports) / 1e9) * s.solUsd).toFixed(2)}` : ''}`);
  console.log(`Realized ${formatSol(s.realizedLamports)}  Unrealized ${formatSol(s.unrealizedLamports)}  24h ${s.dailyPnlLamports === null ? 'n/a' : formatSol(s.dailyPnlLamports)}`);
  console.log(table(t.portfolio.tokens().map((x) => ({
    token: x.symbol ?? x.mint.slice(0, 8), amount: rawToDecimalString(x.totalRaw, x.decimals, 2), value: x.valueLamports === null ? '?' : formatSol(x.valueLamports),
    pnl: formatSol(x.totalPnlLamports), ret: x.returnPct === null ? '' : `${x.returnPct.toFixed(1)}%`, wallets: x.wallets.length,
  }))));
});

program
  .command('analytics')
  .option('--csv <dir>', 'write trades/fills/pnl CSVs to a directory')
  .action(async (o) => {
    const t = await open();
    const fills = t.repos.fills.list({ paper: false });
    const s = computeTradeStats(fills);
    console.log(JSON.stringify(toWire({ ...s, equityCurve: undefined, bestTrade: s.bestTrade?.realized, worstTrade: s.worstTrade?.realized }), null, 2));
    if (o.csv) {
      mkdirSync(o.csv, { recursive: true });
      writeFileSync(join(o.csv, 'trades.csv'), tradesCsv(fills));
      writeFileSync(join(o.csv, 'fills.csv'), fillsCsv(fills));
      writeFileSync(join(o.csv, 'pnl.csv'), pnlBreakdownCsv(s));
      console.log(`CSV written to ${o.csv}`);
    }
  });

// ---------------------------------------------------------------- plans
program
  .command('distribute')
  .description('distribute SOL from the primary wallet')
  .requiredOption('--total <sol>', 'SOL to distribute (ignored for random)')
  .option('-g, --group <group>')
  .option('-w, --wallets <list>', 'comma-separated public keys')
  .option('--mode <mode>', 'equal | random', 'equal')
  .option('--min <sol>', 'random: min per wallet')
  .option('--max <sol>', 'random: max per wallet')
  .option('--gas <sol|auto>', 'extra gas reserve per wallet', 'auto')
  .option('--min-balance <sol>')
  .option('--max-balance <sol>')
  .option('--priority <level>', 'none|low|medium|high|turbo', 'low')
  .action(async (o) => {
    const t = await open({ plan: true });
    const spec = o.mode === 'random' ? { kind: 'random' as const, min: solToLamports(o.min), max: solToLamports(o.max) } : { kind: 'equal' as const };
    const p = await t.engine.previewDistribution({
      recipients: walletsFor(t, o), total: solToLamports(o.total), spec, priority: priorityOpt(o.priority),
      gasReserve: o.gas === 'auto' ? 'auto' : solToLamports(o.gas),
      constraints: { minWalletBalance: o.minBalance ? solToLamports(o.minBalance) : undefined, maxWalletBalance: o.maxBalance ? solToLamports(o.maxBalance) : undefined },
    });
    await confirmAndRun(p);
  });

const tradeOpts = (c: Command) =>
  c
    .option('-g, --group <group>')
    .option('-w, --wallets <list>')
    .option('--slippage <bps>', 'max slippage in bps', '300')
    .option('--priority <level>', 'none|low|medium|high|turbo', 'medium')
    .option('--stagger <ms>', 'stagger interval')
    .option('--jitter <ms>', 'random jitter ±ms')
    .option('--concurrency <n>')
    .option('--strategy <id>', 'strategy tag / preset id');

tradeOpts(program.command('buy <mint>'))
  .option('--sol-per-wallet <sol>')
  .option('--total <sol>', 'total SOL split equally')
  .option('--pct <pct>', '% of each wallet’s available SOL')
  .option('--no-risk', 'skip the risk-policy gate')
  .action(async (mint, o) => {
    const t = await open({ plan: true });
    const sizing = o.solPerWallet
      ? { kind: 'fixed' as const, amount: solToLamports(o.solPerWallet) }
      : o.total
        ? { kind: 'total' as const, total: solToLamports(o.total), allocation: { kind: 'equal' as const } }
        : { kind: 'percentOfWallet' as const, pct: Number(o.pct ?? 0) };
    const extraBlockers: string[] = [];
    if (o.risk !== false) {
      const preset = o.strategy ? t.repos.strategies.get(o.strategy) : undefined;
      const { risk } = await t.analyzeToken(mint, { policy: preset?.risk });
      console.log(`risk score ${risk.score}/100 (${risk.grade})`);
      extraBlockers.push(...risk.blockers.map((b) => `risk policy: ${b}`));
    }
    const p = await t.engine.previewTrade({
      mint, side: 'BUY', wallets: walletsFor(t, o), sizing, timing: timingOpt(o), slippageBps: Number(o.slippage), priority: priorityOpt(o.priority),
      strategyTag: o.strategy ?? null, extraBlockers,
    });
    await confirmAndRun(p);
  });

tradeOpts(program.command('sell <mint>'))
  .option('--pct <pct>', '% of each wallet’s holding', '100')
  .action(async (mint, o) => {
    const t = await open({ plan: true });
    await t.refreshBalances();
    const p = await t.positions.previewSellPercent({
      mint, pct: Number(o.pct), wallets: o.wallets || o.group ? walletsFor(t, o) : undefined, slippageBps: Number(o.slippage), priority: priorityOpt(o.priority), timing: timingOpt(o),
    });
    await confirmAndRun(p);
  });

program
  .command('consolidate')
  .option('-g, --group <group>')
  .option('-w, --wallets <list>')
  .option('--reserve <sol>', 'SOL to leave in each wallet', '0')
  .option('--no-tokens', 'SOL only')
  .option('--no-close', 'do not close empty token accounts')
  .action(async (o) => {
    const t = await open({ plan: true });
    const p = await t.positions.previewConsolidation({
      wallets: walletsFor(t, o), solReserve: solToLamports(o.reserve), tokens: o.tokens !== false, closeEmptyAccounts: o.close !== false,
    });
    await confirmAndRun(p);
  });

const paper = program.command('paper').description('SIMULATION helpers');
paper.command('deposit <sol> [publicKey]').description('credit paper SOL (default: primary wallet)').action(async (sol, pk) => {
  const t = await open({ plan: true });
  const target = pk ?? t.wallets.primary()?.publicKey;
  if (!target) throw new Error('no primary wallet');
  t.engine.paperDeposit(target, solToLamports(sol));
  console.log(`Credited ${sol} paper SOL to ${target}`);
});

program.command('emergency-exit').description('sell 100% of every token in every wallet').action(async () => {
  const t = await open({ plan: true });
  await t.refreshBalances();
  for (const p of await t.positions.previewEmergencyExit()) await confirmAndRun(p);
});

program
  .parseAsync()
  .catch((e) => {
    console.error(`error: ${errorMessage(e)}`);
    process.exitCode = 1;
  })
  .finally(() => term?.close());
