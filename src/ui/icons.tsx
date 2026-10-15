const paths: Record<string, string> = {
  claims: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
  document: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
  approvals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  batches: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  movein: 'M4 11l8-7 8 7M6 9.5V20h4.5v-5.5h3V20H18V9.5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  check: 'M5 12l5 5 9-10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  back: 'M19 12H5M11 6l-6 6 6 6',
  cross: 'M6 6l12 12M18 6L6 18',
  car: 'M6.5 10.5l1.4-3.6A2 2 0 0 1 9.8 5.6h4.4a2 2 0 0 1 1.9 1.3l1.4 3.6M5 10.5h14a1.5 1.5 0 0 1 1.5 1.5v4.5h-17V12A1.5 1.5 0 0 1 5 10.5zM6 16.5v2M18 16.5v2M7 13.5h1.5M15.5 13.5H17',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  lines: 'M6 7h12M6 11h12M6 15h12M6 19h8',
  cutlery: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 8h3',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  upload: 'M12 15V4M7 9l5-5 5 5M5 15v4h14v-4',
  restore: 'M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9M12 21v-9M9 15l3-3 3 3',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
};
/** A line icon; decorative unless labelled. */
export function Icon({ name, label }: { name: keyof typeof paths | string; label?: string }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}><path d={paths[name] ?? ''} /></svg>;
}
