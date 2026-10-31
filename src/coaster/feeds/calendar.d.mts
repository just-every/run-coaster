import type { Feed } from './model';
import type { Data } from '../types';
export function feedDate(at: Date, zone: string): string;
export function expectedAt(day: string, time: string, zone: string): number;
export function deadline(f: Feed, date: string): number;
export function hasCalendar(f: Feed): boolean;
export function deliveryPeriod(f: Feed, headers: string[], rows: Data[], at: Date): string | null;
