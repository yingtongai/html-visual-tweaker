export type EditableProperty = 'width' | 'height' | 'fontSize' | 'color' | 'fontFamily' | 'margin' | 'borderRadius' | 'transform' | 'display' | 'maxWidth' | 'flex';

export interface StyleRule {
  selector: string;
  fingerprint: string;
  properties: Partial<Record<EditableProperty, string>>;
  textContent?: string;
  imageSource?: string;
}

export interface SavedVersion {
  id: string;
  createdAt: number;
  title: string;
  rules: StyleRule[];
  documentRevision?: string;
}

export interface PageHistory {
  url: string;
  versions: SavedVersion[];
  activeVersionId?: string | null;
  documentRevision?: string;
}

export const HISTORY_LIMIT = 5;

export function pageKey(url = location.href): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}
