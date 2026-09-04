import { describe, expect, it } from 'vitest';
import { mermaidThemeVariables } from './mermaid-theme.js';

const REQUIRED = [
  'primaryColor',
  'primaryTextColor',
  'primaryBorderColor',
  'lineColor',
  'secondaryColor',
  'tertiaryColor',
  'background',
  'mainBkg',
  'nodeBorder',
  'clusterBkg',
  'titleColor',
  'edgeLabelBackground',
  'fontFamily',
];

describe('mermaidThemeVariables', () => {
  it('includes every required themeVariables key', () => {
    const light = mermaidThemeVariables(false);
    for (const key of REQUIRED) expect(light[key]).toBeDefined();
  });

  it('returns different palettes for light and dark', () => {
    const light = mermaidThemeVariables(false);
    const dark = mermaidThemeVariables(true);
    expect(light.background).not.toBe(dark.background);
    expect(light.primaryColor).not.toBe(dark.primaryColor);
    expect(light.background).toBe('#eceae3');
    expect(dark.background).toBe('#171614');
  });

  it('drives edges and borders from mdloop tokens, not mermaid defaults', () => {
    const light = mermaidThemeVariables(false);
    expect(light.primaryBorderColor).toBe('#2456e6');
    expect(light.nodeBorder).toBe('#2456e6');
    expect(light.fontFamily).toContain('-apple-system');
  });

  it('exposes categorical pie slots with mdloop first', () => {
    const light = mermaidThemeVariables(false);
    expect(light.pie1).toBe('#2456e6');
    expect(light.pie2).toBe('#a04d08');
    expect(light.pie3).toBe('#15803d');
  });
});
