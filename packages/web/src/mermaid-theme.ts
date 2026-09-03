/**
 * Vorlyn-themed mermaid variables (design-system.md). Mermaid's `base` theme
 * is the only one whose every color is overridable, so we drive it from the
 * same tokens as styles.css rather than shipping mermaid's stock palette.
 */

/** Body font stack, mirrored from --font-body in styles.css. */
const FONT_BODY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

interface Tokens {
  chalk: string;
  chalkRaised: string;
  ink: string;
  inkSoft: string;
  lane: string;
  laneStrong: string;
  vorlyn: string;
  vorlynInk: string;
  vorlynWash: string;
  signal: string;
  resolved: string;
  danger: string;
}

const LIGHT: Tokens = {
  chalk: '#eceae3',
  chalkRaised: '#fbfaf7',
  ink: '#23211b',
  inkSoft: '#6b675d',
  lane: '#dcd9d0',
  laneStrong: '#c9c5b9',
  vorlyn: '#2456e6',
  vorlynInk: '#1a41b3',
  vorlynWash: '#dbe4fa',
  signal: '#a04d08',
  resolved: '#15803d',
  danger: '#b91c1c',
};

const DARK: Tokens = {
  chalk: '#171614',
  chalkRaised: '#201f1b',
  ink: '#ece9e2',
  inkSoft: '#9c988c',
  lane: '#2e2c27',
  laneStrong: '#403d36',
  vorlyn: '#6690ff',
  vorlynInk: '#a9c1ff',
  vorlynWash: '#263659',
  signal: '#e0a55c',
  resolved: '#4ade80',
  danger: '#f87171',
};

/** Mermaid `themeVariables` for the given mode, derived from Vorlyn tokens. */
export function mermaidThemeVariables(dark: boolean): Record<string, string> {
  const t = dark ? DARK : LIGHT;
  return {
    background: t.chalk,
    mainBkg: t.vorlynWash,
    primaryColor: t.vorlynWash,
    primaryTextColor: t.ink,
    primaryBorderColor: t.vorlyn,
    secondaryColor: t.chalkRaised,
    tertiaryColor: t.lane,
    lineColor: t.inkSoft,
    nodeBorder: t.vorlyn,
    clusterBkg: t.chalkRaised,
    clusterBorder: t.lane,
    titleColor: t.ink,
    edgeLabelBackground: t.chalk,
    textColor: t.ink,
    nodeTextColor: t.ink,
    fontFamily: FONT_BODY,
    // Categorical slots (pie, git, journey). Vorlyn accents before neutrals.
    pie1: t.vorlyn,
    pie2: t.signal,
    pie3: t.resolved,
    pie4: t.vorlynInk,
    pie5: t.danger,
    pie6: t.inkSoft,
  };
}
