// Home's storyboard filter (search + tags): pure helpers, unit-tested in test/storyboardFilter.test.ts. The filter is
// remembered per hub and project in chrome.storage.session (the reading / writing is in FilterBar.tsx).
import type { StoryboardBrief } from '@stubyard/client/storyboard-types';
import { filterStoryboards } from './state';

export interface StoryboardFilter {
  /** Free text: every word must be in the name, slug, description or tags (case-insensitive). */
  query: string;
  /** Selected tags: a storyboard must have all of them (exact tag match). */
  tags: string[];
}

type Filterable = Pick<StoryboardBrief, 'name' | 'slug' | 'tags' | 'description'>;

export const EMPTY_FILTER: StoryboardFilter = { query: '', tags: [] };

/** Home shows the search box and the tag row from this many storyboards (or whenever a filter is set). */
export const FILTER_THRESHOLD = 2;
/** Tag chips shown before "+N more" (selected tags are always shown). */
export const TAG_CHIP_LIMIT = 8;
/** Tags shown on a storyboard row before "+N". */
export const ROW_TAG_LIMIT = 3;

export const isFiltering = (f: StoryboardFilter): boolean => f.query.trim() !== '' || f.tags.length > 0;

/** The storyboards that pass the tag filter (all selected tags) and the search. Order is kept. */
export function applyFilter<S extends Filterable>(list: S[], f: StoryboardFilter): S[] {
  const tagged = f.tags.length ? list.filter((s) => f.tags.every((t) => s.tags.includes(t))) : list;
  return filterStoryboards(tagged, f.query);
}

export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
}

/** Adds a tag (a row's tag chip): no change when it is selected already. */
export const addTag = (tags: string[], tag: string): string[] => (tags.includes(tag) ? tags : [...tags, tag]);

export interface TagChip {
  tag: string;
  /** Storyboards shown now (search + selected tags) that have this tag: what selecting it would leave. */
  count: number;
  selected: boolean;
}

/**
 * The tag row: every tag of the list, most used first (by the whole list, so chips do not jump while filtering),
 * then by name. Tags no shown storyboard has are left out unless selected; a selected tag the list no longer has
 * (a remembered filter) stays, with 0, so it can be turned off.
 */
export function tagChips<S extends Filterable>(list: S[], shown: S[], selected: string[]): TagChip[] {
  const total = new Map<string, number>();
  for (const s of list) for (const t of new Set(s.tags)) total.set(t, (total.get(t) ?? 0) + 1);
  const now = new Map<string, number>();
  for (const s of shown) for (const t of new Set(s.tags)) now.set(t, (now.get(t) ?? 0) + 1);
  for (const t of selected) if (!total.has(t)) total.set(t, 0);
  return [...total]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
    .map(([tag]) => ({ tag, count: now.get(tag) ?? 0, selected: selected.includes(tag) }))
    .filter((c) => c.selected || c.count > 0);
}

/** The chips to show: the first `limit` plus any selected one further down; `hidden` counts the rest. */
export function visibleChips(chips: TagChip[], expanded: boolean, limit = TAG_CHIP_LIMIT): { shown: TagChip[]; hidden: number } {
  if (expanded || chips.length <= limit) return { shown: chips, hidden: 0 };
  const shown = chips.filter((c, i) => i < limit || c.selected);
  return { shown, hidden: chips.length - shown.length };
}

/** A row's tags: the first `max`, and the rest (for "+N" and its tooltip). */
export function rowTags(tags: string[], max = ROW_TAG_LIMIT): { shown: string[]; rest: string[] } {
  return { shown: tags.slice(0, max), rest: tags.slice(max) };
}

/** "3 of 12" while filtering, else "12". */
export const countLabel = (shown: number, total: number, filtering: boolean): string => (filtering ? `${shown} of ${total}` : String(total));

/** The chrome.storage.session key of a project's filter (per hub, so two hubs with the same slug stay apart). */
export const filterKey = (apiUrl: string, project: string): string => `storyboardFilter:${apiUrl.replace(/\/+$/, '')}|${project}`;

/** A stored filter, checked (anything else reads as no filter). */
export function parseFilter(raw: unknown): StoryboardFilter {
  if (!raw || typeof raw !== 'object') return EMPTY_FILTER;
  const r = raw as { query?: unknown; tags?: unknown };
  const query = typeof r.query === 'string' ? r.query.slice(0, 200) : '';
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string' && t !== ''))].slice(0, 20) : [];
  return { query, tags };
}

/** Whether a key press goes to a text field (then "/" types a slash instead of focusing the search). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true || el.closest('[contenteditable=""],[contenteditable="true"]') !== null;
}
