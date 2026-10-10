import { docInfo } from "@/features/printing/catalog";
import type { DocId, PaperId, PrintSettings } from "@/features/printing/settings";
import type { RenderOpts } from "@/features/printing/templates/types";

/** Which template and paper a document is printed on: this print's choice, then the
 *  clinic's, then the template's own default — and always a paper the template draws. */
export function pick(doc: DocId, settings: PrintSettings, o: RenderOpts): { template: string; paper: PaperId } {
  const info = docInfo(doc)!;
  const wanted = o.template ?? settings.docs[doc]?.template;
  const t = info.templates.find((x) => x.id === wanted) ?? info.templates[0];
  const asked = o.paper ?? settings.docs[doc]?.paper;
  const paper = asked && t.papers.includes(asked) ? asked : t.paper;
  return { template: t.id, paper };
}
