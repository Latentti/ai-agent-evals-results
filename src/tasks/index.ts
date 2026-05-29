import type { Task } from "./types.js";
import { toolUseTask } from "./toolUse.js";
import { extractionTask } from "./extraction.js";
import { reasoningTask } from "./reasoning.js";
import { classificationTask } from "./classification.js";

export const TASKS: readonly Task[] = [
  toolUseTask as Task,
  extractionTask as Task,
  reasoningTask as Task,
  classificationTask as Task,
];

export function taskById(id: string): Task | undefined {
  return TASKS.find((t) => t.id === id);
}
