import type { MailReceiptMessage } from './mail-content';
export function normalizeInbound(input: {provider:'cloudflare';message:{from:string;to:string;raw:ReadableStream;rawSize:number;headers:Headers}}, limits:Record<string,number>): Promise<MailReceiptMessage & {from:string;to:string[];subject:string;messageId:string|null}>;
