import { useApp } from '../App.jsx';

const CATEGORY_STYLES = {
  LIVE: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  VOD: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  SUGGESTION: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  OTHER: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
};

export function CategoryBadge({ category }) {
  const { t } = useApp();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${CATEGORY_STYLES[category] || CATEGORY_STYLES.OTHER}`}
    >
      {t(`cat${category}`)}
    </span>
  );
}

export default function StatusBadge({ status }) {
  const { t } = useApp();
  const open = status === 'OPEN';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        open ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${open ? 'bg-amber-400' : 'bg-emerald-400'}`} />
      {open ? t('statusOpen') : t('statusResolved')}
    </span>
  );
}
