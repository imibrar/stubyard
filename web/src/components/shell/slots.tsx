import { createContext, useContext } from 'react';

/**
 * Where the page header's parts go in the Console shell: the title (crumbs, h1, meta) sits in the 40 px top bar,
 * and so do the page actions on wide screens. PageHeader portals into these elements when they exist.
 */
export interface ShellSlots {
  title: HTMLElement | null;
  actions: HTMLElement | null;
}

export const ShellSlotsContext = createContext<ShellSlots>({ title: null, actions: null });
export const useShellSlots = () => useContext(ShellSlotsContext);
