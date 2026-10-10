import type { DuplicateInfo } from "@/features/printing/blocks";
import type { PaperId } from "@/features/printing/settings";

/** What a template is asked to draw with, beyond the document itself. */
export interface RenderOpts {
  /** Overrides the clinic's chosen template for this one print. */
  template?: string;
  /** Overrides the clinic's chosen paper for this one print. */
  paper?: PaperId;
  /** Set when this paper has been printed before. */
  duplicate?: DuplicateInfo | null;
  /** A QR code as inline SVG, drawn by the engine before rendering. */
  qrSvg?: string;
}

export interface Built {
  /** The body markup. */
  html: string;
  /** The template's own styles, added to the shared page rules. */
  css: string;
  paper: PaperId;
  template: string;
  title: string;
}
