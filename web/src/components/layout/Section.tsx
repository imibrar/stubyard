import type { ReactNode } from 'react';

/** Card with a header (title, optional description and actions) and a body. Same markup as .card/.card-head. */
export function Section({ title, description, actions, children, pad = true, danger, className = '', id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; pad?: boolean; danger?: boolean; className?: string; id?: string }) {
  return (
    <section className={`card section ${danger ? 'section-danger' : ''} ${className}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && (
        <div className="card-head section-head">
          <div className="grow">
            {title && <h2 className="section-title-text">{title}</h2>}
            {description && <p className="section-desc muted small">{description}</p>}
          </div>
          {actions && <div className="row section-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={pad ? 'card-pad section-body' : 'section-body'}>{children}</div>}
    </section>
  );
}
