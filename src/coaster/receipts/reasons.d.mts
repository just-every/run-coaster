type Member = { email: string; name: string };
export function tokenSubjects(members: Member[]): Set<string>;
export function validDiscardReason(value: unknown, members: Member[]): boolean;
export function replaceDiscardIdentity(value: string, members: Member[], address: string, name: string, subject: string, label: string): string;
