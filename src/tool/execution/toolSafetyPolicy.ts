import {
  buildCoursewareEditRejection,
  buildCoursewareWriteRejection,
  isCoursewareAssetPath,
} from "../builtin/filesystem/coursewareSafety.js";
import { classifyBashPermission } from "../builtin/bash/permissions.js";

export function preflightToolSafetyPolicy(
  toolName: string,
  input: unknown,
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  if (toolName === "write_file") {
    const filePath = readString(input.file_path);
    const content = readString(input.content);
    if (!filePath || content === undefined) {
      return undefined;
    }
    return buildCoursewareWriteRejection({
      filePath,
      nextContent: content,
      previousContent: null,
    });
  }

  if (toolName === "edit_file") {
    const filePath = readString(input.file_path);
    const oldString = readString(input.old_string);
    const newString = readString(input.new_string);
    if (!filePath || newString === undefined) {
      return undefined;
    }

    const sizeRejection = buildCoursewareEditRejection({
      filePath,
      insertedContent: newString,
    });
    if (sizeRejection) {
      return sizeRejection;
    }

    if (isCoursewareAssetPath(filePath) && oldString && oldString.length > 4_000 && newString.length < oldString.length * 0.35) {
      return "Refusing to replace a large courseware asset section with much smaller content. Patch a narrow marker or section instead.";
    }
    return undefined;
  }

  if (toolName === "bash") {
    const command = readString(input.command);
    if (!command) {
      return undefined;
    }
    const decision = classifyBashPermission(command);
    return decision.type === "deny" ? decision.message : undefined;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
