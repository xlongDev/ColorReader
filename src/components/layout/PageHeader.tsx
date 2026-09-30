/**
 * The heading a page opens with: a title and one line saying what the page is.
 *
 * Three pages wrote it out by hand — `px-8 pt-8 pb-6`, a 2xl title, a 14px
 * subtitle — and the spacing had drifted apart, the subtitle sitting 4px under
 * the title on two of them and 6px on the third.
 *
 * The shelf keeps its own heading (`ShelfHeader`): it carries a greeting and
 * swaps its title on a filter change, which is more than this needs to know
 * about. Its subtitle uses the same `mt-1.5` as this one, so the two read as
 * the same thing.
 *
 * No `actions` slot because nobody has handed one in yet — add it the day a
 * page actually needs buttons up there.
 */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="px-8 pt-8 pb-6">
      <h1 className="text-text-1 text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="text-text-2 mt-1.5 text-sm leading-relaxed">{subtitle}</p>}
    </header>
  );
}
