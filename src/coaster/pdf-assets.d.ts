declare module '*/pdf-assets/noto-sans.json' { const value: string; export default value; }
declare module 'libheif-js' {
  type ImageData = { width: number; height: number; data: Uint8ClampedArray };
  type HeifImage = { get_width(): number; get_height(): number; is_primary(): boolean; display(image: ImageData, done: (image: ImageData | null) => void): void; free(): void };
  const heif: { heif_context_free(context: number): void; HeifDecoder: new () => { decoder: number | null; decode(bytes: Uint8Array): HeifImage[] } };
  export default heif;
}
