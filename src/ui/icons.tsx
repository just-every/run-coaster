// Outline icons on a 24 px grid, drawn like the pick's rail and panel icons.
const paths: Record<string, string> = {
  claims: 'M4 4h16v12H10l-5 4v-4H4zM8 9h8M8 12h5',
  approvals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  batches: 'M3 7h4c4.5 0 6.5 10 11 10h3M18 14l3 3-3 3M3 17h4c1.6 0 2.8-1.2 3.9-2.8M13.1 9.8C14.2 8.2 15.4 7 17 7h4M18 4l3 3-3 3',
  movein: 'M12 3v11M7.5 9.5 12 14l4.5-4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  document: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
  plus: 'M12 5v14M5 12h14',
  'plus-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8M12 8v8',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  check: 'M5 12l5 5 9-10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  back: 'M19 12H5M11 6l-6 6 6 6',
  cross: 'M6 6l12 12M18 6L6 18',
  car: 'M6.5 10.5l1.4-3.6A2 2 0 0 1 9.8 5.6h4.4a2 2 0 0 1 1.9 1.3l1.4 3.6M5 10.5h14a1.5 1.5 0 0 1 1.5 1.5v4.5h-17V12A1.5 1.5 0 0 1 5 10.5zM6 16.5v2M18 16.5v2M7 13.5h1.5M15.5 13.5H17',
  // The run site's docs cards, pager and menu draw these two from the same set.
  arrow: 'M5 12h14M13 6l6 6-6 6',
  lines: 'M6 7h12M6 11h12M6 15h12M6 19h8',
  tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  send: 'M21 3 3 10l7 3 3 7zM10 13l11-10',
  building: 'M4 21V5l8-2v18M12 7h8v14M4 21h17M7.5 8h1M7.5 12h1M7.5 16h1M15.5 11h1M15.5 15h1',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  bank: 'M3 9l9-5 9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14',
};
/** A line icon; decorative unless labelled. */
export function Icon({ name, label }: { name: keyof typeof paths | string; label?: string }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}><path d={paths[name] ?? ''} /></svg>;
}
