import { loadConfigFromEnv, Terminal } from '@term/runtime';
import { createApiServer } from './server';

const config = loadConfigFromEnv();
const port = Number(process.env.TERM_API_PORT || 8787);
const dashboardOrigin = process.env.TERM_DASHBOARD_ORIGIN || 'http://localhost:3000';
// In Docker the API must listen on the container interface; publish it to 127.0.0.1 only.
const host = process.env.TERM_API_HOST || '127.0.0.1';

const term = new Terminal(config);
const api = createApiServer(term, { port, dashboardOrigin });

api.server.listen(port, host, async () => {
  term.log.info('engine API listening', { host, port, mode: term.mode.current, offline: config.offline, dataDir: config.dataDir });
  // Optional headless unlock (see SECURITY notes in README).
  const pw = process.env.TERM_VAULT_PASSWORD;
  if (pw && term.vault.isInitialized()) {
    try {
      await term.session.unlock(pw);
      term.log.warn('vault unlocked from TERM_VAULT_PASSWORD (headless mode)');
    } catch {
      term.log.error('TERM_VAULT_PASSWORD did not unlock the vault');
    }
  }
  delete process.env.TERM_VAULT_PASSWORD;
  term.startBackground();
});

const shutdown = async () => {
  term.log.info('shutting down');
  await api.close();
  term.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
