// Run: npx tsx dev-tests/tomatina.test.ts
// The tomato sound (lib/tomatina.ts): which namespace names count, and that the live events carry the mosaics it needs.
import { eventHasTomato, hasTomatoLevel } from '../src/lib/tomatina';
import { parseLiveMessage } from '../src/lib/symbol/live';
import { createLiveReporter } from '../src/lib/nem/liveReporter';
import { isLiveSoundTheme, LIVE_SOUND_THEMES } from '../src/lib/liveSound';
import type { LiveEvent } from '../src/lib/symbol/live';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

// ---- which names count
check('sub namespace', hasTomatoLevel('foo.tomato'));
check('sub-sub namespace', hasTomatoLevel('foo.bar.tomato'));
check('2nd level of three', hasTomatoLevel('foo.tomato.bar'));
check('case-insensitive', hasTomatoLevel('Foo.TOMATO'));
check('root only is not enough', !hasTomatoLevel('tomato'));
check('root with other child', !hasTomatoLevel('tomato.foo'));
check('part of a word is not enough', !hasTomatoLevel('foo.tomatoes') && !hasTomatoLevel('foo.mytomato'));
check('unrelated', !hasTomatoLevel('symbol.xym'));

// ---- the theme
check('tomatina is a theme', LIVE_SOUND_THEMES.includes('tomatina') && isLiveSoundTheme('tomatina'));

// ---- Symbol: the WebSocket message carries the mosaic ids (also inside an aggregate)
const transfer = parseLiveMessage(JSON.stringify({ topic: 'unconfirmedAdded/ADDR', data: { meta: { hash: 'AB' }, transaction: { type: 16724, mosaics: [{ id: '72C0212E67A08BCE', amount: '1' }, { id: '1122334455667788', amount: '2' }] } } }));
check('transfer mosaic ids', JSON.stringify(transfer?.mosaicIds) === JSON.stringify(['72C0212E67A08BCE', '1122334455667788']));
const aggregate = parseLiveMessage(JSON.stringify({ topic: 'confirmedAdded/ADDR', data: { meta: { hash: 'CD' }, transaction: { type: 16705, transactions: [{ transaction: { type: 16724, mosaics: [{ id: 'AAAAAAAAAAAAAAAA' }] } }] } } }));
check('aggregate inner mosaic ids', JSON.stringify(aggregate?.mosaicIds) === JSON.stringify(['AAAAAAAAAAAAAAAA']));
check('no mosaics -> empty', parseLiveMessage(JSON.stringify({ topic: 'confirmedAdded/ADDR', data: { meta: { hash: 'EF' }, transaction: { type: 16724 } } }))?.mosaicIds?.length === 0);

// ---- NEM: the reporter passes the mosaic names on (also for the "unconfirmed" told just before a "confirmed")
const got: LiveEvent[] = [];
const reporter = createLiveReporter((e) => got.push(e), 0);
reporter.prime();
reporter.reportConfirmed(['sig1'], 'h1', 257, ['foo.tomato']);
check('NEM events carry the names', got.length === 2 && got.every((e) => e.mosaicNames?.[0] === 'foo.tomato'));
reporter.stop();

(async () => {
  check('NEM event with tomato', await eventHasTomato({ kind: 'confirmed', hash: 'h', mosaicNames: ['a.b.tomato'] }, 'nem'));
  check('NEM event without tomato', !(await eventHasTomato({ kind: 'confirmed', hash: 'h', mosaicNames: ['nem.xem'] }, 'nem')));
  check('NEM event with no mosaics', !(await eventHasTomato({ kind: 'confirmed', hash: 'h' }, 'nem')));
  check('Symbol event with no mosaics needs no look-up', !(await eventHasTomato({ kind: 'confirmed', hash: 'h', mosaicIds: [] }, 'symbol')));
  if (failed > 0) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log('all passed');
})();
