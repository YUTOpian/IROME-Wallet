import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import InfoCard from './InfoCard';
import { CHAINS } from '../lib/chain';
import type { ChainChoice } from '../lib/chain';
import { CHAIN_LOGOS, MIJIN_ICON } from '../lib/chainIcons';
import { useAppStore } from '../store/appStore';

// 新規作成・インポート画面に置く、「Symbol / NEM × メインネット / テストネット」の選択タイル。
// 選んだチェーンとネットワークは、プロファイルを作ったあとにアプリの現在のチェーン・ネットワークになる
// （同じニーモニックフレーズから両チェーンのアカウントが作られるので、あとでメニューから切り替え可能）。
// アカウントの選択画面（アドレスの表示と、ネットワークへの問い合わせ）も、ここで選んだものに合わせる。
interface ChainPickerProps {
  value: ChainChoice;
  onChange: (choice: ChainChoice) => void;
}

const BASE_CHOICES: ChainChoice[] = [
  { chain: 'symbol', network: 'mainnet' },
  { chain: 'symbol', network: 'testnet' },
  { chain: 'nem', network: 'mainnet' },
  { chain: 'nem', network: 'testnet' },
];

export default function ChainPicker({ value, onChange }: ChainPickerProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  // mijin v2 はノードにつないだときだけ入る（選択肢には出さない）。すでに mijin につないでいるあいだだけ、Symbol の選択肢に加える。
  // NEM には mijin v2 がないので、NEM の選択肢はメインネット・テストネットだけ。
  const choices: ChainChoice[] = network === 'mijin' ? [...BASE_CHOICES, { chain: 'symbol', network: 'mijin' }] : BASE_CHOICES;
  return (
    <Box>
      <Typography variant="subtitle1" align="center" sx={{ fontWeight: 700 }}>
        {t('chain.new_profile_title')}
      </Typography>
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mt: 0.5 }}>
        {t('chain.new_profile_desc')}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, mt: 2 }}>
        {choices.map((choice) => {
          const key = `${choice.chain}-${choice.network}`;
          const selected = choice.chain === value.chain && choice.network === value.network;
          const logo = choice.network === 'mijin' ? MIJIN_ICON : CHAIN_LOGOS[choice.chain];
          return (
            <InfoCard
              key={key}
              title={CHAINS[choice.chain].name}
              caption={`${t(`chain.network_${choice.network}`)} · ${CHAINS[choice.chain].currencySymbol}`}
              selected={selected}
              onClick={() => onChange(choice)}
              action={<Box component="img" src={logo} alt="" sx={{ height: 28, width: 28, objectFit: 'contain' }} />}
            />
          );
        })}
      </Box>
    </Box>
  );
}
