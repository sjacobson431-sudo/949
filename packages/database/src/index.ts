import { Db } from './db';
import { AuditRepo, PlanRepo } from './repos/audit';
import { FillRepo } from './repos/fills';
import { ExitRuleRepo, SettingsRepo, SnapshotRepo, StrategyRepo, TriggerOrderRepo, WhitelistRepo } from './repos/misc';
import { VaultRepo } from './repos/vault';
import { WalletRepo } from './repos/wallets';

export * from './db';
export * from './schema';
export * from './repos/audit';
export * from './repos/fills';
export * from './repos/misc';
export * from './repos/vault';
export * from './repos/wallets';

export interface Repositories {
  db: Db;
  vault: VaultRepo;
  wallets: WalletRepo;
  whitelist: WhitelistRepo;
  settings: SettingsRepo;
  plans: PlanRepo;
  audit: AuditRepo;
  fills: FillRepo;
  snapshots: SnapshotRepo;
  strategies: StrategyRepo;
  exitRules: ExitRuleRepo;
  triggers: TriggerOrderRepo;
}

export function openDatabase(path: string): Repositories {
  const db = new Db(path);
  return {
    db,
    vault: new VaultRepo(db),
    wallets: new WalletRepo(db),
    whitelist: new WhitelistRepo(db),
    settings: new SettingsRepo(db),
    plans: new PlanRepo(db),
    audit: new AuditRepo(db),
    fills: new FillRepo(db),
    snapshots: new SnapshotRepo(db),
    strategies: new StrategyRepo(db),
    exitRules: new ExitRuleRepo(db),
    triggers: new TriggerOrderRepo(db),
  };
}
