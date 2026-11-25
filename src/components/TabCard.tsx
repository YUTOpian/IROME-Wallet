import type { ReactElement, ReactNode } from 'react';
import { Box, Card, Tab, Tabs } from '@mui/material';
import { FlatSectionsContext } from '../pages/multisig/parts';

// 白いカードの枠（ホームの「送る」などと同じ白地）。IROME模様の上に直接フォームを置くと模様と文字が
// 重なって読みにくいので、モザイク・ネームスペース・メタデータ・アグリゲートの画面は、この中に入れる。
// ピル型のタブはホーム画面だけのもの。ここでは今までの下線のタブを使い、タブが1つだけの画面では出さない。

export interface TabCardTab<T extends string> {
  value: T;
  label: string;
  icon?: ReactElement;
  hidden?: boolean;
}

interface TabCardProps<T extends string> {
  tabs: TabCardTab<T>[];
  value: T;
  onChange?: (value: T) => void;
  children: ReactNode;
}

export default function TabCard<T extends string>({ tabs, value, onChange, children }: TabCardProps<T>) {
  const visible = tabs.filter((tab) => !tab.hidden);
  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, pb: 2, boxSizing: 'border-box' }}>
      <Card sx={{ width: '100%' }}>
        {visible.length > 1 && (
          <Tabs
            value={value}
            variant="scrollable"
            allowScrollButtonsMobile
            onChange={(_, v: T) => onChange?.(v)}
            sx={{ borderBottom: 1, borderColor: 'divider', px: { xs: 1, md: 3 } }}
          >
            {visible.map((tab) => (
              <Tab key={tab.value} value={tab.value} label={tab.label} icon={tab.icon} iconPosition="start" />
            ))}
          </Tabs>
        )}
        {children}
      </Card>
    </Box>
  );
}

/**
 * タブの無い画面用の白いカード（TabCard と同じ枠）。中の「枠つきの区画」は、カードの二重にならないよう枠なし（見出し＋中身）にする。
 * `plain`: 別の画面の中に埋め込んで使うとき（枠を付けず、そのまま中身だけ出す）。
 */
export function CardFrame({ children, plain = false }: { children: ReactNode; plain?: boolean }) {
  if (plain) return <>{children}</>;
  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, pb: 2, boxSizing: 'border-box' }}>
      <Card sx={{ width: '100%' }}>
        <FlatSectionsContext.Provider value>{children}</FlatSectionsContext.Provider>
      </Card>
    </Box>
  );
}
