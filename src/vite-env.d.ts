/// <reference types="vite/client" />
declare module '*?url' {
  const url: string;
  export default url;
}

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>; }
