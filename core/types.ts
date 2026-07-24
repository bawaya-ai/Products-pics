// ── Scraper Pro — universal manifest types (project-agnostic) ──────────────

export type MediaRole = 'main' | 'angle' | 'detail' | 'skip';

export interface ProcessedImage {
  id: string;
  sourceUrl: string;
  role: MediaRole;
  order: number;
  /** data URL (webp/png) of the PROCESSED image — transparent bg, unified size */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  /** which background-removal provider produced it ('none' = passthrough) */
  bgProvider: string;
  warnings: string[];
}

export interface LocalizedText { en: string; ar: string; he: string }

export interface Manifest {
  sourceUrl: string;
  pageTitle: string;
  name: LocalizedText;
  description: LocalizedText;
  price: { amount: number | null; currency: string; confidence: 'high' | 'low' | 'none' };
  tags: string[];
  category: string;
  images: ProcessedImage[];
  warnings: string[];
  createdAt: string;
}

// NDJSON progress events streamed to the UI
export type ProgressEvent =
  | { type: 'stage'; stage: string; detail?: string }
  | { type: 'image'; index: number; total: number; status: 'processing' | 'done' | 'failed'; detail?: string }
  | { type: 'warn'; message: string }
  | { type: 'result'; manifest: Manifest }
  | { type: 'error'; message: string };
