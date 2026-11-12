export declare const ROOT: string;
export declare const DEFAULT_PORT: 8790;
export interface LocalSecrets {
  v: 1;
  sealKey: string;
}
export declare function parsePort(raw: string | undefined): number | null;
export declare function planSecrets(existingText: string | undefined, random?: (n: number) => Buffer): { kind: 'create' | 'reuse'; secrets: LocalSecrets } | { kind: 'invalid' };
export declare function devVars(a: { secrets: LocalSecrets; port: number }): string;
export declare function wranglerArgs(a: { port: number; dir: string }): string[];
export declare function takeLock(file: string, port: number): { ok: true; release(): void } | { ok: false; pid: number | null; port: number | null };
export declare function portFree(port: number): Promise<boolean>;
