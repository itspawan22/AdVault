// Node has Blob but no FileReader, which JSZip uses to read Blob inputs (browsers have both).
if (typeof (globalThis as any).FileReader === 'undefined') {
  (globalThis as any).FileReader = class {
    result: ArrayBuffer | null = null;
    onload: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (b) => { this.result = b; this.onload?.({ target: this }); },
        (e) => this.onerror?.(e),
      );
    }
  };
}
