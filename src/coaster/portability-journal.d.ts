// Base's restore fence (portability journal), used by ERASURE-001.
declare module '@runeditrun/rer/modules/portability/journal' {
  export function redactionStatements(db: D1Database): Promise<D1PreparedStatement[]>;
  export function invalidateTransfersStatements(db: D1Database): Promise<D1PreparedStatement[]>;
}
