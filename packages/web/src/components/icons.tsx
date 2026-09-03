import type { JSX, SVGProps } from 'react';

export type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>;

/**
 * Shared stroke-icon set — hand-rolled (no icon dependency), 24px grid,
 * round joins/caps to match the hairline, no-shadow aesthetic in styles.css.
 * Every icon is `aria-hidden`; the calling button supplies the accessible name
 * via `aria-label`/`title`.
 */
function icon(paths: JSX.Element, viewBox = '0 0 24 24') {
  return function Icon({ size = 16, ...rest }: IconProps): JSX.Element {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const IconX = icon(<path d="M18 6 6 18M6 6l12 12" />);

export const IconHelp = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.25a2.5 2.5 0 1 1 3.5 2.29c-.77.35-1 .9-1 1.71" />
    <path d="M12 17.25h.01" />
  </>,
);

export const IconArrowLeft = icon(<path d="M19 12H5M11 18l-6-6 6-6" />);

export const IconTrash = icon(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

export const IconArchive = icon(
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 13h4" />
  </>,
);

export const IconArchiveRestore = icon(
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M12 17v-5M9.5 14.5 12 12l2.5 2.5" />
  </>,
);

export const IconCopy = icon(
  <>
    <rect x="9" y="9" width="12" height="12" rx="1.5" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </>,
);

export const IconCheck = icon(<path d="M20 6 9 17l-5-5" />);

export const IconPencil = icon(
  <>
    <path d="M17 3a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    <path d="M15 5l4 4" />
  </>,
);

export const IconMessage = icon(<path d="M4 4h16v12H8l-4 4Z" />);

export const IconLink = icon(
  <>
    <path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
    <path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </>,
);

export const IconShare = icon(
  <>
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="M8.3 10.7l7.4-4.4M8.3 13.3l7.4 4.4" />
  </>,
);

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);

export const IconLogOut = icon(
  <>
    <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </>,
);

export const IconSettings = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </>,
);

export const IconList = icon(
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </>,
);

export const IconGitCompare = icon(
  <>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M6 15.5V9a3 3 0 0 1 3-3h3" />
    <path d="M18 8.5V15a3 3 0 0 1-3 3h-3" />
  </>,
);

export const IconRotateCcw = icon(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </>,
);

export const IconUpload = icon(
  <>
    <path d="M12 16V4M8 8l4-4 4 4" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </>,
);

export const IconThumbsUp = icon(
  <path d="M7 22V11M2 13v7a2 2 0 0 0 2 2h11.4a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 17 11h-4.6l.6-4.5a1.7 1.7 0 0 0-3-1.3L7 11" />,
);

export const IconVorlynDown = icon(<path d="m6 9 6 6 6-6" />);

/** Three dots, horizontal — the per-row "more actions" kebab trigger. */
export const IconMoreHorizontal = icon(
  <>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </>,
);

/** Curved back-arrow — reply to a message. */
export const IconReply = icon(<path d="M9 17 4 12l5-5M4 12h11a5 5 0 0 1 5 5v2" />);

/** Text column flanked by a bubble on each side — margin comments, both sides. */
export const IconMarginBubbles = icon(
  <>
    <path d="M10 6h4M10 12h4M10 18h4" />
    <rect x="1.5" y="3.5" width="6" height="5" rx="1.5" />
    <rect x="16.5" y="15.5" width="6" height="5" rx="1.5" />
  </>,
);

/** Bulleted list glyph — represents the flat comment list. */
export const IconListView = icon(
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </>,
);

export const IconSun = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);

export const IconMoon = icon(<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />);

export const IconMonitor = icon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </>,
);

/** Generic person mark — the identity-menu trigger when `Me` carries no
 *  displayable name/email (see AppHeader), so there's nothing to derive
 *  initials from. */
export const IconUser = icon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
  </>,
);

export const IconCreditCard = icon(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
  </>,
);

/** Mobile lane-nav drawer trigger (Phase 39.F) — the standard three-line
 *  "hamburger" mark, this set's only icon that needs to read as "open
 *  navigation" rather than name a specific action. */
export const IconMenu = icon(<path d="M4 7h16M4 12h16M4 17h16" />);
