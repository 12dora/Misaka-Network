declare module 'pngjs' {
  export class PNG {
    static sync: {
      read(data: Uint8Array): { width: number; height: number; data: Uint8Array }
    }
  }
}
