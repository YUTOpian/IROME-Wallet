import { useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IROME_LOGO } from '../theme/iromeTheme';
import { IromeMark, IromeWordmark, IromeWalletWord } from '../components/irome/IromeLogo';
import { BrushYokoso } from '../components/irome/BrushLogo';
import { LanguageThemeButtons, pillButtonSx } from '../components/LanguageThemeControls';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OfficialProfileImportDialog from '../components/OfficialProfileImportDialog';
import DisclaimerDialog from '../components/Disclaimer';
import { dismissOfficialProfiles, findNewOfficialProfiles } from '../lib/officialProfile/detect';
import type { OfficialFound } from '../lib/officialProfile/detect';

// アプリを一番最初に起動したとき、またはウォレットが1件も無いときに表示するウェルカム画面。
// IROMEのロゴ（五色に重なった襟）をそのまま主役にした、くすんだ紫グレーの舞台。
// ここでの唯一のアクションは「GET STARTED」で、ウォレット選択画面（/wallet/select）へ進む。
// GET STARTEDの下に、言語ボタン・テーマボタン・免責事項を横に並べる。言語とテーマは押すと選択メニューが開く（SettingsTop.tsxと同じstoreを使う）。
const glow = keyframes`0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.06); }`;
const reducedMotion = '@media (prefers-reduced-motion: reduce)';

export default function Welcome() {
  const navigate = useNavigate();
  const { t, i18n: i18nInst } = useTranslation();
  const isJa = (i18nInst.language ?? '').startsWith('ja');
  // このブラウザに Symbol 公式ウォレットのプロファイルがあるかは、起動時ではなく GET STARTED を押したときに確かめる。
  // 見つかればパスワード入力のポップアップを出し、閉じたあとにプロファイル選択画面へ進む。見つからなければそのまま進む。
  const [found, setFound] = useState<OfficialFound | null>(null);
  const [checking, setChecking] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const onGetStarted = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const result = await findNewOfficialProfiles();
      if (result) {
        setFound(result);
        return;
      }
    } catch {
      // 探せなかったときは、ポップアップなしで先へ進む。
    } finally {
      setChecking(false);
    }
    navigate('/wallet/select');
  };
  const foundNames = found ? found.profiles.map((p) => p.profileName) : [];
  return (
    <Box
      sx={{
        position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '100svh', width: '100%', boxSizing: 'border-box', color: 'text.primary', textAlign: 'center',
        px: 3, py: { xs: 5, md: 8 }, overflow: 'hidden', background: (t) => t.irome.stageBg,
      }}
    >
      {/* スマホは縦1列。デスクトップ（900px以上）は、左にロゴ・右に文言とボタンの2カラム。 */}
      <Box
        sx={{
          position: 'relative', display: 'flex', width: '100%', maxWidth: { md: 1120 }, boxSizing: 'border-box',
          flexDirection: { xs: 'column', md: 'row' }, alignItems: 'center', justifyContent: 'center',
          gap: { xs: 0, md: 10, lg: 14 }, px: { md: 4 },
        }}
      >
        {/* logo: the hexagon mark with a soft glow, then the wordmark */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: { md: '1 1 0' }, minWidth: 0 }}>
          <Box sx={{ position: 'relative', mb: { xs: 3.5, md: 5 } }}>
            <Box
              aria-hidden
              sx={{
                position: 'absolute', inset: { xs: -40, md: -70 }, borderRadius: '50%',
                background: `radial-gradient(circle, ${IROME_LOGO.pink}66 0%, ${IROME_LOGO.lavender}22 45%, transparent 70%)`,
                animation: `${glow} 5s ease-in-out infinite`, [reducedMotion]: { animation: 'none' },
              }}
            />
            <Box sx={{ position: 'relative', width: { xs: 'min(230px, 58vw)', md: 340 } }}>
              <Box sx={{ display: { xs: 'block', md: 'none' } }}><IromeMark size={230} /></Box>
              <Box sx={{ display: { xs: 'none', md: 'block' } }}><IromeMark size={340} /></Box>
            </Box>
          </Box>
          <Box sx={{ maxWidth: '78vw' }}>
            <Box sx={{ display: { xs: 'block', md: 'none' } }}><IromeWordmark width={300} /></Box>
            <Box sx={{ display: { xs: 'none', md: 'block' } }}><IromeWordmark width={340} /></Box>
          </Box>
          <Box sx={{ mt: { xs: 2.5, md: 3 }, display: 'flex', justifyContent: 'center' }}>
            <Box sx={{ display: { xs: 'block', md: 'none' } }}><IromeWalletWord width={150} /></Box>
            <Box sx={{ display: { xs: 'none', md: 'block' } }}><IromeWalletWord width={170} /></Box>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: { xs: 'center', md: 'flex-start' }, textAlign: { xs: 'center', md: 'left' }, flex: { md: '1 1 0' }, minWidth: 0, mt: { xs: 4, md: 0 }, width: { xs: '100%', md: 'auto' } }}>
          {/* 日本語のときだけ「ようこそ」を筆文字で。他の言語は、これまでどおりの細い字。 */}
          {isJa ? (
            <Box component="h1" sx={{ m: 0, mb: { xs: 2, md: 3 }, fontWeight: 400, lineHeight: 1 }} aria-label={t('wallet.welcome_title_2')}>
              <Box sx={{ display: { xs: 'block', md: 'none' } }}><BrushYokoso height={46} /></Box>
              <Box sx={{ display: { xs: 'none', md: 'block' } }}><BrushYokoso height={72} /></Box>
            </Box>
          ) : (
            <Typography variant="h4" sx={{ fontWeight: 400, lineHeight: 1.3, mb: { xs: 2, md: 3 }, letterSpacing: { xs: 6, md: 8 }, color: (t) => t.irome.wordmark, fontSize: { xs: 24, sm: 28, md: 40 } }}>
              {t('wallet.welcome_title_2')}
            </Typography>
          )}

          <Typography variant="body2" sx={{ color: 'text.secondary', mb: { xs: 5, md: 6 }, maxWidth: { xs: 420, md: 480 }, lineHeight: 1.9, fontSize: { md: 17 }, whiteSpace: 'pre-line' }}>
            {t('wallet.welcome_subtitle')}
          </Typography>

          <Button
            variant="contained"
            onClick={() => void onGetStarted()}
            disabled={checking}
            sx={{ width: '100%', maxWidth: { xs: 320, md: 380 }, py: { xs: 1.5, md: 2 }, fontWeight: 700, letterSpacing: 3, fontSize: { md: 17 } }}
          >
            {checking ? <CircularProgress size={22} color="inherit" /> : t('wallet.welcome_get_started')}
          </Button>

          {/* 言語・テーマの右に、同じ行で「免責事項」を置く。 */}
          <LanguageThemeButtons align="start">
            <Button
              aria-label={t('wallet.disclaimer_title')}
              title={t('wallet.disclaimer_title')}
              startIcon={<InfoOutlinedIcon fontSize="small" />}
              onClick={() => setShowDisclaimer(true)}
              sx={pillButtonSx}
            >
              {t('wallet.disclaimer_title')}
            </Button>
          </LanguageThemeButtons>
        </Box>
      </Box>
      <DisclaimerDialog open={showDisclaimer} onClose={() => setShowDisclaimer(false)} />
      {found && (
        <OfficialProfileImportDialog
          open
          onClose={() => { setFound(null); navigate('/wallet/select'); }}
          auto={{ text: found.text, profiles: foundNames, onNever: () => dismissOfficialProfiles(found.text, foundNames) }}
        />
      )}
    </Box>
  );
}
