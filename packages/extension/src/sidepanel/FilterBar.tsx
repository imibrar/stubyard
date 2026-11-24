// Home's storyboard filter: the remembered filter (chrome.storage.session, per hub and project), the search box with
// its keys ("/" focuses it, Esc clears), and the tag row. The matching itself is in storyboardFilter.ts.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { EMPTY_FILTER, isTypingTarget, parseFilter, TAG_CHIP_LIMIT, visibleChips, type StoryboardFilter, type TagChip } from './storyboardFilter';

/** The part of chrome.storage.session the filter uses (a fake in tests). */
export interface FilterStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const sessionStore = (): FilterStore | null => (globalThis as { chrome?: { storage?: { session?: FilterStore } } }).chrome?.storage?.session ?? null;

/** The filter of one project, read when the key changes and written on every change (errors are ignored). */
export function useStoryboardFilter(key: string, store: FilterStore | null = sessionStore()) {
  const [state, setState] = useState<{ key: string; filter: StoryboardFilter; loaded: boolean }>({ key, filter: EMPTY_FILTER, loaded: false });
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let live = true;
    setState({ key, filter: EMPTY_FILTER, loaded: false });
    const s = storeRef.current;
    if (!s) {
      setState({ key, filter: EMPTY_FILTER, loaded: true });
      return;
    }
    s.get(key).then(
      (r) => live && setState((cur) => (cur.key === key && !cur.loaded ? { key, filter: parseFilter(r[key]), loaded: true } : cur)),
      () => live && setState((cur) => (cur.key === key ? { ...cur, loaded: true } : cur)),
    );
    return () => {
      live = false;
    };
  }, [key]);

  const update = useCallback(
    (fn: (f: StoryboardFilter) => StoryboardFilter) => {
      setState((cur) => {
        const filter = fn(cur.filter);
        void storeRef.current?.set({ [cur.key]: filter }).catch(() => {});
        return { ...cur, filter, loaded: true };
      });
    },
    [],
  );
  const filter = state.key === key ? state.filter : EMPTY_FILTER;
  return {
    filter,
    setQuery: (query: string) => update((f) => ({ ...f, query })),
    setTags: (fn: (tags: string[]) => string[]) => update((f) => ({ ...f, tags: fn(f.tags) })),
    clear: () => update(() => EMPTY_FILTER),
  };
}

/** "/" focuses the search box while no text field has focus. */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!ref.current || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      ref.current.focus();
      ref.current.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref]);
}

export function FilterBar(props: {
  filter: StoryboardFilter;
  chips: TagChip[];
  filtering: boolean;
  onQuery: (q: string) => void;
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  onClear: () => void;
}) {
  const { filter, chips, filtering } = props;
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const labelId = useId();
  useSlashFocus(input);
  const { shown, hidden } = visibleChips(chips, expanded);

  // Esc: clears the search text, then the selected tags, then leaves the box.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (filter.query) props.onQuery('');
    else if (filter.tags.length) props.onClearTags();
    else e.currentTarget.blur();
  };

  return (
    <div className="sb-filter" role="search">
      <div className="row">
        <input
          ref={input}
          className="search"
          type="search"
          aria-label="Search storyboards"
          aria-keyshortcuts="/"
          placeholder="Search storyboards ( / )"
          value={filter.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {filtering && (
          <button className="sb-clear" title="Clear the search and the selected tags" onClick={props.onClear}>
            Clear
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="sb-tags" role="group" aria-labelledby={labelId}>
          <span id={labelId} className="sb-tags-label" title="A storyboard must have every selected tag">
            Tags{filter.tags.length > 1 ? ' · all of' : ''}
          </span>
          {shown.map((c) => (
            <button
              key={c.tag}
              className={`pill sb-tag${c.selected ? ' on' : ''}`}
              aria-pressed={c.selected}
              aria-label={`${c.tag}, ${c.count} ${c.count === 1 ? 'storyboard' : 'storyboards'}`}
              title={c.selected ? `Remove the tag filter "${c.tag}"` : `Only storyboards tagged "${c.tag}"`}
              onClick={() => props.onToggleTag(c.tag)}
            >
              <span className="sb-tag-name">{c.tag}</span>
              <span className="sb-tag-n">{c.count}</span>
            </button>
          ))}
          {(hidden > 0 || (expanded && chips.length > TAG_CHIP_LIMIT)) && (
            <button className="link small sb-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Fewer tags' : `+${hidden} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
