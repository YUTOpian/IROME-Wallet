import { useEffect, useState } from 'react';
import { WalletsHelper } from '../lib/storage';
import { resolveSigner } from '../lib/symbol/aggregateApi';
import type { AggregateSigner } from '../lib/symbol/aggregate';
import { fetchCosignedAccounts, fetchMultisigInfo } from '../lib/symbol/multisigApi';
import { useAppStore } from '../store/appStore';

/**
 * The accounts a Symbol screen can act for: the wallet's own account, and the multisig accounts it cosigns for
 * (also through other multisig accounts). Picking a multisig account makes the screen send its transaction inside an
 * aggregate that this wallet signs (bonded when other cosigners must approve), because a multisig account cannot send
 * a transaction by itself (Failure_Multisig_Operation_Prohibited_By_Account).
 */
export interface CosignAccounts {
  /** '' = this wallet's own account, otherwise the base32 address of the chosen multisig account. */
  accountAddr: string;
  setAccountAddr: (address: string) => void;
  /** The chosen multisig account as an aggregate signer; undefined while the wallet's own account is chosen. */
  signer: AggregateSigner | undefined;
  signers: AggregateSigner[];
  ownAddress: string;
  /** The wallet's own account is a multisig account (it cannot send by itself). */
  selfIsMultisig: boolean;
  /** The wallet's own account is chosen but it is a multisig account: sending would be refused by the network, so screens keep their button off. */
  blocked: boolean;
  /** The multisig accounts have been looked up (or the lookup failed); false while the first lookup is running. */
  ready: boolean;
}

/**
 * `initialAccountAddr`: a multisig account to select as soon as it is found among the accounts this wallet cosigns for
 * (a dialog opened from a list that is already showing that account's rows).
 */
export function useCosignAccounts(wallet?: { id: string; address: string }, initialAccountAddr?: string): CosignAccounts {
  const network = useAppStore((s) => s.network);
  const [accountAddr, setAccountAddr] = useState('');
  const [signers, setSigners] = useState<AggregateSigner[]>([]);
  const [selfIsMultisig, setSelfIsMultisig] = useState(false);
  const [ownAddress, setOwnAddress] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSigners([]);
    setSelfIsMultisig(false);
    setAccountAddr('');
    setReady(false);
    (async () => {
      const w = wallet ?? await WalletsHelper.getActive();
      if (!w) { if (!cancelled) setReady(true); return; }
      if (cancelled) return;
      setOwnAddress(w.address);
      try {
        const info = await fetchMultisigInfo(w.address);
        if (!cancelled) setSelfIsMultisig(info.isMultisig);
        const cosigned = await fetchCosignedAccounts(w.address, undefined, info);
        const found = (await Promise.all(cosigned.map((c) => resolveSigner(w.address, c.info.address).catch(() => null)))).filter((x): x is AggregateSigner => x !== null);
        if (!cancelled) {
          setSigners(found);
          if (initialAccountAddr && found.some((x) => x.address === initialAccountAddr)) setAccountAddr(initialAccountAddr);
        }
      } catch { /* the multisig accounts are optional */ }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [network, wallet?.id, wallet?.address]);

  const signer = accountAddr === '' ? undefined : signers.find((x) => x.address === accountAddr);
  return { accountAddr, setAccountAddr, signer, signers, ownAddress, selfIsMultisig, blocked: selfIsMultisig && accountAddr === '', ready };
}
