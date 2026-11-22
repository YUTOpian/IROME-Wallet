// 改名前の環境変数（KASANE_）を、当面は読む。実行: npx tsx dev-tests/legacy-env.test.ts
import { withLegacyEnv } from '../src/server/legacyEnv';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

{
  const e = withLegacyEnv({ KASANE_NODE_AGENT_PORT: '8000', KASANE_DAO_BOT: '1', PATH: '/bin' });
  ok(e.IROME_NODE_AGENT_PORT === '8000', 'old node-agent name is read');
  ok(e.IROME_DAO_BOT === '1', 'old dao-bot name is read');
  ok(e.PATH === '/bin', 'other variables stay');
}
{
  const e = withLegacyEnv({ KASANE_NODE_AGENT_PORT: '8000', IROME_NODE_AGENT_PORT: '9000' });
  ok(e.IROME_NODE_AGENT_PORT === '9000', 'the new name wins');
}
{
  const input = { KASANE_DAO_BOT: '1' };
  withLegacyEnv(input);
  ok(!('IROME_DAO_BOT' in input), 'the input is not modified');
}
console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
