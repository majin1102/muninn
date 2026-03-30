declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}

type AbortSignalLike = {
  aborted: boolean;
};

declare const AbortSignal: {
  timeout(ms: number): AbortSignalLike;
};
