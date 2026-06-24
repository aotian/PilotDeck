import path from "node:path";

export const COURSEWARE_MAX_CREATE_BYTES = 24_000;
export const COURSEWARE_MAX_EDIT_BYTES = 18_000;
export const COURSEWARE_MIN_OVERWRITE_RATIO = 0.35;

const COURSEWARE_HTML_NAMES = new Set([
  "deck.html",
  "courseware.html",
  "slides.html",
]);

const COURSEWARE_ASSET_NAMES = new Set([
  "courseware-package.json",
  "courseware-slides.json",
  "generator-handoff.json",
  "slides-manifest.json",
  "tiku-context.json",
  "pilot-tiku-input.json",
  "video-script.md",
  "teacher-script.md",
  "course-outline.md",
]);

export function isCoursewareAssetPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const base = path.basename(normalized);
  return COURSEWARE_HTML_NAMES.has(base)
    || COURSEWARE_ASSET_NAMES.has(base)
    || normalized.includes("/courseware/")
    || normalized.includes("/lessons/lesson-");
}

export function isCoursewareHtmlPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return COURSEWARE_HTML_NAMES.has(path.basename(normalized))
    || (normalized.includes("/lessons/lesson-") && normalized.endsWith(".html"));
}

export function buildCoursewareWriteRejection(args: {
  filePath: string;
  nextContent: string;
  previousContent?: string | null;
}): string | undefined {
  if (!isCoursewareHtmlPath(args.filePath)) {
    return undefined;
  }

  const nextBytes = Buffer.byteLength(args.nextContent, "utf8");
  const previousBytes = Buffer.byteLength(args.previousContent ?? "", "utf8");
  if (nextBytes > COURSEWARE_MAX_CREATE_BYTES) {
    return [
      `Courseware HTML writes are capped at ${COURSEWARE_MAX_CREATE_BYTES} bytes per write_file call.`,
      "Create a small shell first, then extend it with focused edit_file calls.",
    ].join(" ");
  }

  if (
    previousBytes > 4_000
    && nextBytes < previousBytes * COURSEWARE_MIN_OVERWRITE_RATIO
  ) {
    return [
      "Refusing to replace an existing courseware HTML file with a much smaller draft.",
      "Read the file and patch the specific missing section instead.",
    ].join(" ");
  }

  return undefined;
}

export function buildCoursewareEditRejection(args: {
  filePath: string;
  insertedContent: string;
}): string | undefined {
  if (!isCoursewareHtmlPath(args.filePath)) {
    return undefined;
  }

  const bytes = Buffer.byteLength(args.insertedContent, "utf8");
  if (bytes > COURSEWARE_MAX_EDIT_BYTES) {
    return [
      `Courseware HTML edits are capped at ${COURSEWARE_MAX_EDIT_BYTES} bytes per edit_file call.`,
      "Patch 1-3 slides or one component at a time.",
    ].join(" ");
  }

  return undefined;
}
