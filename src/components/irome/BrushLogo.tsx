import { useEffect, useId, useState } from 'react';
import { Box, useTheme } from '@mui/material';
import { IROME_BRUSH as IROME, WALLET_BRUSH as WALLET } from '../../lib/iromeBrushPaths';

// 習字（筆文字）風の文字。外部フォントは使わず（CSPがfont-srcを 'self' data: に絞っているため）、
// 「IROME」は筆の運び（入り・太い腹・払い）をつけた線、「ようこそ」は読みやすい明朝体の輪郭を土台に、
// 「I」は1やlと間違えないよう上下に横棒（うろこ）を付けた形を、SVGのパスとして埋め込み、
// SVGフィルターで墨の縁のゆらぎとかすれを足している。色はテーマの wordmark 色に従う。

function BrushFilter({ id, wobble, dry }: { id: string; wobble: number; dry: number }) {
  return (
    <filter id={id} x="-8%" y="-12%" width="116%" height="124%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="7" result="warp" />
      <feDisplacementMap in="SourceGraphic" in2="warp" scale={wobble} xChannelSelector="R" yChannelSelector="G" result="rough" />
      <feTurbulence type="fractalNoise" baseFrequency="0.9 0.12" numOctaves="2" seed="3" result="grain" />
      <feColorMatrix in="grain" type="matrix" values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 ${-(0.4 + dry * 0.5)}`} result="holes" />
      <feComposite in="rough" in2="holes" operator="in" />
    </filter>
  );
}

const YOKOSO: string[] = ["M660 385C724 385 800 366 827 357C855 346 865 332 865 316C865 281 827 269 788 269C778 269 759 281 726 293C689 306 632 316 600 316L584 315C587 274 592 234 598 214C606 186 621 177 621 153C621 121 552 79 490 79C459 79 427 93 403 105L404 121C425 124 456 128 477 138C495 145 501 153 503 174C506 198 510 332 511 391C512 453 518 552 521 631L474 629C340 629 221 676 221 778C221 859 300 905 408 905C551 905 603 839 603 758L601 720C627 730 652 742 674 755C770 810 805 873 846 873C870 873 885 861 885 833C885 774 805 720 736 688C696 670 647 652 590 640V637C582 562 579 456 579 409L581 358C605 371 635 385 660 385ZM522 698C520 789 483 829 371 829C306 829 267 804 267 769C267 726 328 689 424 689C459 689 492 692 522 698Z", "M1388 909 1395 931C1688 893 1863 770 1863 542C1863 401 1789 315 1673 315C1566 315 1445 392 1392 392C1369 392 1347 363 1334 330L1318 334C1311 363 1304 394 1312 418C1323 451 1367 500 1405 500C1433 500 1456 473 1478 455C1518 424 1601 362 1664 362C1726 362 1764 425 1764 529C1764 727 1629 846 1388 909ZM1457 230 1466 247C1514 229 1603 196 1659 184C1688 177 1723 175 1743 175C1771 174 1785 163 1785 146C1785 112 1731 86 1688 86C1670 86 1640 97 1599 97C1545 97 1480 90 1415 44L1404 56C1455 140 1538 151 1577 158C1549 177 1498 207 1457 230Z", "M2671 872C2797 872 2892 857 2943 839C2981 826 2992 815 2992 788C2992 755 2945 737 2913 737C2885 737 2810 779 2648 778C2436 778 2401 690 2396 555L2373 556C2326 741 2395 872 2671 872ZM2519 374 2530 391C2611 353 2701 314 2757 298C2799 284 2834 279 2864 273C2895 267 2909 255 2909 232C2909 200 2842 174 2799 174C2755 174 2730 198 2604 198C2524 198 2480 189 2417 147L2404 160C2458 255 2538 266 2647 268C2660 268 2661 271 2651 279C2619 303 2563 344 2519 374Z", "M3884 916C3935 916 3961 904 3961 871C3961 846 3934 819 3911 815C3883 810 3839 817 3785 808C3703 794 3650 758 3649 687C3649 609 3689 564 3732 532C3785 494 3882 476 3952 473C3992 472 4023 474 4046 474C4088 474 4105 460 4105 438C4105 401 4046 380 4003 380C3966 380 3922 394 3850 414C3782 432 3650 473 3570 494C3565 495 3563 492 3567 487C3674 389 3799 294 3890 218C3912 200 3937 197 3937 174C3937 138 3861 80 3826 80C3805 80 3802 98 3766 109C3703 128 3588 156 3555 155C3534 154 3515 116 3499 86L3487 89C3480 106 3472 133 3473 149C3473 198 3539 251 3568 251C3595 251 3609 234 3644 216C3682 197 3746 166 3788 155C3805 148 3811 152 3800 169C3757 237 3640 358 3587 408C3536 458 3489 496 3445 518C3418 531 3380 543 3356 551C3334 559 3326 572 3326 593C3326 620 3356 653 3382 653C3416 653 3436 625 3498 588C3543 561 3620 531 3684 512C3698 508 3700 513 3690 523C3644 563 3590 623 3590 714C3590 815 3661 876 3753 901C3788 910 3842 916 3884 916Z"];

function useBrushFont(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    document.fonts.load('48px IromeBrush', 'ようこそ').then((f) => { if (alive) setOk(f.length > 0); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return ok;
}

function BrushShapes({ paths, viewBox, width, height, label, color, wobble, dry = 0.3 }: {
  paths: string[]; viewBox: string; width: number; height: number; label: string; color: string; wobble: number; dry?: number;
}) {
  const uid = useId().replace(/:/g, '');
  return (
    <Box component="svg" viewBox={viewBox} width={width} height={height} role="img" aria-label={label} sx={{ display: 'block', overflow: 'visible', flexShrink: 0 }}>
      <defs><BrushFilter id={`bf${uid}`} wobble={wobble} dry={dry} /></defs>
      <g fill={color} filter={`url(#bf${uid})`}>{paths.map((d, i) => <path key={i} d={d} />)}</g>
    </Box>
  );
}

// 「ようこそ」を筆文字で。height は文字の高さ(px)。public/fonts/brush.woff2 があれば、そのフォントを優先する。
export function BrushYokoso({ height = 56, color }: { height?: number; color?: string }) {
  const theme = useTheme();
  const fill = color ?? theme.irome.wordmark;
  const fontReady = useBrushFont();
  if (fontReady) {
    return <Box component="span" sx={{ display: 'block', fontFamily: "'IromeBrush', serif", fontSize: height, lineHeight: 1.1, letterSpacing: '0.08em', color: fill }}>ようこそ</Box>;
  }
  return <BrushShapes paths={YOKOSO} viewBox="0 -40 4240 1040" width={(height * 4240) / 1040} height={height} label="ようこそ" color={fill} wobble={7} dry={0.3} />;
}

export function BrushIrome({ width, color }: { width: number; color: string }) {
  return <BrushShapes paths={IROME} viewBox="-92 -14 946 178" width={width} height={(width * 178) / 946} label="IROME" color={color} wobble={12} />;
}

export function BrushWallet({ width, color }: { width: number; color: string }) {
  return <BrushShapes paths={WALLET} viewBox="-12 -12 700 124" width={width} height={(width * 124) / 700} label="WALLET" color={color} wobble={9} />;
}
