import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Menu, useLocalState } from '../people';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Breadcrumb before the title (project / section / entity). The last crumb is usually the title itself. */
  crumbs?: Crumb[];
  /** Chips next to the title: slug, counts, status. */
  meta?: ReactNode;
  /** One line, truncated, with a disclosure for the full text. */
  description?: ReactNode;
  /** Key for remembering the expanded description (defaults to the title when it is a string). */
  descriptionKey?: string;
  /** At most one primary action (stays visible on phones). */
  primary?: ReactNode;
  /** Up to two secondary actions; on phones they move into the More menu. */
  secondary?: ReactNode[];
  /** Contents of the More menu (buttons). Receives close(). */
  more?: (close: () => void) => ReactNode;
  /** Free-form actions (legacy Page({ actions })): rendered as given, right of the title. */
  actions?: ReactNode;
  /** Row 2: page tabs. */
  tabs?: ReactNode;
  /** Row 3: toolbar (search, filters). */
  toolbar?: ReactNode;
  /** Sticky at the top of the main scroller (>= 768 px). */
  sticky?: boolean;
  className?: string;
}

/**
 * The header of every page: breadcrumb + h1 + meta, actions (primary, secondary, More), a one-line description,
 * then optional tabs and toolbar rows. Markup keeps the 0.14 classes (.crumbs, .page-head) so the current look holds.
 */
export function PageHeader({ title, crumbs, meta, description, descriptionKey, primary, secondary, more, actions, tabs, toolbar, sticky, className = '' }: PageHeaderProps) {
  const hasMore = !!more || (secondary?.length ?? 0) > 0;
  return (
    <header className={`page-header ${sticky ? 'sticky' : ''} ${className}`}>
      {crumbs && crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {i > 0 && <span aria-hidden>/</span>}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title-row">
            <h1>{title}</h1>
            {meta && <div className="page-meta row">{meta}</div>}
          </div>
          {description && <Description text={description} storeKey={descriptionKey ?? (typeof title === 'string' ? title : undefined)} />}
        </div>
        {(primary || secondary || more || actions) && (
          <div className="row page-actions">
            {actions}
            {secondary?.map((s, i) => (
              <span key={i} className="page-secondary">
                {s}
              </span>
            ))}
            {hasMore && (
              <span className={`page-more ${more ? '' : 'phone-only'}`}>
                <Menu label={<Icon name="more" size={16} />} title="More actions" className="btn sm ghost icon-only" floating>
                  {(close) => (
                    <>
                      {secondary?.map((s, i) => (
                        <div key={i} className="phone-only menu-slot" onClick={close}>
                          {s}
                        </div>
                      ))}
                      {more?.(close)}
                    </>
                  )}
                </Menu>
              </span>
            )}
            {primary}
          </div>
        )}
      </div>
      {tabs && <div className="page-tabs">{tabs}</div>}
      {toolbar && <div className="page-toolbar">{toolbar}</div>}
    </header>
  );
}

/** One line with a "?" disclosure when the text does not fit; the expanded state is remembered per page. */
function Description({ text, storeKey }: { text: ReactNode; storeKey?: string }) {
  const [open, setOpen] = useLocalState<boolean>(`stubyard.desc.${storeKey ?? 'page'}`, false);
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className={`page-desc ${open ? 'open' : ''}`}>
      <p ref={ref}>{text}</p>
      {(clipped || open) && (
        <button type="button" className="page-desc-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Show less' : 'Show the full description'}>
          {open ? 'Less' : '?'}
        </button>
      )}
    </div>
  );
}
