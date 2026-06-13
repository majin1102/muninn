/// <reference types="vite/client" />

interface MuninnDesktopBootstrap {
  apiBase: string;
  apiToken?: string;
}

interface Window {
  __MUNINN_DESKTOP__?: MuninnDesktopBootstrap;
}
