import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// Piped (non-TTY) stdin: one shared line reader so consecutive prompts get consecutive lines.
let pipedLines: AsyncIterator<string> | null = null;
async function nextPipedLine(): Promise<string> {
  pipedLines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const r = await pipedLines.next();
  return r.done ? '' : r.value;
}

/** Prompt without echoing (passwords, secret keys). */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return nextPipedLine();
  let muted = false;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  process.stdout.write(question);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

export async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return (await nextPipedLine()).trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return a.trim();
}

export function table(rows: Record<string, unknown>[], cols?: string[]): string {
  if (!rows.length) return '(none)';
  const keys = cols ?? Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'bigint' ? v.toString() : String(v));
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => cell(r[k]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  return [line(keys), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(keys.map((k) => cell(r[k]))))].join('\n');
}

const C = { red: '\x1b[41;97;1m', amber: '\x1b[43;30;1m', blue: '\x1b[44;97;1m', reset: '\x1b[0m' };
export function modeBanner(mode: string): string {
  const color = mode === 'LIVE' ? C.red : mode === 'SIMULATION' ? C.amber : C.blue;
  const text = mode === 'LIVE' ? ' ● LIVE TRADING — REAL FUNDS ' : mode === 'SIMULATION' ? ' ◐ SIMULATION — paper fills only ' : ' ○ READ-ONLY ';
  return process.stdout.isTTY ? `${color}${text}${C.reset}` : `[${text.trim()}]`;
}
