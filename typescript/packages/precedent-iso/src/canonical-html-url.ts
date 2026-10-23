import { Parser } from "htmlparser2";

// Inspect real head elements without building a DOM for a potentially long
// poem. Comments, script text and inert head contents cannot supply a canonical.
export function canonicalHtmlUrl(html: string): string | undefined {
  const links: (string | undefined)[] = [];
  let inHead = false;
  let inertDepth = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "template" || name === "noscript") {
        inertDepth += 1;
        return;
      }
      if (inertDepth > 0) return;
      if (name === "head") inHead = true;
      if (
        inHead &&
        name === "link" &&
        attributes["rel"]?.toLowerCase().split(/\s+/u).includes("canonical")
      )
        links.push(attributes["href"]);
    },
    onclosetag(name) {
      if (name === "template" || name === "noscript") {
        inertDepth = Math.max(0, inertDepth - 1);
        return;
      }
      if (inertDepth === 0 && name === "head") {
        inHead = false;
        parser.pause();
      }
    },
  });
  parser.end(html);
  return links.length === 1 ? links[0] : undefined;
}
