declare module 'child_process' {
  export const spawn: any;
  export type ChildProcessWithoutNullStreams = any;
}

declare module 'path' {
  const path: any;
  export default path;
}

declare module 'readline' {
  const readline: any;
  export default readline;
}

declare const __dirname: string;
declare const process: any;
declare const console: any;
