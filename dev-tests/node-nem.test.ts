// NEM（NIS1）ノードの構築（公式の nem-docker）: 許可の判定・設定ファイル・手順・状態の読み取り・エージェントの固定の手順（偽の git / docker で）。
// 実行: npx tsx dev-tests/node-nem.test.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { COMMAND_PRESETS, NEM_ACTIONS, parseCommandLine, validateArgv, validateWorkspaceFile } from '../src/lib/node/nodeCommands';
import { NEM_CONFIG_PATH, NEM_DOCKER_DIR, NEM_SERVANT_CONFIG_PATH, defaultNemOptions, nemConfigFile, nemMissingTools, nemPropertiesContent, nemServantFile, nemToolsReady, normalizeNemOptions, parseNemNodeStatus, planNemBuild, planNemStart, planNemStop, planNemSupernode, planNemUpdate, randomBootKey, servantPropertiesContent, setProperty, validateNemDir, validateNemHost, validateNemName, validateNemOptions } from '../src/lib/node/nemNode';
import { NEM_GUIDE_STEPS } from '../src/lib/node/nemGuide';
import { normalizeGuideText, parseGuideText } from '../src/lib/node/guideText';
import { NEM_DOCKER_REPO, autostartEnabled, enableAutostart, nemSteps, scriptUsesSudo } from '../src/server/node-agent/nemNode';
import { createAgent } from '../src/server/node-agent/agent';
import { readJob, startJob, writeFile, readFile, fetchStatus } from '../src/lib/node/agentClient';
import type { AgentConn } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const rmSyncSafe = (p: string) => { try { rmSync(p); } catch { /* 無ければよい */ } };
const put = (p: string, body = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

// ---- 許可の判定
for (const a of NEM_ACTIONS) ok(parseCommandLine(`irome nem ${a}`).ok, `irome nem ${a} allowed`);
for (const bad of ['irome nem', 'irome nem rm', 'irome nem supernode x', 'irome nem status -a', 'irome nem Supernode', 'irome nem start now', 'irome nem install x', 'irome nem ../x', 'irome install nem', 'irome uninstall nem', 'irome upgrade nem', 'irome nem  start;ls', 'irome nem $(id)', 'sudo irome nem start', 'git clone https://example.com/x.git', '/bin/sh ./boot.sh', 'sh boot.sh', './boot.sh']) {
  ok(!parseCommandLine(bad).ok, `rejected: ${bad}`);
}
ok(!validateArgv(['irome', 'nem', 'start', '--secret']).ok, 'extra args rejected');
ok(parseCommandLine('irome install docker').ok && parseCommandLine('irome upgrade shoestring').ok, 'existing irome forms still allowed');
ok(!parseCommandLine('irome upgrade nem').ok && !parseCommandLine('irome uninstall nem').ok, 'nem is not an install target');

// ---- ひな型・手順の行は、すべて許可の判定を通る
const nemPresets = COMMAND_PRESETS.filter((p) => p.group === 'nem');
ok(nemPresets.length === 8, 'nem presets', nemPresets.length);
for (const p of COMMAND_PRESETS.filter((x) => x.group === 'nem')) ok(parseCommandLine(p.line).ok, `preset allowed: ${p.line}`);
for (const s of NEM_GUIDE_STEPS) for (const l of s.lines ?? []) ok(COMMAND_PRESETS.some((p) => p.line === l) && parseCommandLine(l).ok, `guide line is a preset and allowed: ${l}`);
const o0 = { ...defaultNemOptions(), dir: 'nem-node', name: 'my node 1' };
for (const plan of [planNemBuild(o0), planNemStart('nem-node'), planNemStop('nem-node'), planNemUpdate('nem-node')]) {
  for (const s of plan) if (s.kind === 'run') ok(parseCommandLine(s.line ?? '').ok, `plan line allowed: ${s.line}`);
}
ok(planNemBuild(o0).map((s) => s.id).join() === 'install,config,start,ps', 'build order');
ok(planNemUpdate('n').map((s) => s.id).join() === 'update,ps' && planNemStop('n').map((s) => s.id).join() === 'stop' && planNemStart('n').map((s) => s.id).join() === 'start,ps', 'other plans');
ok(planNemBuild({ ...o0, dir: ' a/b/ ' }).every((s) => s.kind !== 'run' || s.cwd === 'a/b'), 'cwd normalized');

// ---- 検証
ok(validateNemDir('nem-node') && validateNemDir('a/b'), 'dir ok');
for (const d of ['', '.', '..', '../x', '/abs', 'C:/x', 'tools', 'Tools/x', 'a/../b', 'con', 'x:y']) ok(!validateNemDir(d), `dir rejected: ${JSON.stringify(d)}`);
ok(validateNemName('my-nem-node') && validateNemName('My Node 1') && validateNemName('a'.repeat(64)), 'name ok');
for (const n of ['', '   ', 'a'.repeat(65), 'a=b', 'a#b', 'a\\u3053', 'a!b', 'a:b', 'あ', 'a\nb', 'a\tb']) ok(!validateNemName(n), `name rejected: ${JSON.stringify(n)}`);
const K = 'ab'.repeat(32);
ok(validateNemOptions({ ...o0, bootKey: '' }) === null && validateNemOptions({ ...o0, bootKey: K }) === null && validateNemOptions({ ...o0, bootKey: K.toUpperCase() }) === null, 'key ok / empty ok');
ok(validateNemOptions({ ...o0, bootKey: 'zz' }) === 'key' && validateNemOptions({ ...o0, bootKey: K + 'a' }) === 'key' && validateNemOptions({ ...o0, bootKey: 'ab'.repeat(31) }) === 'key', 'key rejected');
ok(validateNemOptions({ ...o0, dir: 'tools' }) === 'dir' && validateNemOptions({ ...o0, name: '' }) === 'name', 'option errors');
ok(normalizeNemOptions({ ...o0, name: '  x  ', bootKey: ` ${K.toUpperCase()} ` }).bootKey === K && normalizeNemOptions({ ...o0, name: '  x  ' }).name === 'x', 'normalize');
ok(nemToolsReady({ docker: { found: true }, git: { found: true } }) && !nemToolsReady({ docker: { found: true }, git: { found: false } }), 'tools ready');
ok(nemMissingTools({ docker: { found: false }, git: { found: false } }).join() === 'docker,git', 'missing tools');

// ---- boot key（乱数）
const rk = randomBootKey();
ok(/^[0-9a-f]{64}$/.test(rk) && rk !== randomBootKey(), 'random key is 64 hex and differs each time');
ok(randomBootKey((n) => new Uint8Array(n).fill(0x0f)) === '0f'.repeat(32), 'random key formatting');

// ---- 設定ファイル
const mainnet = nemPropertiesContent({ name: 'n1', network: 'mainnet', harvest: false }, K);
ok(mainnet === `nis.bootName = n1\nnis.bootKey = ${K}\n`, 'mainnet properties', mainnet);
ok(!mainnet.includes('nem.network') && !mainnet.includes('nem.folder') && !mainnet.includes('ForkHeight'), 'mainnet has no testnet / folder settings');
const harv = nemPropertiesContent({ name: 'n1', network: 'mainnet', harvest: true }, K);
ok(harv.includes('nis.shouldAutoHarvestOnBoot = true'), 'harvest on');
const test = nemPropertiesContent({ name: 'n1', network: 'testnet', harvest: false }, K);
for (const line of ['nem.network = testnet', 'nis.treasuryReissuanceForkHeight = 1', 'nis.treasuryReissuanceForkTransactionHashes =', 'nis.treasuryReissuanceForkFallbackTransactionHashes =', 'nis.multisigMOfNForkHeight = 1', 'nis.mosaicsForkHeight = 1', 'nis.firstFeeForkHeight = 1', 'nis.secondFeeForkHeight = 1', 'nis.remoteAccountForkHeight = 1', 'nis.mosaicRedefinitionForkHeight = 1']) ok(test.split('\n').includes(line), `testnet has: ${line}`);
ok(!nemPropertiesContent({ name: 'x', network: 'mainnet', harvest: false }, K).includes('\r'), 'LF only');
ok(validateWorkspaceFile(nemConfigFile('nem-node')).ok && nemConfigFile('nem-node') === `nem-node/${NEM_DOCKER_DIR}/${NEM_CONFIG_PATH}`, 'config file path is writable from the screen', nemConfigFile('nem-node'));
ok(!validateWorkspaceFile('nem-node/nem-docker/docker-compose.yml').ok, 'compose files stay protected');
ok(!validateWorkspaceFile('nem-node/nem-docker/boot.sh').ok, 'scripts cannot be written from the screen');

// ---- スーパーノード（公式: Servant の設定・supervisord.conf・service.sh status）
for (const h of ['203.0.113.5', '8.8.8.8', '172.32.0.1', 'node.example.com', 'a.b', 'My-Node.Example.COM']) ok(validateNemHost(h), `host ok: ${h}`);
for (const h of ['', ' ', 'localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.0.1', '172.31.255.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '256.1.1.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', 'example', '-a.com', 'a-.com', 'a b.com', 'a_b.com', 'http://x.com', 'x.com:7890', 'x.com/path', 'a.com\nb', 'あ.jp', 'a'.repeat(64) + '.com', 'a.123']) ok(!validateNemHost(h), `host rejected: ${JSON.stringify(h)}`);
const so = { ...defaultNemOptions(), supernode: true, host: 'node.example.com', bootKey: K };
ok(validateNemOptions(so) === null, 'supernode options ok');
ok(validateNemOptions({ ...so, bootKey: '' }) === 'key_required', 'supernode needs the remote key (never auto-generated)');
ok(validateNemOptions({ ...so, network: 'testnet' }) === 'supernode_network', 'supernode is mainnet only');
ok(validateNemOptions({ ...so, host: '192.168.1.5' }) === 'host' && validateNemOptions({ ...so, host: '' }) === 'host', 'supernode host required and public');
ok(validateNemOptions({ ...defaultNemOptions(), host: 'bad host' }) === null, 'host is not checked unless supernode');
ok(validateNemOptions({ ...so, name: '' }, true) === null && validateNemOptions({ ...so, name: '' }) === 'name', 'existing-node supernode mode ignores the name');
ok(validateNemOptions({ ...so, supernode: false, bootKey: '' }, true) === 'key_required', 'existing-node supernode mode requires key and host');
ok(servantPropertiesContent(' node.example.com ', K) === `nem.host = node.example.com\nservant.key = ${K}\n`, 'servant properties');
ok(normalizeNemOptions({ ...so, host: ' Node.Example.COM ' }).host === 'node.example.com', 'host normalized');
ok(validateWorkspaceFile(nemServantFile('nem-node')).ok && nemServantFile('nem-node') === `nem-node/${NEM_DOCKER_DIR}/${NEM_SERVANT_CONFIG_PATH}`, 'servant config is writable from the screen');
ok(!validateWorkspaceFile('nem-node/nem-docker/custom-configs/supervisord.conf').ok, 'supervisord.conf cannot be written from the screen');
ok(!validateWorkspaceFile('nem-node/nem-docker/service.sh').ok, 'service.sh cannot be written from the screen');
ok(setProperty('# c\nnis.bootName = a\nnis.bootKey = old\nx = 1\n', 'nis.bootKey', 'NEW') === '# c\nnis.bootName = a\nnis.bootKey = NEW\nx = 1\n', 'setProperty replaces the value, keeps the rest');
ok(setProperty('nis.bootName = a\n', 'nis.bootKey', 'K') === 'nis.bootName = a\nnis.bootKey = K\n', 'setProperty appends when absent');
ok(setProperty('nis.bootKey=old\r\nnis.bootKey = dup\n', 'nis.bootKey', 'K').split('\n').filter((l) => l.startsWith('nis.bootKey')).join('|') === 'nis.bootKey = K|nis.bootKey = dup', 'setProperty changes only the first');
ok(setProperty('nis.bootKeyX = 1\n', 'nis.bootKey', 'K').includes('nis.bootKeyX = 1') && setProperty('nis.bootKeyX = 1\n', 'nis.bootKey', 'K').includes('nis.bootKey = K'), 'setProperty does not match a longer key');
ok(planNemBuild(so).map((x) => x.id).join() === 'install,config,servant,supernode,start,status', 'supernode build order');
ok(planNemSupernode(so).map((x) => x.id).join() === 'stop,nisKey,servant,supernode,start,status', 'existing-node supernode order');
for (const plan of [planNemBuild(so), planNemSupernode(so)]) for (const x of plan) if (x.kind === 'run') ok(parseCommandLine(x.line ?? '').ok, `supernode plan line allowed: ${x.line}`);
// supervisord.conf.sample の変換
const sample = '[supervisord]\nnodaemon=true\n\n[program:nis]\ncommand=/x/nis\nautostart=false\nautorestart=true\n\n[program:servant]\ncommand=/x/servant\n; autostart = false\n\n[program:other]\nautostart=false\n';
const ea = enableAutostart(sample);
ok(ea.missing.length === 0 && autostartEnabled(ea.text) && !autostartEnabled(sample), 'autostart enabled for nis and servant only');
ok(ea.text.includes('[program:other]\nautostart=false'), 'other programs untouched');
ok((ea.text.match(/autostart/g) ?? []).length === 3, 'no duplicate autostart lines', ea.text);
ok(enableAutostart('[program:nis]\nx=1\n').missing.join() === 'servant', 'missing program reported');
ok(!autostartEnabled('[program:nis]\nautostart=true\n') && autostartEnabled('[program:nis]\nautostart = true ; x\n[program:servant]\nautostart=TRUE\n'), 'autostartEnabled');
ok(!autostartEnabled('[program:nis]\nautostart=true\n[program:servant]\nautostart=false\n'), 'one false is not enabled');

// ---- 状態の読み取り（信用しない）
const st = parseNemNodeStatus({ metaData: { version: '0.6.102', networkId: 104, application: 'NIS' }, identity: { name: 'bob' } }, { height: 5565850 });
ok(st.height === 5565850 && st.version === '0.6.102' && st.name === 'bob' && st.network === 'mainnet', 'status parsed', st);
ok(parseNemNodeStatus({ metaData: { networkId: -104 } }, { height: 1 }).network === 'testnet', 'testnet id');
const bad = parseNemNodeStatus({ metaData: { version: 'x'.repeat(100), networkId: 7 }, identity: { name: 'a\nb' } }, { height: -3 });
ok(bad.height === null && bad.version === null && bad.name === null && bad.network === null, 'bad values dropped', bad);
ok(parseNemNodeStatus(null, 'x').height === null && parseNemNodeStatus([], { height: 1.5 }).height === null, 'non-objects / non-integers dropped');

// ---- スクリプトの sudo 判定
const tmp = mkdtempSync(join(tmpdir(), 'irome-nem-'));
put(join(tmp, 'a.sh'), '#!/bin/sh\ndocker build -t x .\n');
put(join(tmp, 'b.sh'), '#!/bin/sh\nsudo docker build -t x .\n');
put(join(tmp, 'c.sh'), '#!/bin/sh\n# sudo is not used\necho pseudo-sudoers\ndocker run x\n');
put(join(tmp, 'd.sh'), '#!/bin/sh\nif [ x ]; then\n  sudo chown -R 1000 nem\nfi\n');
ok(!scriptUsesSudo(join(tmp, 'a.sh')), 'no sudo');
ok(scriptUsesSudo(join(tmp, 'b.sh')) && scriptUsesSudo(join(tmp, 'd.sh')), 'sudo detected');
ok(!scriptUsesSudo(join(tmp, 'c.sh')), 'comment / substring is not sudo');
ok(scriptUsesSudo(join(tmp, 'missing.sh')), 'unreadable → treated as sudo (do not run)');

// ---- エージェントの固定の手順（run の部分を、偽の probe で直接動かす）
type Probe = (cmd: string, args: string[]) => Promise<string | null>;
const probeAll: Probe = async () => 'ok';
const probeNoDocker: Probe = async (c) => (c === 'docker' ? null : 'ok');
const probeNoGit: Probe = async (c) => (c === 'git' ? null : 'ok');
async function runAll(steps: ReturnType<typeof nemSteps>, upto = steps.length): Promise<{ code: number; text: string; failedAt: number }> {
  let text = '';
  for (let i = 0; i < upto; i++) {
    const s = steps[i];
    if (!s.run) continue;
    const c = await s.run((t) => { text += t; }, { stopped: () => false });
    if (c !== 0) return { code: c, text, failedAt: i };
  }
  return { code: 0, text, failedAt: -1 };
}
const node = join(tmp, 'node1');
mkdirSync(node, { recursive: true });
// Linux 以外では動かさない
for (const pl of ['win32', 'darwin'] as const) {
  const r = await runAll(nemSteps('install', node, { platform: pl, probe: probeAll }));
  ok(r.code === 1 && r.failedAt === 0 && r.text.includes('Linux'), `${pl}: refused with guidance`, r);
}
ok((await runAll(nemSteps('start', node, { platform: 'linux', probe: probeNoDocker }))).text.includes('docker が見つかりません'), 'docker missing → stop');
ok((await runAll(nemSteps('install', node, { platform: 'linux', probe: probeNoGit }))).text.includes('git が見つかりません'), 'git missing → stop (install)');
ok((await runAll(nemSteps('start', node, { platform: 'linux', probe: probeNoGit }))).text.includes('nem-docker フォルダがありません'), 'git is not needed for start');

const sInstall = nemSteps('install', node, { platform: 'linux', probe: probeAll });
const clone = sInstall.find((s) => s.cmd === 'git');
ok(clone !== undefined && clone.args.join(' ') === `clone --depth 1 ${NEM_DOCKER_REPO} ${NEM_DOCKER_DIR}` && clone.cwd === node, 'clone is fixed: official repo, depth 1', clone);
ok(NEM_DOCKER_REPO === 'https://github.com/NemProject/nem-docker.git', 'repo is the official one');
ok(sInstall.every((s) => s.cmd === '' || s.cmd === 'git'), 'install runs nothing but git');
const pre = await runAll(sInstall, 2); // 準備 + 取得先の確認（git clone の前まで）
ok(pre.code === 0, 'install precheck passes on an empty folder', pre);
mkdirSync(join(node, NEM_DOCKER_DIR), { recursive: true });
ok((await runAll(sInstall, 2)).text.includes('すでにあります'), 'install refuses to overwrite an existing nem-docker');

// start / stop / update の構成
const repo = join(node, NEM_DOCKER_DIR);
put(join(repo, 'boot.sh'), '#!/bin/sh\necho BOOTED\n');
put(join(repo, 'stop.sh'), '#!/bin/sh\necho STOPPED\n');
const sStart = nemSteps('start', node, { platform: 'linux', probe: probeAll });
const bootStep = sStart.find((s) => s.cmd === '/bin/sh');
ok(bootStep?.args.join() === './boot.sh' && bootStep.cwd === repo, 'start runs /bin/sh ./boot.sh in nem-docker', bootStep);
ok((await runAll(sStart)).text.includes('設定ファイル'), 'start without config refused (boot.sh would ask)');
put(join(repo, NEM_CONFIG_PATH), 'nis.bootName = x\n');
ok((await runAll(sStart, 2)).code === 0, 'start precheck passes with config');
const oldName = join(repo, 'custom-configs/nis.config-user.properties');
ok(existsSync(oldName), 'config in place');
const sStop = nemSteps('stop', node, { platform: 'linux', probe: probeAll });
ok(sStop.find((s) => s.cmd === '/bin/sh')?.args.join() === './stop.sh' && (await runAll(sStop, 2)).code === 0, 'stop runs ./stop.sh; config not required');
const sUpd = nemSteps('update', node, { platform: 'linux', probe: probeAll });
ok(sUpd.filter((s) => s.cmd !== '').map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' | ') === '/bin/sh ./stop.sh | git pull --ff-only | /bin/sh ./boot.sh', 'update = stop, git pull --ff-only, boot', sUpd.map((s) => s.label));
ok(sUpd.filter((s) => s.cmd === 'git').every((s) => s.cwd === repo), 'git pull runs inside nem-docker');
// sudo 入りは動かさない
put(join(repo, 'boot.sh'), '#!/bin/sh\nsudo docker build -t mynem_image .\n');
const rs = await runAll(nemSteps('start', node, { platform: 'linux', probe: probeAll }));
ok(rs.code === 1 && rs.text.includes('sudo') && rs.text.includes('ご自身のターミナル'), 'boot.sh with sudo refused with guidance', rs);
// update で boot.sh が sudo 入りに変わったとき（git pull のあと）は、boot の前で止まる
put(join(repo, 'boot.sh'), '#!/bin/sh\necho BOOTED\n');
const sUpd2 = nemSteps('update', node, { platform: 'linux', probe: probeAll });
const recheck = sUpd2.filter((s) => s.cmd === '' && s.run).slice(-1)[0];
put(join(repo, 'boot.sh'), '#!/bin/sh\nsudo x\n');
let tx = '';
ok((await recheck.run?.((t) => { tx += t; }, { stopped: () => false })) === 1 && tx.includes('sudo'), 'update re-checks boot.sh after git pull');
put(join(repo, 'boot.sh'), '#!/bin/sh\necho BOOTED\n');
// シンボリックリンクは辿らない
const node2 = join(tmp, 'node2');
mkdirSync(node2, { recursive: true });
let linked = false;
try { symlinkSync(repo, join(node2, NEM_DOCKER_DIR), 'dir'); linked = true; } catch { /* 作れない環境 */ }
if (linked) {
  ok((await runAll(nemSteps('start', node2, { platform: 'linux', probe: probeAll }))).text.includes('シンボリックリンク'), 'symlinked nem-docker refused');
  ok((await runAll(nemSteps('install', node2, { platform: 'linux', probe: probeAll }), 2)).text.includes('すでにあります'), 'symlink counts as existing for install');
  const node3 = join(tmp, 'node3');
  mkdirSync(join(node3, NEM_DOCKER_DIR, 'custom-configs'), { recursive: true });
  put(join(node3, NEM_DOCKER_DIR, 'custom-configs/nis.config-user.properties'), 'x');
  symlinkSync(join(repo, 'boot.sh'), join(node3, NEM_DOCKER_DIR, 'boot.sh'));
  ok((await runAll(nemSteps('start', node3, { platform: 'linux', probe: probeAll }))).text.includes('普通のファイルとして見つかりません'), 'symlinked boot.sh refused');
}

// supernode / status の手順（run の部分）
const snNode = join(tmp, 'sn1');
const snRepo = join(snNode, NEM_DOCKER_DIR);
put(join(snRepo, 'boot.sh'), '#!/bin/sh\necho BOOTED\n');
put(join(snRepo, 'service.sh'), '#!/bin/sh\necho STATUS "$1"\n');
put(join(snRepo, NEM_CONFIG_PATH), 'nis.bootName = x\n');
const sSn = nemSteps('supernode', snNode, { platform: 'linux', probe: probeAll });
ok(sSn.every((x) => x.cmd === ''), 'supernode recipe runs no external command');
ok((await runAll(sSn)).text.includes('Servant の設定ファイル'), 'supernode refused without the Servant config');
put(join(snRepo, NEM_SERVANT_CONFIG_PATH), 'nem.host = a.example.com\nservant.key = x\n');
ok((await runAll(sSn)).text.includes('supervisord.conf.sample'), 'supernode refused without the sample');
put(join(snRepo, 'custom-configs/supervisord.conf.sample'), sample);
const rsn = await runAll(sSn);
ok(rsn.code === 0 && rsn.text.includes('作りました'), 'supervisord.conf created from the sample', rsn);
const made = readFileSync(join(snRepo, 'custom-configs/supervisord.conf'), 'utf8');
ok(autostartEnabled(made) && made.includes('command=/x/nis') && made.includes('command=/x/servant'), 'created conf keeps commands, enables autostart');
ok(readFileSync(join(snRepo, 'custom-configs/supervisord.conf.sample'), 'utf8') === sample, 'sample untouched');
const rsn2 = await runAll(sSn);
ok(rsn2.code === 0 && rsn2.text.includes('すでに設定済み'), 'second run keeps the existing conf', rsn2);
writeFileSync(join(snRepo, 'custom-configs/supervisord.conf'), '[program:nis]\nautostart=false\n[program:servant]\nautostart=true\n');
const rsn3 = await runAll(sSn);
ok(rsn3.code === 1 && rsn3.text.includes('上書きはしません') && readFileSync(join(snRepo, 'custom-configs/supervisord.conf'), 'utf8').includes('autostart=false'), 'a hand-edited conf is never overwritten', rsn3);
put(join(snRepo, 'custom-configs/supervisord.conf.sample'), '[program:nis]\nautostart=false\n');
rmSyncSafe(join(snRepo, 'custom-configs/supervisord.conf'));
ok((await runAll(sSn)).text.includes('servant'), 'sample without [program:servant] refused');
const sSt = nemSteps('status', snNode, { platform: 'linux', probe: probeAll });
ok(sSt.find((x) => x.cmd === '/bin/sh')?.args.join(' ') === './service.sh status', 'status runs ./service.sh status');
ok((await runAll(sSt, 2)).code === 0, 'status precheck ok');
put(join(snRepo, 'service.sh'), '#!/bin/sh\nsudo supervisorctl status\n');
ok((await runAll(sSt)).text.includes('sudo'), 'service.sh with sudo refused');
for (const pl of ['win32', 'darwin'] as const) ok((await runAll(nemSteps('supernode', snNode, { platform: pl, probe: probeAll }))).text.includes('Linux'), `supernode refused on ${pl}`);
if (linked) {
  const snLink = join(tmp, 'sn2');
  mkdirSync(join(snLink, NEM_DOCKER_DIR, 'custom-configs'), { recursive: true });
  put(join(snLink, NEM_DOCKER_DIR, 'boot.sh'), '#!/bin/sh\n');
  put(join(snLink, NEM_DOCKER_DIR, NEM_CONFIG_PATH), 'x');
  put(join(snLink, NEM_DOCKER_DIR, NEM_SERVANT_CONFIG_PATH), 'x');
  put(join(tmp, 'elsewhere.conf'), '[program:nis]\nautostart=true\n[program:servant]\nautostart=true\n');
  symlinkSync(join(tmp, 'elsewhere.conf'), join(snLink, NEM_DOCKER_DIR, 'custom-configs/supervisord.conf'));
  ok((await runAll(nemSteps('supernode', snLink, { platform: 'linux', probe: probeAll }))).text.includes('普通のファイルではない'), 'symlinked supervisord.conf refused');
}

// ---- 本物のエージェントの HTTP（偽の git / docker を PATH に置く）
const bin = join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
fake('git', [
  'case "$1" in',
  '  --version) echo "git version 2.43.0";;',
  '  clone) mkdir -p "$5/custom-configs"',
  "    cat > \"$5/boot.sh\" <<'EOS'",
  '#!/bin/sh',
  'echo BOOTED "$(basename "$(pwd)")"',
  'EOS',
  "    cat > \"$5/stop.sh\" <<'EOS'",
  '#!/bin/sh',
  'echo STOPPED',
  'EOS',
  "    cat > \"$5/service.sh\" <<'EOS'",
  '#!/bin/sh',
  'echo SERVICE "$1"',
  'EOS',
  "    cat > \"$5/custom-configs/supervisord.conf.sample\" <<'EOS'",
  '[program:nis]',
  'command=/x/nis',
  'autostart=false',
  '[program:servant]',
  'command=/x/servant',
  'autostart=false',
  'EOS',
  '    echo "cloned $4";;',
  '  pull) echo PULLED;;',
  'esac',
].join('\n'));
fake('docker', 'case "$1" in\n  --version) echo "Docker version 27.0.0";;\n  ps) echo "CONTAINER ID  NAMES"; echo "abc  mynem_container";;\n  *) echo "docker $@";;\nesac');
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
const TOKEN = 'b'.repeat(40);
const ws = join(tmp, 'ws');
mkdirSync(ws, { recursive: true });
async function job(c: AgentConn, line: string, cwd: string): Promise<{ code: number | null; out: string }> {
  const { id } = await startJob(c, line, cwd);
  let from = 0, out = '';
  for (;;) {
    const r = await readJob(c, id, from);
    out += r.text; from = r.next;
    if (r.done) return { code: r.exitCode, out };
    await new Promise((res) => setTimeout(res, 40));
  }
}
const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], platform: 'linux' });
await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
const conn: AgentConn = { url: `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`, token: TOKEN };
try {
  const status = await fetchStatus(conn);
  ok(status.tools.git.found && /^2\./.test(status.tools.git.version ?? ''), 'status reports git', status.tools.git);
  ok(status.tools.docker.found, 'status reports docker');
  // 構築: 取得 → 設定ファイル → 起動 → docker ps
  const r1 = await job(conn, 'irome nem install', 'nem-node');
  ok(r1.code === 0 && r1.out.includes('cloned'), 'install via agent', r1);
  ok(existsSync(join(ws, 'nem-node/nem-docker/boot.sh')), 'cloned into <dir>/nem-docker');
  const r1b = await job(conn, 'irome nem install', 'nem-node');
  ok(r1b.code === 1 && r1b.out.includes('すでにあります'), 'second install refused', r1b);
  const r2 = await job(conn, 'irome nem start', 'nem-node');
  ok(r2.code === 1 && r2.out.includes('設定ファイル'), 'start without config refused via agent', r2);
  await writeFile(conn, nemConfigFile('nem-node'), nemPropertiesContent({ name: 'n1', network: 'mainnet', harvest: false }, K));
  ok((await readFile(conn, nemConfigFile('nem-node'))).content.includes(`nis.bootKey = ${K}`), 'config written and read back');
  const r3 = await job(conn, 'irome nem start', 'nem-node');
  ok(r3.code === 0 && r3.out.includes('BOOTED'), 'start runs boot.sh', r3);
  ok(r3.out.includes('BOOTED nem-docker'), 'boot.sh runs inside the nem-docker folder', r3.out);
  ok(!r3.out.includes(K), 'boot key never appears in job output');
  const r4 = await job(conn, 'docker ps', 'nem-node');
  ok(r4.code === 0 && r4.out.includes('mynem_container'), 'docker ps allowed', r4);
  const r5 = await job(conn, 'irome nem update', 'nem-node');
  ok(r5.code === 0 && r5.out.indexOf('STOPPED') < r5.out.indexOf('PULLED') && r5.out.indexOf('PULLED') < r5.out.indexOf('BOOTED'), 'update order: stop, pull, boot', r5.out);
  // スーパーノード（本物のエージェント経由）: Servant の設定 → supervisord.conf → 起動 → 状態
  const r5a = await job(conn, 'irome nem supernode', 'nem-node');
  ok(r5a.code === 1 && r5a.out.includes('Servant の設定ファイル'), 'supernode via agent refused without the Servant config', r5a);
  await writeFile(conn, nemServantFile('nem-node'), servantPropertiesContent('node.example.com', K));
  const r5b = await job(conn, 'irome nem supernode', 'nem-node');
  ok(r5b.code === 0 && existsSync(join(ws, 'nem-node/nem-docker/custom-configs/supervisord.conf')), 'supernode via agent creates supervisord.conf', r5b);
  ok(autostartEnabled(readFileSync(join(ws, 'nem-node/nem-docker/custom-configs/supervisord.conf'), 'utf8')), 'autostart enabled');
  ok(!r5b.out.includes(K), 'remote key never appears in job output');
  const r5c = await job(conn, 'irome nem status', 'nem-node');
  ok(r5c.code === 0 && r5c.out.includes('SERVICE status'), 'status runs service.sh status', r5c);
  const w2 = await writeFile(conn, 'nem-node/nem-docker/custom-configs/supervisord.conf', 'evil').then(() => 'written', (e: Error) => e.message);
  ok(w2 !== 'written', 'supervisord.conf cannot be overwritten from the screen', w2);
  const r6 = await job(conn, 'irome nem stop', 'nem-node');
  ok(r6.code === 0 && r6.out.includes('STOPPED'), 'stop runs stop.sh', r6);
  // tools/ の中では動かさない・作業場所の外は指せない
  const bad1 = await startJob(conn, 'irome nem install', 'tools/x').then(() => 'started', (e: Error) => e.message);
  ok(bad1 !== 'started', 'tools/ folder refused', bad1);
  const bad2 = await startJob(conn, 'irome nem install', '../out').then(() => 'started', (e: Error) => e.message);
  ok(bad2 !== 'started', 'outside the workspace refused', bad2);
  const bad3 = await startJob(conn, 'irome nem rm', '').then(() => 'started', (e: Error) => e.message);
  ok(bad3 !== 'started', 'unknown action refused by the agent too', bad3);
  // 画面から nem-docker のスクリプト・compose を書き換えられない
  const w1 = await writeFile(conn, 'nem-node/nem-docker/boot.sh', 'evil').then(() => 'written', (e: Error) => e.message);
  ok(w1 !== 'written' && readFileSync(join(ws, 'nem-node/nem-docker/boot.sh'), 'utf8').includes('BOOTED'), 'boot.sh cannot be overwritten from the screen', w1);
} finally {
  agent.server.close();
}


// ---- 画面の文章（i18n）: 手順の各項目に題と本文がある・`\n` の文字や `**` が残っていない
{
  const msgs = JSON.parse(readFileSync(join(process.cwd(), 'src/i18n/messages.json'), 'utf8')) as Record<'ja' | 'en', { service: Record<string, string> }>;
  for (const lang of ['ja', 'en'] as const) {
    const svc = msgs[lang].service;
    for (const st of NEM_GUIDE_STEPS) {
      ok(typeof svc[`node_nem_g_${st.id}_title`] === 'string' && svc[`node_nem_g_${st.id}_title`] !== '', `${lang}: guide title ${st.id}`);
      ok(typeof svc[`node_nem_g_${st.id}_body`] === 'string' && svc[`node_nem_g_${st.id}_body`] !== '', `${lang}: guide body ${st.id}`);
    }
    for (const [k, v] of Object.entries(svc)) {
      if (!k.startsWith('node_nem_') && !k.startsWith('node_pre_nem_')) continue;
      ok(!v.includes('\\n'), `${lang}: no literal backslash-n in ${k}`);
      ok(!v.includes('**'), `${lang}: no ** (not supported by the guide text) in ${k}`);
    }
    for (const p of COMMAND_PRESETS.filter((x) => x.group === 'nem')) ok(typeof svc[p.noteKey.replace('service.', '')] === 'string', `${lang}: preset note ${p.noteKey}`);
  }
  // 1 つの項目が長すぎない（読みにくくなるため）。本文 2,500 文字まで
  for (const st of NEM_GUIDE_STEPS) ok((msgs.ja.service[`node_nem_g_${st.id}_body`] ?? '').length <= 2500, `guide body not too long: ${st.id}`);
}

// ---- 表示前の「うっかり」直し（`\n` の文字・`**`）と、画面に出る文章
ok(normalizeGuideText('A\\n\\nB') === 'A\n\nB', 'normalize: literal backslash-n becomes a newline');
ok(normalizeGuideText('A\\r\\nB') === 'A\nB' && normalizeGuideText('x **bold** y') === 'x bold y', 'normalize: \\r\\n and **');
ok(normalizeGuideText('real\nnewline') === 'real\nnewline', 'normalize: real newlines kept');
{
  const kinds = (t: string) => parseGuideText(t).map((b) => b.type).join();
  ok(kinds('A\\n\\n## H\\n・x') === 'paragraph,heading,list', 'parse: a string with literal backslash-n is laid out as headings and lists', kinds('A\\n\\n## H\\n・x'));
  const msgs2 = JSON.parse(readFileSync(join(process.cwd(), 'src/i18n/messages.json'), 'utf8')) as Record<'ja' | 'en', { service: Record<string, string> }>;
  const flat = (x: Array<{ text: string }>) => x.map((i) => i.text).join('');
  for (const lang of ['ja', 'en'] as const) {
    for (const [k, v] of Object.entries(msgs2[lang].service)) {
      if (!k.startsWith('node_nem_g_') && !['node_nem_intro', 'node_nem_key_hint', 'node_nem_supernode_hint', 'node_nem_linux_only', 'node_nem_status_err', 'node_nem_done_supernode_next'].includes(k)) continue;
      if (k.endsWith('_title') || k.endsWith('_snippet') || k.endsWith('_file_template')) continue;
      const shown = parseGuideText(v).map((b) => (b.type === 'list' ? b.items.map((i) => flat(i.body)).join('|') : flat(b.body ?? b.text))).join('|');
      ok(!shown.includes('\\n') && !shown.includes('**'), `${lang}: ${k} shows no \\n or ** on screen`);
    }
    // 画面の部品の見出し
    for (const k of ['node_nem_sec_basic', 'node_nem_sec_key', 'node_nem_sec_super', 'node_nem_sec_manage']) ok(typeof msgs2[lang].service[k] === 'string' && msgs2[lang].service[k] !== '', `${lang}: ${k}`);
    // 入力欄の補足は、1 行で読める長さ（長いものは、箇条書きの GuideText にする）
    for (const k of ['node_nem_dir_hint', 'node_nem_name_hint', 'node_nem_host_hint', 'node_nem_harvest_hint', 'node_nem_mainnet_note', 'node_nem_testnet_note', 'node_nem_manage_hint']) ok(!msgs2[lang].service[k].includes('\n') && msgs2[lang].service[k].length <= 160, `${lang}: ${k} is one short line`, msgs2[lang].service[k].length);
  }
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
