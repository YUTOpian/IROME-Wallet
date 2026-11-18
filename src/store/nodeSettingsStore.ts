// 「ノード」画面の設定。このブラウザにだけ保存する（localStorage）。どこにも送らない。
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface NodeSettingsState {
  /**
   * true: `symbol-bootstrap wizard`（対話式）を実行できる。画面には、カーソル移動に対応した簡易ターミナルで出す。
   * false（初期値）: wizard は実行しない（画面もエージェントも断る）。
   */
  wizard: boolean;
  setWizard: (v: boolean) => void;
  /** ターミナルと設定ファイルを置く場所（右 / 下）。 */
  dock: 'right' | 'bottom';
  setDock: (v: 'right' | 'bottom') => void;
}

export const useNodeSettingsStore = create<NodeSettingsState>()(
  persist(
    (set) => ({
      wizard: false,
      setWizard: (v) => set({ wizard: v }),
      dock: 'right',
      setDock: (v) => set({ dock: v }),
    }),
    {
      name: 'irome-node-settings',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persisted) => persisted as Partial<NodeSettingsState>,
      // 壊れた値・知らない値は、安全な側に戻す（wizard は使わない）。明示的に true のときだけオン。
      merge: (persisted, current) => {
        const p = persisted as Partial<NodeSettingsState> | null;
        return { ...current, wizard: p?.wizard === true, dock: p?.dock === 'bottom' ? 'bottom' : 'right' };
      },
      partialize: (s) => ({ wizard: s.wizard, dock: s.dock }),
    },
  ),
);
