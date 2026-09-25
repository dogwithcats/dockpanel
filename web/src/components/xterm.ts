import type { ITerminalOptions } from '@xterm/xterm';

export const XTERM_THEME: ITerminalOptions['theme'] = {
  background: '#0b0e13',
  foreground: '#d5dbe4',
  cursor: '#4c8dff',
  cursorAccent: '#0b0e13',
  selectionBackground: 'rgba(76,141,255,0.35)',
  black: '#1b2029',
  red: '#f25b58',
  green: '#34c77b',
  yellow: '#eaa53c',
  blue: '#4c8dff',
  magenta: '#b48cff',
  cyan: '#36c5d6',
  white: '#d5dbe4',
  brightBlack: '#5c6676',
  brightRed: '#ff7b78',
  brightGreen: '#5ee09b',
  brightYellow: '#ffc56b',
  brightBlue: '#7aabff',
  brightMagenta: '#cfb0ff',
  brightCyan: '#6fe0ec',
  brightWhite: '#ffffff',
  scrollbarSliderBackground: 'rgba(255,255,255,0.12)',
  scrollbarSliderHoverBackground: 'rgba(255,255,255,0.22)',
  scrollbarSliderActiveBackground: 'rgba(255,255,255,0.28)',
};

export const XTERM_BASE: ITerminalOptions = {
  fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  fontSize: 12.5,
  lineHeight: 1.35,
  theme: XTERM_THEME,
  allowProposedApi: true,
};

/** Fit only when the element is actually visible (hidden tabs report 0x0). */
export function safeFit(el: HTMLElement | null, fit: { fit: () => void }) {
  if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
  try {
    fit.fit();
  } catch {
    /* terminal disposed */
  }
}
