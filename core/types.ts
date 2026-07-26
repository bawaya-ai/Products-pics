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
  /** additional export formats (beyond the primary dataUrl) for the ZIP download */
  variants?: { format: string; dataUrl: string; bytes: number }[];
}

export interface LocalizedText { en: string; ar: string; he: string }

/** A discovered product video. URLs may be signed/expiring (Instagram) — the store
 *  downloads the bytes server-side at save time; the ZIP downloads them client-side. */
export interface ManifestVideo {
  id: string;
  url: string;                      // source URL
  poster?: string;
  width?: number; height?: number; durationS?: number; bytes?: number;
  contentType?: string;             // 'video/mp4' | 'video/webm'
  source: 'og' | 'tag' | 'json' | 'raw' | 'instagram';
  probe: 'ok' | 'partial' | 'failed'; // failed/partial candidates are KEPT (quality-first)
  keep: boolean;                    // review toggle; first kept = primary
}

export interface Manifest {
  sourceUrl: string;
  pageTitle: string;
  name: LocalizedText;
  description: LocalizedText;
  price: {
    amount: number | null; currency: string; confidence: 'high' | 'low' | 'none';
    original?: { amount: number; currency: string }; // the price as shown, before → ILS conversion
  };
  tags: string[];
  category: string;
  images: ProcessedImage[];
  /** discovered product videos (≤3, ranked best-first) */
  videos?: ManifestVideo[];
  /** @deprecated legacy single-video field — mirrors videos.find(v => v.keep); kept for old saved manifests */
  video?: { url: string; poster?: string };
  warnings: string[];
  createdAt: string;
}

// NDJSON progress events streamed to the UI
export type ProgressEvent =
  | { type: 'stage'; stage: string; detail?: string }
  | { type: 'image'; index: number; total: number; status: 'processing' | 'done' | 'failed'; detail?: string }
  | { type: 'warn'; message: string }
  /** MEASURED cost from an actual provider response (AI tokens are exact; bg providers per real call) */
  | { type: 'cost'; label: string; usd: number; detail?: string }
  | { type: 'result'; manifest: Manifest }
  | { type: 'error'; message: string };
