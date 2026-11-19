// 「NEM（NIS1）でノードを建てる手順」の中身（画面は pages/node/NemNodeGuide.tsx）。
// 公式ドキュメント（docs.nemtest.net「ノードのインストール」）の順番に沿って、各手順に「説明（i18n: service.node_nem_g_<id>_title / _body）」と「コマンドのひな型」を持たせる。
// `lines` は、画面から実行できるひな型。必ず nodeCommands.ts の COMMAND_PRESETS にもあること（dev-tests/node-nem.test.ts が確かめる）。
import { TESTNET_PROPERTIES } from './nemNode';

export interface NemGuideStep {
  id: string;
  optional?: boolean;
  lines?: readonly string[];
  /** 設定ファイルの例（見せるだけ） */
  snippet?: string;
  /** 「設定ファイル」の欄に入れるボタン */
  fileTemplate?: { name: string; content: string };
}

export const NEM_PROPERTIES_EXAMPLE = `nis.bootName = my-nem-node
nis.bootKey = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`;

/** Servant の設定ファイルの例（公式: 少なくとも nem.host と servant.key。servant.key は、nis.bootKey と同じリモートアカウントの秘密鍵） */
export const NEM_SERVANT_EXAMPLE = `nem.host = node.example.com
servant.key = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`;

export const NEM_GUIDE_STEPS: readonly NemGuideStep[] = [
  { id: 'req', lines: ['irome install docker', 'docker --version', 'docker compose version'] },
  { id: 'docker', lines: ['irome nem install'] },
  { id: 'config', snippet: NEM_PROPERTIES_EXAMPLE, fileTemplate: { name: 'nem-docker/custom-configs/nis.config-user.properties', content: NEM_PROPERTIES_EXAMPLE } },
  { id: 'testnet', optional: true, snippet: TESTNET_PROPERTIES },
  { id: 'start', lines: ['irome nem start', 'docker ps', 'irome nem stop'] },
  { id: 'sync', lines: ['docker logs mynem_container --tail 50'] },
  { id: 'update', lines: ['irome nem update'] },
  { id: 'manual', optional: true },
  // スーパーノード（公式ドキュメント「スーパーノードプログラム」）。長くなるので、5 つに分ける
  { id: 'supernode', optional: true },
  { id: 'supernodeDocker', optional: true, lines: ['irome nem supernode', 'irome nem status'], snippet: NEM_SERVANT_EXAMPLE },
  { id: 'supernodeManual', optional: true },
  { id: 'supernodeTests', optional: true },
  { id: 'enroll', optional: true },
];
