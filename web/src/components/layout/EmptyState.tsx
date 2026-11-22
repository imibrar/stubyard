import type { ReactNode } from 'react';
import { Icon, type IconName } from '../people';

/** Empty state: icon, one sentence, one primary action, optional secondary link. */
export function EmptyState({ icon, title, children, action, secondary, className = '' }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; secondary?: ReactNode; className?: string }) {
  return (
    <div className={`empty empty-state ${className}`}>
      {icon && (
        <span className="empty-icon" aria-hidden>
          <Icon name={icon} size={20} />
        </span>
      )}
      <h3>{title}</h3>
      {children && <div className="empty-text">{children}</div>}
      {(action || secondary) && (
        <div className="row empty-actions">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}
