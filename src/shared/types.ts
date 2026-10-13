export type EditableProperty = 'width' | 'height' | 'fontSize' | 'color' | 'fontFamily' | 'margin' | 'borderRadius' | 'transform' | 'display' | 'maxWidth' | 'maxHeight' | 'flex' | 'position' | 'left' | 'top' | 'zIndex' | 'boxSizing' | 'overflow' | 'padding' | 'objectFit';

export interface CreatedElement {
  id: string;
  markup: string;
  parentSelector: string;
  afterSelector?: string;
}

export interface StyleRule {
  selector: string;
  fingerprint: string;
  properties: Partial<Record<EditableProperty, string>>;
  textContent?: string;
  imageSource?: string;
  imageFilename?: string;
  created?: CreatedElement;
  deleted?: boolean;
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
