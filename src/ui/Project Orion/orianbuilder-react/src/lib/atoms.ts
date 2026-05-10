import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

/* ── App-shell state ─────────────────────────── */
export const currentAppContextAtom = atom<string>('apps');

/* ── Engine state ────────────────────────────── */
export type Runtime = 'llamacpp' | 'tensorrt';
export const runtimeAtom = atomWithStorage<Runtime>('engine.runtime', 'llamacpp');
export const vramBudgetAtom = atomWithStorage<number>('engine.vramBudget', 512);
export const contextSizeAtom = atomWithStorage<number>('engine.contextSize', 8);
export const exactContextAtom = atomWithStorage<boolean>('engine.exactContext', true);
export const modelLoadedAtom = atom<string | null>(null);

/* ── Marketplace state ───────────────────────── */
export const marketSearchAtom = atom<string>('');
export const marketTagAtom = atom<string>('Qwen 3');

/* ── Media AI state ──────────────────────────── */
export type Modality = 'text' | 'image' | 'audio' | 'video';
export const modalityAtom = atom<Modality>('text');
export const mediaPromptAtom = atom<string>('');

/* ── Settings state ──────────────────────────── */
export type Theme = 'system' | 'dark' | 'light';
export const themeAtom = atomWithStorage<Theme>('settings.theme', 'dark');
export const languageAtom = atomWithStorage<string>('settings.language', 'en');
export const zoomAtom = atomWithStorage<number>('settings.zoom', 100);
export const autoUpdateAtom = atomWithStorage<boolean>('settings.autoUpdate', true);
export const releaseChannelAtom = atomWithStorage<'stable' | 'beta'>('settings.releaseChannel', 'stable');
export const settingsSectionAtom = atom<string>('general');

/* ── Library state ───────────────────────────── */
export type LibFilter = 'all' | 'themes' | 'prompts' | 'media';
export const libFilterAtom = atom<LibFilter>('all');
